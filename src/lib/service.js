'use strict';
/**
 * Everything that reads or writes attendance. Routes stay thin; the rules live
 * in attendance.js and the SQL lives here.
 *
 * Day summaries are derived from punches on every read rather than cached in a
 * table. At this scale a month for the whole org is a few thousand rows, and
 * deriving avoids the classic payroll bug where a shift or override changes but
 * a stale cached summary keeps feeding the old numbers into reports.
 */
const { db, audit, getSetting, setSetting } = require('../db');
const { evaluateDay, summarise, resolveWorkDate } = require('./attendance');
const { isoStamp, dateRange, addDays, monthBounds, isoWeekday } = require('./dates');

// --- lookups ---------------------------------------------------------------

const employeeCols = `
  e.id, e.emp_code, e.name, e.email, e.role, e.department_id, e.shift_id,
  e.manager_id, e.joined_on, e.active,
  d.name AS department_name,
  s.name AS shift_name`;

const EMP_JOIN = `
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN shifts      s ON s.id = e.shift_id`;

function getEmployee(id) {
  return db.prepare(`SELECT ${employeeCols} ${EMP_JOIN} WHERE e.id = ?`).get(id);
}

function getEmployeeByEmail(email) {
  return db.prepare(
    `SELECT e.*, d.name AS department_name, s.name AS shift_name ${EMP_JOIN}
     WHERE e.email = ? COLLATE NOCASE`,
  ).get(email);
}

function getEmployeeByCode(code) {
  return db.prepare(
    `SELECT e.*, d.name AS department_name, s.name AS shift_name ${EMP_JOIN}
     WHERE e.emp_code = ? COLLATE NOCASE`,
  ).get(code);
}

function listEmployees({ includeInactive = false, departmentId = null, managerId = null } = {}) {
  const where = [];
  const args = [];
  if (!includeInactive) where.push('e.active = 1');
  if (departmentId) { where.push('e.department_id = ?'); args.push(departmentId); }
  if (managerId) { where.push('e.manager_id = ?'); args.push(managerId); }
  const sql = `SELECT ${employeeCols} ${EMP_JOIN}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY e.active DESC, e.name`;
  return db.prepare(sql).all(...args);
}

const listDepartments = () => db.prepare(
  `SELECT d.*, (SELECT COUNT(*) FROM employees e
                WHERE e.department_id = d.id AND e.active = 1) AS headcount
   FROM departments d ORDER BY d.name`).all();

const listShifts = () => db.prepare(
  `SELECT s.*, (SELECT COUNT(*) FROM employees e
                WHERE e.shift_id = s.id AND e.active = 1) AS headcount
   FROM shifts s ORDER BY s.name`).all();

const getShift = (id) => db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);

const listHolidays = (from, to) => db.prepare(
  'SELECT * FROM holidays WHERE work_date BETWEEN ? AND ? ORDER BY work_date')
  .all(from, to);

/** Holidays in a range keyed by date, for O(1) lookup while evaluating. */
function holidayMap(from, to) {
  const m = new Map();
  for (const h of listHolidays(from, to)) m.set(h.work_date, h);
  return m;
}

// --- "now", for an organisation that works nights ---------------------------

/**
 * The shift most active employees are on - the organisation's prevailing
 * schedule. Used to decide which business date the org-wide screens default
 * to, since the register and dashboard cover everyone at once.
 */
function prevailingShift() {
  return db.prepare(`
    SELECT s.* FROM shifts s
    JOIN employees e ON e.shift_id = s.id AND e.active = 1
    GROUP BY s.id
    ORDER BY COUNT(*) DESC, s.id
    LIMIT 1`).get() || null;
}

/**
 * The business date currently in progress, org-wide.
 *
 * NOT the calendar date. On a 20:00-05:00 shift it is 01:00 that causes the
 * trouble: the calendar has rolled over but the night in progress still
 * belongs to yesterday, and every punch is filed there. Defaulting the
 * register to the calendar date would show an empty day to a room full of
 * people who are standing at their desks.
 */
function currentBusinessDate(stamp = null) {
  return resolveWorkDate(prevailingShift(), stamp || isoStamp());
}

/** The business date currently in progress for one employee's own shift. */
function employeeBusinessDate(employeeId, stamp = null) {
  const emp = db.prepare('SELECT shift_id FROM employees WHERE id = ?').get(employeeId);
  const shift = emp && emp.shift_id ? getShift(emp.shift_id) : null;
  return resolveWorkDate(shift, stamp || isoStamp());
}

// --- punching --------------------------------------------------------------

/** The employee's most recent punch on or around a business date. */
function lastPunch(employeeId, workDate) {
  return db.prepare(
    `SELECT * FROM punches
     WHERE employee_id = ? AND work_date = ?
     ORDER BY punched_at DESC, id DESC LIMIT 1`,
  ).get(employeeId, workDate);
}

/** What a check-in/out button should do next for this employee right now. */
function punchState(employeeId) {
  const emp = db.prepare('SELECT shift_id FROM employees WHERE id = ?').get(employeeId);
  const shift = emp && emp.shift_id ? getShift(emp.shift_id) : null;
  const stamp = isoStamp();
  const workDate = resolveWorkDate(shift, stamp);
  const last = lastPunch(employeeId, workDate);
  return {
    workDate,
    next: !last || last.kind === 'out' ? 'in' : 'out',
    last,
  };
}

/**
 * Record a punch.
 *
 * `expectKind` guards against a double submit: if the state already moved on
 * (two tabs, a double-tap on the kiosk), the second write is rejected rather
 * than silently creating a bogus session.
 */
function recordPunch({ employeeId, kind = null, source = 'web', note = null,
                       actorId = null, stamp = null, workDate = null }) {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw Object.assign(new Error('No such employee'), { status: 404 });
  if (!emp.active) {
    throw Object.assign(new Error('This employee is inactive and cannot punch'),
      { status: 400 });
  }

  const shift = emp.shift_id ? getShift(emp.shift_id) : null;
  const at = stamp || isoStamp();
  const wd = workDate || resolveWorkDate(shift, at);
  const last = lastPunch(employeeId, wd);
  const expected = !last || last.kind === 'out' ? 'in' : 'out';
  const k = kind || expected;

  if (k !== 'in' && k !== 'out') {
    throw Object.assign(new Error('Punch must be in or out'), { status: 400 });
  }
  // Only the self-service and kiosk flows are held to the alternating rule.
  // An admin correcting history, or an import of records from another system,
  // may legitimately insert either kind - a historical export can contain a
  // check-out whose matching check-in was never recorded, and refusing it
  // would silently drop real evidence. The rules engine flags such orphans.
  if (source !== 'admin' && source !== 'import' && k !== expected) {
    throw Object.assign(
      new Error(expected === 'in'
        ? 'You are already checked out.'
        : 'You are already checked in.'),
      { status: 409 },
    );
  }

  const info = db.prepare(
    `INSERT INTO punches (employee_id, punched_at, work_date, kind, source, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(employeeId, at, wd, k, source, note, actorId);

  if (source === 'admin') {
    audit(actorId, 'punch.insert', `employee:${employeeId}`,
      `${k} at ${at} on ${wd}${note ? ' - ' + note : ''}`);
  }
  return { id: info.lastInsertRowid, kind: k, punched_at: at, work_date: wd };
}

function deletePunch(punchId, actorId) {
  const row = db.prepare('SELECT * FROM punches WHERE id = ?').get(punchId);
  if (!row) throw Object.assign(new Error('No such punch'), { status: 404 });
  db.prepare('DELETE FROM punches WHERE id = ?').run(punchId);
  audit(actorId, 'punch.delete', `employee:${row.employee_id}`,
    `${row.kind} at ${row.punched_at} on ${row.work_date}`);
  return row;
}

function setOverride({ employeeId, workDate, status, note, actorId }) {
  if (!status) {
    db.prepare('DELETE FROM day_overrides WHERE employee_id = ? AND work_date = ?')
      .run(employeeId, workDate);
    audit(actorId, 'override.clear', `employee:${employeeId}`, workDate);
    return null;
  }
  db.prepare(
    `INSERT INTO day_overrides (employee_id, work_date, status, note, set_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, work_date) DO UPDATE SET
       status = excluded.status, note = excluded.note,
       set_by = excluded.set_by, set_at = datetime('now')`,
  ).run(employeeId, workDate, status, note || null, actorId);
  audit(actorId, 'override.set', `employee:${employeeId}`,
    `${workDate} -> ${status}${note ? ' - ' + note : ''}`);
  return { employeeId, workDate, status };
}

// --- derived views ---------------------------------------------------------

/** Evaluated days for one employee over an inclusive date range. */
function employeeDays(employeeId, from, to) {
  const emp = db.prepare(
    'SELECT id, shift_id, joined_on FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return null;

  const shift = emp.shift_id ? getShift(emp.shift_id) : null;

  const punches = db.prepare(
    `SELECT * FROM punches
     WHERE employee_id = ? AND work_date BETWEEN ? AND ?
     ORDER BY punched_at`).all(employeeId, from, to);

  const overrides = db.prepare(
    `SELECT * FROM day_overrides
     WHERE employee_id = ? AND work_date BETWEEN ? AND ?`).all(employeeId, from, to);

  const byDate = new Map();
  for (const p of punches) {
    if (!byDate.has(p.work_date)) byDate.set(p.work_date, []);
    byDate.get(p.work_date).push(p);
  }
  const ovr = new Map(overrides.map((o) => [o.work_date, o]));
  const hol = holidayMap(from, to);
  const nowStamp = isoStamp();
  // The night currently in progress for THIS employee's shift. Comparing the
  // calendar date instead would, at 00:06 on a 20:00-05:00 shift, treat a
  // colleague who is standing at their desk as a forgotten check-out.
  const liveDate = resolveWorkDate(shift, nowStamp);

  const days = dateRange(from, to).map((date) => evaluateDay({
    date,
    shift,
    punches: byDate.get(date) || [],
    override: ovr.get(date) || null,
    holiday: hol.get(date) || null,
    nowStamp: date === liveDate ? nowStamp : null,
    joinedOn: emp.joined_on,
  }));

  return { employee: getEmployee(employeeId), days, totals: summarise(days) };
}

/** One evaluated day for every employee - the daily register. */
function dayRegister(date, { includeInactive = false, departmentId = null } = {}) {
  const employees = listEmployees({ includeInactive, departmentId });
  const nowStamp = isoStamp();
  const hol = holidayMap(date, date);

  const punches = db.prepare(
    'SELECT * FROM punches WHERE work_date = ? ORDER BY punched_at').all(date);
  const overrides = db.prepare(
    'SELECT * FROM day_overrides WHERE work_date = ?').all(date);

  const byEmp = new Map();
  for (const p of punches) {
    if (!byEmp.has(p.employee_id)) byEmp.set(p.employee_id, []);
    byEmp.get(p.employee_id).push(p);
  }
  const ovr = new Map(overrides.map((o) => [o.employee_id, o]));
  const shifts = new Map(listShifts().map((s) => [s.id, s]));

  const rows = employees.map((e) => {
    const shift = e.shift_id ? shifts.get(e.shift_id) : null;
    // Resolved per employee: staff on different shifts are mid-shift at
    // different moments, and only the one whose night is actually running
    // should have its open check-in counted as time at work.
    const live = date === resolveWorkDate(shift, nowStamp) ? nowStamp : null;
    const day = evaluateDay({
      date,
      shift,
      punches: byEmp.get(e.id) || [],
      override: ovr.get(e.id) || null,
      holiday: hol.get(date) || null,
      nowStamp: live,
      joinedOn: e.joined_on,
    });
    return { employee: e, ...day };
  });

  return { date, rows, totals: summarise(rows) };
}

/** Monthly totals per employee - the payroll export shape. */
function monthlyReport(anyDateInMonth, { departmentId = null, includeInactive = false } = {}) {
  const { from, to } = monthBounds(anyDateInMonth);
  const employees = listEmployees({ includeInactive, departmentId });
  const rows = employees.map((e) => {
    const r = employeeDays(e.id, from, to);
    return { employee: e, totals: r.totals, days: r.days };
  });
  return { from, to, rows };
}

/**
 * The previous *working* business date before `date` for the prevailing shift.
 *
 * "vs yesterday" has to mean the last night people actually worked. On a
 * Mon-Fri night shift, Monday's comparison is the previous Friday, not Sunday,
 * which would otherwise always read as a collapse to zero.
 */
function previousWorkingDate(date, maxBack = 10) {
  const shift = prevailingShift();
  const offs = shift
    ? new Set(String(shift.weekly_off || '').split(',').map((n) => parseInt(n, 10)))
    : new Set();
  let d = date;
  for (let i = 0; i < maxBack; i++) {
    d = addDays(d, -1);
    const isHoliday = db.prepare('SELECT 1 FROM holidays WHERE work_date = ?').get(d);
    if (!offs.has(isoWeekday(d)) && !isHoliday) return d;
  }
  return addDays(date, -1);
}

/**
 * Counts for the nav badges. Kept cheap: this runs on every page render.
 */
function navCounts() {
  const today = currentBusinessDate();
  const reg = dayRegister(today);
  const { from, to } = monthBounds(today);

  // Only days that have finished can be exceptions.
  let exceptions = 0;
  for (const e of listEmployees()) {
    const r = employeeDays(e.id, from, to);
    for (const d of r.days) {
      if (d.date >= today) continue;
      if (d.problems.length || (d.status === 'absent' && !d.isOff)) exceptions += 1;
    }
  }
  return {
    headcount: reg.rows.length,
    onPremise: reg.rows.filter((r) => r.stillIn).length,
    exceptions,
  };
}

/**
 * Today's figures alongside the previous working night, for the summary cards.
 */
function dashboard(date = null) {
  const day = date || currentBusinessDate();
  const prev = previousWorkingDate(day);
  const now = dayRegister(day);
  const before = dayRegister(prev);

  const shape = (reg) => ({
    onTime: reg.rows.filter((r) => r.countsPresent && !r.lateMinutes).length,
    late: reg.totals.late,
    absent: reg.totals.absent,
    leave: reg.totals.leave,
    weeklyOff: reg.totals.weeklyOff,
    noCheckout: reg.rows.filter((r) => r.problems.some((p) => /never closed/.test(p))).length,
    earlyExit: reg.rows.filter((r) => r.earlyMinutes > 0).length,
    overtimeMinutes: reg.totals.overtimeMinutes,
    workedMinutes: reg.totals.workedMinutes,
  });

  return {
    date: day,
    prevDate: prev,
    now: shape(now),
    prev: shape(before),
    onPremise: now.rows.filter((r) => r.stillIn).length,
    headcount: now.rows.length,
    rows: now.rows,
    problems: now.rows.filter((r) => r.problems.length),
  };
}

// --- employee self-entry of past timings ------------------------------------

/**
 * Settings for the backfill window.
 *
 * Self-entry is a TIME-LIMITED amnesty, not a standing permission. An
 * attendance record the subject can rewrite indefinitely stops being evidence,
 * so the window has an explicit start, an explicit on/off switch, and is meant
 * to be closed once the history is filled in.
 */
function selfEntryWindow() {
  return {
    enabled: getSetting('self_entry_enabled', '0') === '1',
    from: getSetting('self_entry_from', '') || null,
    to: currentBusinessDate(),
  };
}

function setSelfEntryWindow({ enabled, from }, actorId) {
  setSetting('self_entry_enabled', enabled ? '1' : '0');
  if (from) setSetting('self_entry_from', from);
  audit(actorId, 'settings.self_entry', null,
    `${enabled ? 'opened' : 'closed'}${from ? ' from ' + from : ''}`);
  return selfEntryWindow();
}

/** Why a given night may or may not be self-filled. Null means it may. */
function selfEntryBlocker(employeeId, workDate) {
  const w = selfEntryWindow();
  if (!w.enabled) return 'Manual entry is currently closed. Ask HR to reopen it.';
  if (!w.from) return 'No start date has been set for manual entry.';
  if (workDate < w.from) return `Manual entry only covers ${w.from} onwards.`;
  if (workDate > w.to) return 'That night has not happened yet.';

  const emp = db.prepare('SELECT joined_on FROM employees WHERE id = ?').get(employeeId);
  if (emp && workDate < emp.joined_on) return 'That is before your joining date.';

  // A night HR has already ruled on is not the employee's to overwrite.
  const ovr = db.prepare(
    'SELECT status FROM day_overrides WHERE employee_id = ? AND work_date = ?')
    .get(employeeId, workDate);
  if (ovr) return `HR has already marked that night as ${ovr.status}.`;
  return null;
}

/**
 * Record an employee's own times for a past night.
 *
 * Both punches are written with source 'self' so the register can show at a
 * glance which times were reported after the fact rather than captured live.
 */
function recordSelfEntry({ employeeId, workDate, inTime, outTime, note, actorId }) {
  const blocker = selfEntryBlocker(employeeId, workDate);
  if (blocker) throw Object.assign(new Error(blocker), { status: 403 });

  const already = db.prepare(
    'SELECT COUNT(*) AS n FROM punches WHERE employee_id = ? AND work_date = ?')
    .get(employeeId, workDate).n;
  if (already) {
    throw Object.assign(
      new Error('That night already has times recorded. Ask HR to correct it.'),
      { status: 409 });
  }
  if (!/^\d{2}:\d{2}$/.test(inTime || '')) {
    throw Object.assign(new Error('Enter the start time as HH:MM'), { status: 400 });
  }
  if (outTime && !/^\d{2}:\d{2}$/.test(outTime)) {
    throw Object.assign(new Error('Enter the end time as HH:MM'), { status: 400 });
  }

  const emp = db.prepare('SELECT shift_id FROM employees WHERE id = ?').get(employeeId);
  const shift = emp && emp.shift_id ? getShift(emp.shift_id) : null;

  // On an overnight shift the end time belongs to the following calendar day,
  // while both punches still file against the night that started.
  const overnight = shift && shift.end_time <= shift.start_time;
  const outDate = overnight && outTime && outTime < inTime
    ? addDays(workDate, 1)
    : workDate;

  const reason = (note || '').trim() || 'Added by the employee';
  const written = [];

  db.transaction(() => {
    written.push(recordPunch({
      employeeId, kind: 'in', source: 'self', note: reason, actorId,
      stamp: `${workDate} ${inTime}:00`, workDate,
    }));
    if (outTime) {
      written.push(recordPunch({
        employeeId, kind: 'out', source: 'self', note: reason, actorId,
        stamp: `${outDate} ${outTime}:00`, workDate,
      }));
    }
  })();

  audit(actorId, 'punch.self', `employee:${employeeId}`,
    `${workDate} ${inTime}${outTime ? ' - ' + outTime : ' (no end time)'} - ${reason}`);
  return written;
}

/** The nights an employee may still fill in, newest first. */
function selfEntryNights(employeeId) {
  const w = selfEntryWindow();
  if (!w.enabled || !w.from) return { window: w, nights: [] };

  const data = employeeDays(employeeId, w.from, w.to);
  if (!data) return { window: w, nights: [] };

  const nights = data.days
    .filter((d) => !['not_employed', 'upcoming', 'weekly_off', 'holiday'].includes(d.status))
    .filter((d) => d.date <= w.to)
    .filter((d) => !d.firstIn || !d.lastOut || d.problems.length)
    .reverse();

  return { window: w, nights, employee: data.employee };
}

/** Headline numbers for the admin dashboard. */
function todaySnapshot() {
  const today = currentBusinessDate();
  const reg = dayRegister(today);
  const onPremise = reg.rows.filter((r) => r.stillIn).length;
  return {
    date: today,
    headcount: reg.rows.length,
    present: reg.totals.present,
    late: reg.totals.late,
    absent: reg.totals.absent,
    leave: reg.totals.leave,
    onPremise,
    problems: reg.rows.filter((r) => r.problems.length),
    rows: reg.rows,
  };
}

/**
 * Apply a validated import plan in one transaction.
 *
 * All or nothing: a half-imported staff list is worse than none, because the
 * person fixing it cannot tell which rows landed. Departments named in the
 * file are created first, then employees, then manager links - managers have
 * to exist as rows before anyone can point at them.
 */
function applyImport(items, actorId, { setPassword, setPin }) {
  const insert = db.prepare(
    `INSERT INTO employees
       (emp_code, name, email, role, department_id, shift_id, joined_on, active)
     VALUES (@emp_code, @name, @email, @role, @department_id, @shift_id, @joined_on, 1)`);
  const newDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
  const findDept = db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE');
  const findCode = db.prepare('SELECT id FROM employees WHERE emp_code = ? COLLATE NOCASE');
  const setManager = db.prepare('UPDATE employees SET manager_id = ? WHERE id = ?');

  const run = db.transaction(() => {
    const created = [];

    for (const it of items) {
      let departmentId = it.departmentId;
      if (!departmentId && it.departmentName) {
        const found = findDept.get(it.departmentName);
        departmentId = found
          ? found.id
          : Number(newDept.run(it.departmentName).lastInsertRowid);
      }

      const info = insert.run({
        emp_code: it.emp_code,
        name: it.name,
        email: it.email,
        role: it.role,
        department_id: departmentId,
        shift_id: it.shiftId,
        joined_on: it.joined_on,
      });
      const id = Number(info.lastInsertRowid);

      if (it.password) setPassword(id, it.password);
      if (it.pin) setPin(id, it.pin);

      created.push({ ...it, id, departmentId });
    }

    for (const c of created) {
      if (!c.managerCode) continue;
      const mgr = findCode.get(c.managerCode);
      if (mgr) setManager.run(mgr.id, c.id);
    }

    audit(actorId, 'employee.import', null, `${created.length} employee(s) imported`);
    return created;
  });

  return run();
}

/** Codes and emails already taken, for validating an import against. */
function existingIdentifiers() {
  const rows = db.prepare('SELECT emp_code, email FROM employees').all();
  return {
    codes: new Set(rows.map((r) => r.emp_code)),
    emails: new Set(rows.filter((r) => r.email).map((r) => r.email.toLowerCase())),
  };
}

module.exports = {
  getEmployee, getEmployeeByEmail, getEmployeeByCode, listEmployees,
  listDepartments, listShifts, getShift, listHolidays,
  resolveWorkDate, punchState, recordPunch, deletePunch, setOverride,
  employeeDays, dayRegister, monthlyReport, todaySnapshot,
  applyImport, existingIdentifiers,
  prevailingShift, currentBusinessDate, employeeBusinessDate,
  previousWorkingDate, navCounts, dashboard,
  selfEntryWindow, setSelfEntryWindow, selfEntryBlocker,
  recordSelfEntry, selfEntryNights,
};
