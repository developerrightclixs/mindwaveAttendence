'use strict';
/**
 * One-off import of the historical attendance export (the old Android app's
 * Google Sheet, supplied as a PDF).
 *
 *   node scripts/import-sheet.js rows.json            dry run, prints the plan
 *   node scripts/import-sheet.js rows.json --commit   writes the punches
 *
 * Three rules, each confirmed with the client before writing anything:
 *
 *  1. The old app dated every row by CALENDAR day. On a 20:00-05:00 shift a
 *     05:02 check-out therefore landed on the following day as its own row.
 *     Any time in the early-morning window is re-filed as the check-OUT of
 *     the previous night.
 *  2. A "check-out" within 2 minutes of the check-in is a double tap on the
 *     old app, not a shift end. The second punch is discarded, which leaves
 *     the night showing a missing check-out - honest, and fixable in the
 *     register.
 *  3. Everything else in the evening window is a check-in for that date.
 */
const fs = require('node:fs');
const svc = require('../src/lib/service');
const { db, audit } = require('../src/db');
const { addDays } = require('../src/lib/dates');

const FILE = process.argv[2];
const COMMIT = process.argv.includes('--commit');

// Sheet employee id -> the code in this system.
const MAP = {
  NomanDev01: 'NH001',
  HusbanNasir02: 'HN001',
  Tahaaslam03: 'TA001',
  UzairAli05: 'UA001',
  Hayyan06: 'MH001',
  Fahad07: 'MF001',
  MW001: 'SE001',
  Ahmed08: 'MA001',
};

// Anything at or before this is the tail of the previous night (the shift
// ends at 05:00; the register's own cut-over is 12:30).
const MORNING_END = 12 * 60 + 30;
const DOUBLE_TAP_MINUTES = 2;

const toMinutes = (t) => {
  const s = String(t).padStart(6, '0');
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
};
const toStamp = (date, t) => {
  const s = String(t).padStart(6, '0');
  return `${date} ${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
};
const isoOf = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byCode = new Map(
  db.prepare('SELECT id, emp_code, name FROM employees').all()
    .map((e) => [e.emp_code, e]));

const planned = [];
const skipped = [];

for (const r of rows) {
  const code = MAP[r.emp_id];
  const emp = code && byCode.get(code);
  if (!emp) {
    skipped.push({ ...r, why: `no employee mapped for "${r.emp_id}"` });
    continue;
  }

  const date = isoOf(r.date);
  const times = (r.times || []).slice();
  if (!times.length) {
    skipped.push({ ...r, why: 'no times on the row' });
    continue;
  }

  // Rule 2: drop a second punch that lands within the double-tap window.
  if (times.length === 2
      && Math.abs(toMinutes(times[1]) - toMinutes(times[0])) <= DOUBLE_TAP_MINUTES) {
    times.length = 1;
  }

  for (const t of times) {
    const mins = toMinutes(t);
    if (mins <= MORNING_END) {
      // Rule 1: the tail of the previous night, recorded as its check-out.
      const workDate = addDays(date, -1);
      planned.push({
        employeeId: emp.id, name: emp.name, kind: 'out',
        stamp: toStamp(date, t), workDate,
        note: `Imported from the old attendance sheet (row dated ${date})`,
      });
    } else {
      // Rule 3: an evening punch opens that night.
      planned.push({
        employeeId: emp.id, name: emp.name, kind: 'in',
        stamp: toStamp(date, t), workDate: date,
        note: 'Imported from the old attendance sheet',
      });
    }
  }
}

planned.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));

console.log(`Rows read: ${rows.length}`);
console.log(`Punches planned: ${planned.length}   (${planned.filter((p) => p.kind === 'in').length} in, ${planned.filter((p) => p.kind === 'out').length} out)`);
console.log(`Rows skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  skipped ${s.date} ${s.emp_id}: ${s.why}`);

console.log('\nPlanned punches:');
for (const p of planned) {
  console.log(`  ${p.workDate}  ${p.name.padEnd(17)} ${p.kind.toUpperCase().padEnd(3)} ${p.stamp.slice(11, 16)}`
    + (p.workDate !== p.stamp.slice(0, 10) ? `   (recorded ${p.stamp.slice(0, 10)}, filed to the night before)` : ''));
}

if (!COMMIT) {
  console.log('\nDRY RUN - nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

// Refuse only on a real collision - an employee-night that already holds
// punches. A blanket "the table must be empty" check would also reject a live
// system where somebody has legitimately clocked in today.
const clash = db.prepare(
  'SELECT COUNT(*) AS n FROM punches WHERE employee_id = ? AND work_date = ?');
const collisions = [...new Set(
  planned.filter((p) => clash.get(p.employeeId, p.workDate).n > 0)
    .map((p) => `${p.workDate}  ${p.name}`),
)];
if (collisions.length) {
  console.error('\nREFUSED: these employee-nights already hold punches, and');
  console.error('importing would duplicate them:');
  for (const c of collisions) console.error(`  ${c}`);
  process.exit(1);
}

const run = db.transaction(() => {
  for (const p of planned) {
    svc.recordPunch({
      employeeId: p.employeeId,
      kind: p.kind,
      source: 'import',
      note: p.note,
      actorId: null,
      stamp: p.stamp,
      workDate: p.workDate,
    });
  }
  audit(null, 'attendance.import', null,
    `${planned.length} punches imported from the old attendance sheet`);
});
run();

console.log(`\nImported ${planned.length} punches.`);
