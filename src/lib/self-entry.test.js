'use strict';
/**
 * Employee self-entry rules, against an in-memory PostgreSQL.
 *
 * These guard a deliberately risky feature: the subject of an attendance
 * record writing that record. The limits are what keep it defensible, so they
 * are tested against a real SQL engine rather than a stub.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { newDb } = require('pg-mem');

// Stand pg-mem in for `pg` before src/db.js is loaded, so the app connects to
// it without knowing anything has changed.
const mem = newDb({ autoCreateForeignKeyIndices: true });
require.cache[require.resolve('pg')] = {
  id: 'pg', filename: 'pg', loaded: true, exports: mem.adapters.createPg(),
};
process.env.DATABASE_URL = 'postgres://memory/test?sslmode=disable';

const { init, run, one, nowStamp } = require('../db');
const svc = require('./service');

let empId;
let shiftId;

test.before(async () => {
  await init();
  const s = await run(
    `INSERT INTO shifts (name, start_time, end_time, grace_minutes, break_minutes,
       break_after_minutes, half_day_minutes, min_present_minutes,
       overtime_after_minutes, overtime_grace_minutes, weekly_off, created_at)
     VALUES ('Night','20:00','05:00',10,0,0,270,60,540,15,'6,7',?)
     RETURNING id`, nowStamp());
  shiftId = s.rows[0].id;

  const e = await run(
    `INSERT INTO employees (emp_code, name, role, shift_id, joined_on, active, created_at)
     VALUES ('T001','Test Person','employee',?,'2026-10-01',1,?)
     RETURNING id`, shiftId, nowStamp());
  empId = e.rows[0].id;
});

const open = (from = '2026-10-01') =>
  svc.setSelfEntryWindow({ enabled: true, from }, empId);
const close = () => svc.setSelfEntryWindow({ enabled: false }, empId);
const clear = () => run('DELETE FROM punches WHERE employee_id = ?', empId);
const punchCount = async () =>
  Number((await one('SELECT COUNT(*) AS n FROM punches WHERE employee_id = ?', empId)).n);

// --- the window ------------------------------------------------------------

test('self-entry is closed until it is explicitly opened', async () => {
  await close();
  assert.match(await svc.selfEntryBlocker(empId, '2026-10-06'), /closed/i);
});

test('opening the window allows a night inside it', async () => {
  await open();
  assert.equal(await svc.selfEntryBlocker(empId, '2026-10-06'), null);
});

test('nights before the window start are refused', async () => {
  await open('2026-10-05');
  assert.match(await svc.selfEntryBlocker(empId, '2026-10-02'), /only covers/);
});

test('a future night cannot be filled in', async () => {
  await open();
  assert.match(await svc.selfEntryBlocker(empId, '2099-01-01'), /has not happened/);
});

test('nights before the joining date are refused', async () => {
  await open('2026-09-01');
  assert.match(await svc.selfEntryBlocker(empId, '2026-09-15'), /joining date/);
});

// --- recording -------------------------------------------------------------

test('a full night is recorded as two punches on one business date', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06',
    inTime: '20:00', outTime: '05:00', note: 'forgot to tap out', actorId: empId,
  });
  const rows = await require('../db').all(
    'SELECT * FROM punches WHERE employee_id = ? ORDER BY punched_at', empId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'in');
  assert.equal(rows[1].kind, 'out');
  // Both belong to the night that started, even though the end is next day.
  assert.equal(rows[0].work_date, '2026-10-06');
  assert.equal(rows[1].work_date, '2026-10-06');
  assert.equal(rows[1].punched_at.slice(0, 10), '2026-10-07');
});

test('self-entered punches are marked as such, not passed off as live', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const rows = await require('../db').all(
    'SELECT source FROM punches WHERE employee_id = ?', empId);
  assert.ok(rows.every((r) => r.source === 'self'));
});

test('the night then evaluates as a normal worked shift', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const d = (await svc.employeeDays(empId, '2026-10-06', '2026-10-06')).days[0];
  assert.equal(d.status, 'present');
  assert.equal(d.workedMinutes, 540);
  assert.deepEqual(d.problems, []);
});

test('the end time may be left out when it is genuinely not known', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '',
    actorId: empId,
  });
  const rows = await require('../db').all(
    'SELECT kind FROM punches WHERE employee_id = ?', empId);
  assert.deepEqual(rows.map((r) => r.kind), ['in']);
});

// --- the limits that matter ------------------------------------------------

test('a night that already has times cannot be overwritten', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  await assert.rejects(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '21:00', outTime: '04:00',
    actorId: empId,
  }), /already has times/);
});

test('a night HR has ruled on is not the employee to overwrite', async () => {
  await clear(); await open();
  await svc.setOverride({
    employeeId: empId, workDate: '2026-10-07', status: 'absent',
    note: 'no show', actorId: empId,
  });
  assert.match(await svc.selfEntryBlocker(empId, '2026-10-07'), /HR has already/);
  await assert.rejects(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-07', inTime: '20:00', actorId: empId,
  }), /HR has already/);
  await run('DELETE FROM day_overrides WHERE employee_id = ?', empId);
});

test('recording is refused outright while the window is closed', async () => {
  await clear(); await close();
  await assert.rejects(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', actorId: empId,
  }), /closed/i);
  assert.equal(await punchCount(), 0);
});

test('a malformed time is rejected and writes nothing', async () => {
  await clear(); await open();
  await assert.rejects(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '8pm', actorId: empId,
  }), /HH:MM/);
  assert.equal(await punchCount(), 0);
});

test('every self-entry lands in the audit trail under the employee', async () => {
  await clear(); await open();
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-08', inTime: '20:05', outTime: '05:05',
    note: 'phone was dead', actorId: empId,
  });
  const row = await one(
    "SELECT * FROM audit_log WHERE action = 'punch.self' ORDER BY id DESC LIMIT 1");
  assert.equal(row.actor_id, empId);
  assert.equal(row.actor_name, 'Test Person');
  assert.match(row.detail, /phone was dead/);
});

// --- the worklist ----------------------------------------------------------

test('the list offers only nights that still need completing', async () => {
  await clear(); await open('2026-10-05');
  await svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const { nights } = await svc.selfEntryNights(empId);
  const dates = nights.map((n) => n.date);
  assert.ok(!dates.includes('2026-10-06'), 'a completed night should drop off the list');
  assert.ok(!dates.some((d) => [0, 6].includes(new Date(`${d}T00:00:00`).getDay())),
    'weekly offs should not be offered');
});

test('the list is empty while the window is closed', async () => {
  await close();
  assert.deepEqual((await svc.selfEntryNights(empId)).nights, []);
});

// --- the transaction boundary ----------------------------------------------

test('a failure partway through writes neither punch', async () => {
  await clear(); await open();
  // An end time earlier than the start on a DAY shift makes the second punch
  // precede the first; the pair must not be left half-written either way.
  await run('UPDATE employees SET shift_id = NULL WHERE id = ?', empId);
  await assert.rejects(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: 'xx:yy',
    actorId: empId,
  }), /HH:MM/);
  assert.equal(await punchCount(), 0);
  await run('UPDATE employees SET shift_id = ? WHERE id = ?', shiftId, empId);
});

test.after(async () => {
  await require('../db').pool.end().catch(() => {});
});

// --- leave entitlement -----------------------------------------------------

const clearLeave = () => run('DELETE FROM day_overrides WHERE employee_id = ?', empId);

test('a fresh month starts with the full allowance', async () => {
  await clearLeave();
  const b = await svc.leaveBalance(empId, '2026-11-15');
  assert.equal(b.allowance.sick, 1);
  assert.equal(b.allowance.casual, 1);
  assert.equal(b.totalLeft, 2);
  assert.equal(b.totalUsed, 0);
});

test('one sick day leaves the casual day untouched', async () => {
  await clearLeave();
  await svc.setOverride({
    employeeId: empId, workDate: '2026-11-03', status: 'leave',
    leaveType: 'sick', note: 'flu', actorId: empId,
  });
  const b = await svc.leaveBalance(empId, '2026-11-15');
  assert.equal(b.used.sick, 1);
  assert.equal(b.left.sick, 0);
  assert.equal(b.left.casual, 1);
  assert.equal(b.totalLeft, 1);
});

test('using both leaves nothing remaining', async () => {
  await clearLeave();
  for (const [date, type] of [['2026-11-03', 'sick'], ['2026-11-04', 'casual']]) {
    await svc.setOverride({
      employeeId: empId, workDate: date, status: 'leave',
      leaveType: type, actorId: empId,
    });
  }
  const b = await svc.leaveBalance(empId, '2026-11-15');
  assert.equal(b.totalUsed, 2);
  assert.equal(b.totalLeft, 0);
  assert.equal(b.extra, 0);
});

test('a third leave day is reported as beyond the allowance, not hidden', async () => {
  await clearLeave();
  for (const [date, type] of [['2026-11-03', 'sick'], ['2026-11-04', 'casual'],
    ['2026-11-05', 'sick']]) {
    await svc.setOverride({
      employeeId: empId, workDate: date, status: 'leave',
      leaveType: type, actorId: empId,
    });
  }
  const b = await svc.leaveBalance(empId, '2026-11-15');
  assert.equal(b.used.sick, 2);
  assert.equal(b.totalLeft, 0);
  assert.equal(b.extra, 1);          // surfaced for payroll to decide on
});

test('leave with no type counts as beyond the allowance', async () => {
  await clearLeave();
  await svc.setOverride({
    employeeId: empId, workDate: '2026-11-06', status: 'leave', actorId: empId,
  });
  const b = await svc.leaveBalance(empId, '2026-11-15');
  assert.equal(b.used.untyped, 1);
  assert.equal(b.totalLeft, 2);      // the entitlement itself is untouched
  assert.equal(b.extra, 1);
});

test('the allowance does not carry across months', async () => {
  await clearLeave();
  await svc.setOverride({
    employeeId: empId, workDate: '2026-11-03', status: 'leave',
    leaveType: 'sick', actorId: empId,
  });
  assert.equal((await svc.leaveBalance(empId, '2026-11-15')).totalLeft, 1);
  // December is a fresh month and knows nothing of November.
  assert.equal((await svc.leaveBalance(empId, '2026-12-15')).totalLeft, 2);
});

test('a leave type is ignored on a day that is not leave', async () => {
  await clearLeave();
  await svc.setOverride({
    employeeId: empId, workDate: '2026-11-07', status: 'absent',
    leaveType: 'sick', actorId: empId,
  });
  const row = await one(
    'SELECT status, leave_type FROM day_overrides WHERE employee_id = ? AND work_date = ?',
    empId, '2026-11-07');
  assert.equal(row.status, 'absent');
  assert.equal(row.leave_type, null);
  assert.equal((await svc.leaveBalance(empId, '2026-11-15')).totalLeft, 2);
  await clearLeave();
});
