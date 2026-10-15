'use strict';
/**
 * Employee self-entry rules, against a throwaway database.
 *
 * These guard a deliberately risky feature: the subject of an attendance
 * record writing that record. The limits are what keep it defensible.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the app at a scratch database before anything requires db.js.
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-self-')), 'test.db');
process.env.DB_PATH = DB;

const { db } = require('../db');
const svc = require('./service');

// --- fixture ---------------------------------------------------------------
const shiftId = Number(db.prepare(`
  INSERT INTO shifts (name, start_time, end_time, grace_minutes, break_minutes,
    break_after_minutes, half_day_minutes, min_present_minutes,
    overtime_after_minutes, overtime_grace_minutes, weekly_off)
  VALUES ('Night', '20:00', '05:00', 10, 0, 0, 270, 60, 540, 15, '6,7')
`).run().lastInsertRowid);

const empId = Number(db.prepare(`
  INSERT INTO employees (emp_code, name, role, shift_id, joined_on, active)
  VALUES ('T001', 'Test Person', 'employee', ?, '2026-10-01', 1)
`).run(shiftId).lastInsertRowid);

const open = (from = '2026-10-01') =>
  svc.setSelfEntryWindow({ enabled: true, from }, empId);
const close = () => svc.setSelfEntryWindow({ enabled: false }, empId);
const clear = () => db.prepare('DELETE FROM punches WHERE employee_id = ?').run(empId);

// --- the window ------------------------------------------------------------

test('self-entry is closed until it is explicitly opened', () => {
  close();
  const why = svc.selfEntryBlocker(empId, '2026-10-06');
  assert.match(why, /closed/i);
});

test('opening the window allows a night inside it', () => {
  open();
  assert.equal(svc.selfEntryBlocker(empId, '2026-10-06'), null);
});

test('nights before the window start are refused', () => {
  open('2026-10-05');
  assert.match(svc.selfEntryBlocker(empId, '2026-10-02'), /only covers/);
});

test('a future night cannot be filled in', () => {
  open();
  assert.match(svc.selfEntryBlocker(empId, '2099-01-01'), /has not happened/);
});

test('nights before the joining date are refused', () => {
  open('2026-09-01');
  assert.match(svc.selfEntryBlocker(empId, '2026-09-15'), /joining date/);
});

// --- recording -------------------------------------------------------------

test('a full night is recorded as two punches on one business date', () => {
  clear(); open();
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06',
    inTime: '20:00', outTime: '05:00', note: 'forgot to tap out', actorId: empId,
  });
  const rows = db.prepare(
    'SELECT * FROM punches WHERE employee_id = ? ORDER BY punched_at').all(empId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'in');
  assert.equal(rows[1].kind, 'out');
  // Both belong to the night that started, even though the end is next day.
  assert.equal(rows[0].work_date, '2026-10-06');
  assert.equal(rows[1].work_date, '2026-10-06');
  assert.equal(rows[1].punched_at.slice(0, 10), '2026-10-07');
});

test('self-entered punches are marked as such, not passed off as live', () => {
  clear(); open();
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const rows = db.prepare('SELECT source FROM punches WHERE employee_id = ?').all(empId);
  assert.ok(rows.every((r) => r.source === 'self'));
});

test('the night then evaluates as a normal worked shift', () => {
  clear(); open();
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const d = svc.employeeDays(empId, '2026-10-06', '2026-10-06').days[0];
  assert.equal(d.status, 'present');
  assert.equal(d.workedMinutes, 540);
  assert.deepEqual(d.problems, []);
});

test('the end time may be left out when it is genuinely not known', () => {
  clear(); open();
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '',
    actorId: empId,
  });
  const rows = db.prepare('SELECT kind FROM punches WHERE employee_id = ?').all(empId);
  assert.deepEqual(rows.map((r) => r.kind), ['in']);
});

// --- the limits that matter ------------------------------------------------

test('a night that already has times cannot be overwritten', () => {
  clear(); open();
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  assert.throws(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '21:00', outTime: '04:00',
    actorId: empId,
  }), /already has times/);
});

test('a night HR has ruled on is not the employee to overwrite', () => {
  clear(); open();
  svc.setOverride({
    employeeId: empId, workDate: '2026-10-07', status: 'absent',
    note: 'no show', actorId: empId,
  });
  assert.match(svc.selfEntryBlocker(empId, '2026-10-07'), /HR has already/);
  assert.throws(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-07', inTime: '20:00', actorId: empId,
  }), /HR has already/);
  db.prepare('DELETE FROM day_overrides WHERE employee_id = ?').run(empId);
});

test('recording is refused outright while the window is closed', () => {
  clear(); close();
  assert.throws(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', actorId: empId,
  }), /closed/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 0);
});

test('a malformed time is rejected and writes nothing', () => {
  clear(); open();
  assert.throws(() => svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '8pm', actorId: empId,
  }), /HH:MM/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM punches').get().n, 0);
});

test('every self-entry lands in the audit trail under the employee', () => {
  clear(); open();
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='punch.self'").get().n;
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-08', inTime: '20:05', outTime: '05:05',
    note: 'phone was dead', actorId: empId,
  });
  const row = db.prepare(
    "SELECT * FROM audit_log WHERE action='punch.self' ORDER BY id DESC LIMIT 1").get();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='punch.self'").get().n,
    before + 1);
  assert.equal(row.actor_id, empId);
  assert.equal(row.actor_name, 'Test Person');
  assert.match(row.detail, /phone was dead/);
});

// --- the worklist ----------------------------------------------------------

test('the list offers only nights that still need completing', () => {
  clear(); open('2026-10-05');
  svc.recordSelfEntry({
    employeeId: empId, workDate: '2026-10-06', inTime: '20:00', outTime: '05:00',
    actorId: empId,
  });
  const { nights } = svc.selfEntryNights(empId);
  const dates = nights.map((n) => n.date);
  assert.ok(!dates.includes('2026-10-06'), 'a completed night should drop off the list');
  assert.ok(!dates.some((d) => [0, 6].includes(new Date(d + 'T00:00:00').getDay())),
    'weekly offs should not be offered');
});

test('the list is empty while the window is closed', () => {
  close();
  assert.deepEqual(svc.selfEntryNights(empId).nights, []);
});

test.after(() => {
  db.close();
  fs.rmSync(path.dirname(DB), { recursive: true, force: true });
});
