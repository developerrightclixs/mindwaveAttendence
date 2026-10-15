'use strict';
const express = require('express');
const { db, audit } = require('../db');
const {
  requireRole, setPassword, setPin, setKioskPassphrase, kioskPassphraseSet,
} = require('../auth');
const svc = require('../lib/service');
const { isoDate, prettyDate, addDays } = require('../lib/dates');
const importer = require('../lib/import');
const { STATUS_LABELS } = require('../lib/attendance');

const router = express.Router();

// Managers may read the register and reports for their team; everything that
// changes records or configuration is admin-only.
router.use(requireRole('manager'));
const adminOnly = requireRole();          // admin passes every requireRole check

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const asInt = (v, dflt = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.render('admin/dashboard', {
    title: 'Overview',
    d: svc.dashboard(),
    shift: svc.prevailingShift(),
  });
});

// ---------------------------------------------------------------------------
// Daily register
// ---------------------------------------------------------------------------
router.get('/register', (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : svc.currentBusinessDate();
  const departmentId = req.query.dept ? asInt(req.query.dept) : null;
  const reg = svc.dayRegister(date, { departmentId });

  // Filter the evaluated rows rather than the SQL: status is derived, not
  // stored, so it only exists after the rules engine has run.
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '');
  if (q || status) {
    reg.rows = reg.rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (!q) return true;
      return r.employee.name.toLowerCase().includes(q)
        || String(r.employee.emp_code).toLowerCase().includes(q);
    });
  }

  res.render('admin/register', {
    title: 'Daily register',
    reg,
    date,
    prettyDay: prettyDate(date),
    prev: addDays(date, -1),
    next: addDays(date, 1),
    departments: svc.listDepartments(),
    departmentId,
    statuses: STATUS_LABELS,
    isAdmin: req.user.role === 'admin',
  });
});

/** Mark a whole day for one employee (leave, absent, a pinned status). */
router.post('/register/override', adminOnly, (req, res) => {
  const { employee_id: employeeId, work_date: workDate, status, note } = req.body;
  if (!validDate(workDate)) throw Object.assign(new Error('Bad date'), { status: 400 });
  const allowed = ['present', 'late', 'half_day', 'absent', 'leave', 'holiday', 'weekly_off'];
  const clean = allowed.includes(status) ? status : null;

  svc.setOverride({
    employeeId: asInt(employeeId),
    workDate,
    status: clean,
    note,
    actorId: req.user.id,
  });
  res.flash('ok', clean ? `Day marked as ${STATUS_LABELS[clean]}.` : 'Override removed.');
  res.redirect(`/admin/register?date=${workDate}`);
});

/** Add a correcting punch by hand. */
router.post('/register/punch', adminOnly, (req, res) => {
  const employeeId = asInt(req.body.employee_id);
  const date = req.body.work_date;
  const time = String(req.body.time || '').trim();
  const kind = req.body.kind === 'out' ? 'out' : 'in';

  if (!validDate(date)) throw Object.assign(new Error('Bad date'), { status: 400 });
  if (!/^\d{2}:\d{2}$/.test(time)) {
    res.flash('err', 'Enter the time as HH:MM.');
    return res.redirect(`/admin/register?date=${date}`);
  }

  try {
    svc.recordPunch({
      employeeId,
      kind,
      source: 'admin',
      note: req.body.note || 'Added by ' + req.user.name,
      actorId: req.user.id,
      stamp: `${date} ${time}:00`,
      workDate: date,
    });
    res.flash('ok', `Recorded ${kind} at ${time}.`);
  } catch (e) {
    res.flash('err', e.message);
  }
  res.redirect(`/admin/register?date=${date}`);
});

router.post('/register/punch/:id/delete', adminOnly, (req, res) => {
  const row = svc.deletePunch(asInt(req.params.id), req.user.id);
  res.flash('ok', 'Punch deleted.');
  res.redirect(`/admin/register?date=${row.work_date}`);
});

/** Close out everyone still checked in from a past day. */
router.post('/register/close-open', adminOnly, (req, res) => {
  const date = req.body.work_date;
  if (!validDate(date)) throw Object.assign(new Error('Bad date'), { status: 400 });
  // A night still in progress has legitimately open check-ins.
  if (date >= svc.currentBusinessDate()) {
    res.flash('err', 'Only a past day can be closed out.');
    return res.redirect(`/admin/register?date=${date}`);
  }

  const reg = svc.dayRegister(date);
  const stuck = reg.rows.filter((r) => r.problems.some((p) => /never closed/.test(p)));
  let n = 0;
  for (const row of stuck) {
    const open = row.sessions.find((s) => s.open);
    if (!open) continue;
    const shift = row.employee.shift_id ? svc.getShift(row.employee.shift_id) : null;
    // Close at the scheduled end so the day is not credited beyond the shift.
    const endTime = shift ? shift.end_time : '18:00';
    const endDate = shift && shift.end_time <= shift.start_time ? addDays(date, 1) : date;
    svc.recordPunch({
      employeeId: row.employee.id,
      kind: 'out',
      source: 'admin',
      note: 'Auto-closed at shift end by ' + req.user.name,
      actorId: req.user.id,
      stamp: `${endDate} ${endTime}:00`,
      workDate: date,
    });
    n += 1;
  }
  res.flash('ok', n ? `Closed ${n} open check-in(s) at shift end.` : 'Nothing was left open.');
  res.redirect(`/admin/register?date=${date}`);
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
router.get('/employees', (req, res) => {
  res.render('admin/employees', {
    title: 'Employees',
    employees: svc.listEmployees({ includeInactive: true }),
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    isAdmin: req.user.role === 'admin',
  });
});

router.get('/employees/new', adminOnly, (req, res) => {
  res.render('admin/employee-form', {
    title: 'Add employee',
    emp: null,
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    managers: svc.listEmployees().filter((e) => e.role !== 'employee'),
    error: null,
  });
});

router.get('/employees/:id/edit', adminOnly, (req, res, next) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(asInt(req.params.id));
  if (!emp) return next();
  res.render('admin/employee-form', {
    title: `Edit ${emp.name}`,
    emp,
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    managers: svc.listEmployees().filter((e) => e.role !== 'employee' && e.id !== emp.id),
    error: null,
  });
});

function employeeFormValues(body) {
  return {
    emp_code: String(body.emp_code || '').trim(),
    name: String(body.name || '').trim(),
    email: String(body.email || '').trim() || null,
    role: ['admin', 'manager', 'employee'].includes(body.role) ? body.role : 'employee',
    department_id: body.department_id ? asInt(body.department_id) : null,
    shift_id: body.shift_id ? asInt(body.shift_id) : null,
    manager_id: body.manager_id ? asInt(body.manager_id) : null,
    joined_on: /^\d{4}-\d{2}-\d{2}$/.test(body.joined_on || '') ? body.joined_on : isoDate(),
    active: body.active ? 1 : 0,
  };
}

router.post('/employees', adminOnly, (req, res) => {
  const v = employeeFormValues(req.body);
  const rerender = (error) => res.status(400).render('admin/employee-form', {
    title: 'Add employee',
    emp: { ...v },
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    managers: svc.listEmployees().filter((e) => e.role !== 'employee'),
    error,
  });

  if (!v.emp_code || !v.name) return rerender('Employee code and name are required.');
  if (v.email && !req.body.password) {
    return rerender('An employee with a login email also needs a password.');
  }
  if (req.body.password && String(req.body.password).length < 8) {
    return rerender('The password must be at least 8 characters.');
  }

  try {
    const info = db.prepare(
      `INSERT INTO employees
         (emp_code, name, email, role, department_id, shift_id, manager_id, joined_on, active)
       VALUES (@emp_code, @name, @email, @role, @department_id, @shift_id,
               @manager_id, @joined_on, @active)`,
    ).run({ ...v, active: 1 });

    const id = Number(info.lastInsertRowid);
    if (req.body.password) setPassword(id, req.body.password);
    if (req.body.pin) setPin(id, req.body.pin);
    audit(req.user.id, 'employee.create', `employee:${id}`, `${v.emp_code} ${v.name}`);
    res.flash('ok', `${v.name} added.`);
    res.redirect('/admin/employees');
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      return rerender(/email/i.test(e.message)
        ? 'That email is already in use.'
        : 'That employee code is already in use.');
    }
    throw e;
  }
});

router.post('/employees/:id', adminOnly, (req, res) => {
  const id = asInt(req.params.id);
  const v = employeeFormValues(req.body);
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!existing) throw Object.assign(new Error('No such employee'), { status: 404 });

  const rerender = (error) => res.status(400).render('admin/employee-form', {
    title: `Edit ${existing.name}`,
    emp: { ...existing, ...v, id },
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    managers: svc.listEmployees().filter((e) => e.role !== 'employee' && e.id !== id),
    error,
  });

  if (!v.emp_code || !v.name) return rerender('Employee code and name are required.');
  // Removing the last admin would lock everyone out of configuration.
  if (existing.role === 'admin' && (v.role !== 'admin' || !v.active)) {
    const others = db.prepare(
      "SELECT COUNT(*) AS n FROM employees WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(id).n;
    if (others === 0) return rerender('This is the only admin account; keep it active and admin.');
  }

  try {
    db.prepare(
      `UPDATE employees SET
         emp_code = @emp_code, name = @name, email = @email, role = @role,
         department_id = @department_id, shift_id = @shift_id,
         manager_id = @manager_id, joined_on = @joined_on, active = @active
       WHERE id = @id`,
    ).run({ ...v, id });

    if (req.body.password) {
      if (String(req.body.password).length < 8) {
        return rerender('The password must be at least 8 characters.');
      }
      setPassword(id, req.body.password);
    }
    if (req.body.pin !== undefined && req.body.pin !== '') setPin(id, req.body.pin);
    if (req.body.clear_pin) setPin(id, '');

    audit(req.user.id, 'employee.update', `employee:${id}`, v.name);
    res.flash('ok', `${v.name} updated.`);
    res.redirect('/admin/employees');
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      return rerender(/email/i.test(e.message)
        ? 'That email is already in use.'
        : 'That employee code is already in use.');
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------
// Two steps on purpose: a paste is parsed into a preview the admin can read,
// and only a second submit writes anything. The parsed text is carried in a
// hidden field rather than the session, so two admins importing at once cannot
// commit each other's paste.

function buildPlan(text, defaultShiftId) {
  const ids = svc.existingIdentifiers();
  return importer.plan(text, {
    departments: svc.listDepartments(),
    shifts: svc.listShifts(),
    existingCodes: ids.codes,
    existingEmails: ids.emails,
    defaultShiftId: defaultShiftId || null,
  });
}

router.get('/import', adminOnly, (req, res) => {
  res.render('admin/import', {
    title: 'Import employees',
    shifts: svc.listShifts(),
    result: null,
    text: '',
    defaultShiftId: '',
    created: null,
  });
});

router.post('/import/preview', adminOnly, (req, res) => {
  const text = String(req.body.csv || '');
  const defaultShiftId = req.body.default_shift_id || '';
  res.render('admin/import', {
    title: 'Import employees',
    shifts: svc.listShifts(),
    result: buildPlan(text, defaultShiftId),
    text,
    defaultShiftId,
    created: null,
  });
});

router.post('/import/commit', adminOnly, (req, res) => {
  const text = String(req.body.csv || '');
  const defaultShiftId = req.body.default_shift_id || '';
  // Re-parse rather than trusting a plan round-tripped through the browser;
  // the database may also have changed since the preview was rendered.
  const result = buildPlan(text, defaultShiftId);

  if (!result.valid || !result.valid.length) {
    res.flash('err', 'Nothing valid to import.');
    return res.render('admin/import', {
      title: 'Import employees',
      shifts: svc.listShifts(),
      result,
      text,
      defaultShiftId,
      created: null,
    });
  }
  // A row that became invalid between preview and commit (someone else took
  // the code) must not be silently dropped.
  if (result.bad.length) {
    return res.render('admin/import', {
      title: 'Import employees',
      shifts: svc.listShifts(),
      result,
      text,
      defaultShiftId,
      created: null,
      lateFailure: 'Some rows are no longer valid. Review them and import again.',
    });
  }

  const created = svc.applyImport(result.valid, req.user.id, { setPassword, setPin });
  res.flash('ok', `${created.length} employee(s) imported.`);
  res.render('admin/import', {
    title: 'Import employees',
    shifts: svc.listShifts(),
    result: null,
    text: '',
    defaultShiftId: '',
    created,
  });
});

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------
router.get('/shifts', (req, res) => {
  res.render('admin/shifts', {
    title: 'Shifts',
    shifts: svc.listShifts(),
    isAdmin: req.user.role === 'admin',
  });
});

function shiftValues(body) {
  const offs = []
    .concat(body.weekly_off || [])
    .map((d) => asInt(d))
    .filter((d) => d >= 1 && d <= 7);
  return {
    name: String(body.name || '').trim(),
    start_time: String(body.start_time || '09:00').slice(0, 5),
    end_time: String(body.end_time || '18:00').slice(0, 5),
    grace_minutes: asInt(body.grace_minutes, 10),
    break_minutes: asInt(body.break_minutes, 60),
    break_after_minutes: asInt(body.break_after_minutes, 360),
    half_day_minutes: asInt(body.half_day_minutes, 240),
    min_present_minutes: asInt(body.min_present_minutes, 60),
    overtime_after_minutes: asInt(body.overtime_after_minutes, 480),
    overtime_grace_minutes: asInt(body.overtime_grace_minutes, 15),
    weekly_off: offs.join(','),
  };
}

router.post('/shifts', adminOnly, (req, res) => {
  const v = shiftValues(req.body);
  if (!v.name) {
    res.flash('err', 'A shift needs a name.');
    return res.redirect('/admin/shifts');
  }
  if (!/^\d{2}:\d{2}$/.test(v.start_time) || !/^\d{2}:\d{2}$/.test(v.end_time)) {
    res.flash('err', 'Shift times must be HH:MM.');
    return res.redirect('/admin/shifts');
  }
  try {
    if (req.body.id) {
      db.prepare(
        `UPDATE shifts SET name=@name, start_time=@start_time, end_time=@end_time,
           grace_minutes=@grace_minutes, break_minutes=@break_minutes,
           break_after_minutes=@break_after_minutes, half_day_minutes=@half_day_minutes,
           min_present_minutes=@min_present_minutes,
           overtime_after_minutes=@overtime_after_minutes,
           overtime_grace_minutes=@overtime_grace_minutes, weekly_off=@weekly_off
         WHERE id=@id`,
      ).run({ ...v, id: asInt(req.body.id) });
      audit(req.user.id, 'shift.update', `shift:${req.body.id}`, v.name);
      res.flash('ok', `Shift "${v.name}" updated. Past days are recalculated automatically.`);
    } else {
      db.prepare(
        `INSERT INTO shifts
           (name, start_time, end_time, grace_minutes, break_minutes, break_after_minutes,
            half_day_minutes, min_present_minutes, overtime_after_minutes,
            overtime_grace_minutes, weekly_off)
         VALUES (@name, @start_time, @end_time, @grace_minutes, @break_minutes,
                 @break_after_minutes, @half_day_minutes, @min_present_minutes,
                 @overtime_after_minutes, @overtime_grace_minutes, @weekly_off)`,
      ).run(v);
      audit(req.user.id, 'shift.create', null, v.name);
      res.flash('ok', `Shift "${v.name}" created.`);
    }
  } catch (e) {
    res.flash('err', /UNIQUE/.test(e.message) ? 'A shift with that name exists.' : e.message);
  }
  res.redirect('/admin/shifts');
});

router.post('/shifts/:id/delete', adminOnly, (req, res) => {
  const id = asInt(req.params.id);
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE shift_id = ?').get(id).n;
  if (inUse) {
    res.flash('err', `That shift is assigned to ${inUse} employee(s). Reassign them first.`);
  } else {
    db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    audit(req.user.id, 'shift.delete', `shift:${id}`, null);
    res.flash('ok', 'Shift deleted.');
  }
  res.redirect('/admin/shifts');
});

// ---------------------------------------------------------------------------
// Departments and holidays
// ---------------------------------------------------------------------------
router.get('/settings', (req, res) => {
  const year = asInt(req.query.year, new Date().getFullYear());
  res.render('admin/settings', {
    title: 'Setup',
    selfEntry: svc.selfEntryWindow(),
    kioskLocked: kioskPassphraseSet(),
    departments: svc.listDepartments(),
    holidays: svc.listHolidays(`${year}-01-01`, `${year}-12-31`),
    year,
    isAdmin: req.user.role === 'admin',
  });
});

router.post('/departments', adminOnly, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    res.flash('err', 'A department needs a name.');
  } else {
    try {
      db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
      audit(req.user.id, 'department.create', null, name);
      res.flash('ok', `Department "${name}" added.`);
    } catch (e) {
      res.flash('err', /UNIQUE/.test(e.message) ? 'That department exists.' : e.message);
    }
  }
  res.redirect('/admin/settings');
});

router.post('/departments/:id/delete', adminOnly, (req, res) => {
  const id = asInt(req.params.id);
  // Employees survive; they simply become unassigned (ON DELETE SET NULL).
  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  audit(req.user.id, 'department.delete', `department:${id}`, null);
  res.flash('ok', 'Department removed. Its employees are now unassigned.');
  res.redirect('/admin/settings');
});

router.post('/holidays', adminOnly, (req, res) => {
  const date = req.body.work_date;
  const name = String(req.body.name || '').trim();
  if (!validDate(date) || !name) {
    res.flash('err', 'A holiday needs a valid date and a name.');
  } else {
    db.prepare(
      `INSERT INTO holidays (work_date, name) VALUES (?, ?)
       ON CONFLICT(work_date) DO UPDATE SET name = excluded.name`).run(date, name);
    audit(req.user.id, 'holiday.set', date, name);
    res.flash('ok', `${name} marked as a holiday.`);
  }
  res.redirect(`/admin/settings?year=${String(date || '').slice(0, 4) || ''}`);
});

router.post('/holidays/:date/delete', adminOnly, (req, res) => {
  const date = req.params.date;
  if (validDate(date)) {
    db.prepare('DELETE FROM holidays WHERE work_date = ?').run(date);
    audit(req.user.id, 'holiday.delete', date, null);
    res.flash('ok', 'Holiday removed.');
  }
  res.redirect(`/admin/settings?year=${date.slice(0, 4)}`);
});

/** Open or close the employee self-entry window. */
router.post('/self-entry', adminOnly, (req, res) => {
  const from = validDate(req.body.from) ? req.body.from : null;
  const enabled = !!req.body.enabled;
  if (enabled && !from) {
    res.flash('err', 'Set a start date before opening manual entry.');
    return res.redirect('/admin/settings');
  }
  svc.setSelfEntryWindow({ enabled, from }, req.user.id);
  res.flash('ok', enabled
    ? `Manual entry open for nights from ${from} onwards.`
    : 'Manual entry closed.');
  res.redirect('/admin/settings');
});

/** Set or clear the kiosk device passphrase. */
router.post('/kiosk-lock', adminOnly, (req, res) => {
  try {
    const set = setKioskPassphrase(req.body.passphrase, req.user.id);
    res.flash('ok', set
      ? 'Kiosk passphrase set. Every kiosk device must be unlocked again.'
      : 'Kiosk passphrase removed. The kiosk is open to anyone who can reach it.');
  } catch (e) {
    res.flash('err', e.message);
  }
  res.redirect('/admin/settings');
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
router.get('/audit', adminOnly, (req, res) => {
  const rows = db.prepare(
    `SELECT a.id, a.action, a.target, a.detail, a.at,
            COALESCE(e.name, a.actor_name) AS actor_name,
            (e.id IS NULL AND a.actor_name IS NOT NULL) AS actor_gone
     FROM audit_log a LEFT JOIN employees e ON e.id = a.actor_id
     ORDER BY a.id DESC LIMIT 300`).all();
  res.render('admin/audit', { title: 'Audit trail', rows });
});

module.exports = router;
