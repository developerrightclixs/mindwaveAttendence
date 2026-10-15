'use strict';
/**
 * First-run setup.
 *
 *   npm run seed              shifts, departments and an admin account
 *   npm run seed -- --demo    the above plus sample staff and a month of punches
 *
 * Safe to re-run: it only ever inserts what is missing.
 */
const crypto = require('node:crypto');
const { db, audit } = require('./db');
const { setPassword, setPin } = require('./auth');
const { isoDate, addDays, isoWeekday } = require('./lib/dates');

const demo = process.argv.includes('--demo');

const SHIFTS = [
  {
    // The organisation's standard shift: nine hours overnight, fully paid,
    // Saturday and Sunday nights off.
    name: 'Night (20:00-05:00)',
    start_time: '20:00', end_time: '05:00',
    grace_minutes: 10, break_minutes: 0, break_after_minutes: 0,
    half_day_minutes: 270, min_present_minutes: 60,
    overtime_after_minutes: 540, overtime_grace_minutes: 15,
    weekly_off: '6,7',
  },
  {
    name: 'General (09:00-18:00)',
    start_time: '09:00', end_time: '18:00',
    grace_minutes: 10, break_minutes: 60, break_after_minutes: 360,
    half_day_minutes: 240, min_present_minutes: 60,
    overtime_after_minutes: 480, overtime_grace_minutes: 15,
    weekly_off: '6,7',
  },
  {
    name: 'Early (08:00-17:00)',
    start_time: '08:00', end_time: '17:00',
    grace_minutes: 10, break_minutes: 60, break_after_minutes: 360,
    half_day_minutes: 240, min_present_minutes: 60,
    overtime_after_minutes: 480, overtime_grace_minutes: 15,
    weekly_off: '6,7',
  },
  {
    name: 'Night (22:00-06:00)',
    start_time: '22:00', end_time: '06:00',
    grace_minutes: 15, break_minutes: 45, break_after_minutes: 300,
    half_day_minutes: 210, min_present_minutes: 60,
    overtime_after_minutes: 420, overtime_grace_minutes: 15,
    weekly_off: '7',
  },
];

const DEPARTMENTS = ['Engineering', 'Design', 'Sales', 'Operations', 'Finance'];

function seedShifts() {
  const insert = db.prepare(
    `INSERT INTO shifts
       (name, start_time, end_time, grace_minutes, break_minutes, break_after_minutes,
        half_day_minutes, min_present_minutes, overtime_after_minutes,
        overtime_grace_minutes, weekly_off)
     VALUES (@name, @start_time, @end_time, @grace_minutes, @break_minutes,
             @break_after_minutes, @half_day_minutes, @min_present_minutes,
             @overtime_after_minutes, @overtime_grace_minutes, @weekly_off)`);
  let n = 0;
  for (const s of SHIFTS) {
    const exists = db.prepare('SELECT 1 FROM shifts WHERE name = ?').get(s.name);
    if (!exists) { insert.run(s); n += 1; }
  }
  return n;
}

function seedDepartments() {
  const insert = db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)');
  let n = 0;
  for (const d of DEPARTMENTS) n += insert.run(d).changes;
  return n;
}

function seedAdmin() {
  const existing = db.prepare("SELECT * FROM employees WHERE role = 'admin'").get();
  if (existing) return { created: false, email: existing.email };

  // A random first password beats a hardcoded one; it is printed once here and
  // the admin is told to change it.
  const password = process.env.ADMIN_PASSWORD
    || crypto.randomBytes(6).toString('base64url');
  const email = process.env.ADMIN_EMAIL || 'admin@mindwave.local';
  const shift = db.prepare('SELECT id FROM shifts ORDER BY id LIMIT 1').get();

  const info = db.prepare(
    `INSERT INTO employees (emp_code, name, email, role, shift_id, joined_on, active)
     VALUES (?, ?, ?, 'admin', ?, ?, 1)`,
  ).run('ADMIN', 'System Administrator', email, shift ? shift.id : null, isoDate());

  const id = Number(info.lastInsertRowid);
  setPassword(id, password);
  audit(null, 'seed.admin', `employee:${id}`, email);
  return { created: true, email, password };
}

// --- demo data -------------------------------------------------------------

const DEMO_STAFF = [
  ['MW001', 'Ayesha Siddiqui', 'ayesha@mindwave.local', 'manager', 'Engineering', 0],
  ['MW002', 'Bilal Ahmed', 'bilal@mindwave.local', 'employee', 'Engineering', 0],
  ['MW003', 'Fatima Noor', 'fatima@mindwave.local', 'employee', 'Engineering', 0],
  ['MW004', 'Hassan Raza', 'hassan@mindwave.local', 'employee', 'Design', 1],
  ['MW005', 'Zainab Khalid', null, 'employee', 'Design', 1],
  ['MW006', 'Omar Farooq', 'omar@mindwave.local', 'manager', 'Sales', 0],
  ['MW007', 'Sana Tariq', null, 'employee', 'Sales', 0],
  ['MW008', 'Imran Shah', null, 'employee', 'Operations', 2],
  ['MW009', 'Hira Jamil', 'hira@mindwave.local', 'employee', 'Operations', 0],
  ['MW010', 'Usman Ali', null, 'employee', 'Finance', 0],
];

function seedDemoStaff() {
  const shifts = db.prepare('SELECT id, name FROM shifts ORDER BY id').all();
  const depts = new Map(db.prepare('SELECT id, name FROM departments').all()
    .map((d) => [d.name, d.id]));

  const insert = db.prepare(
    `INSERT INTO employees
       (emp_code, name, email, role, department_id, shift_id, joined_on, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);

  const created = [];
  for (const [code, name, email, role, dept, shiftIdx] of DEMO_STAFF) {
    if (db.prepare('SELECT 1 FROM employees WHERE emp_code = ?').get(code)) continue;
    const info = insert.run(code, name, email, role, depts.get(dept) || null,
      shifts[shiftIdx] ? shifts[shiftIdx].id : null, addDays(isoDate(), -400));
    const id = Number(info.lastInsertRowid);
    if (email) setPassword(id, 'password123');
    setPin(id, String(1000 + Number(code.slice(2))));   // MW001 -> 1001
    created.push({ id, name, code });
  }

  // Managers: engineering reports to Ayesha, sales to Omar.
  const mgr = (code) => {
    const r = db.prepare('SELECT id FROM employees WHERE emp_code = ?').get(code);
    return r ? r.id : null;
  };
  const eng = mgr('MW001');
  const sales = mgr('MW006');
  if (eng) {
    db.prepare(`UPDATE employees SET manager_id = ?
                WHERE emp_code IN ('MW002','MW003') AND manager_id IS NULL`).run(eng);
  }
  if (sales) {
    db.prepare(`UPDATE employees SET manager_id = ?
                WHERE emp_code = 'MW007' AND manager_id IS NULL`).run(sales);
  }
  return created;
}

/**
 * Generate 45 days of plausible punches: mostly on time, with a realistic
 * sprinkling of lateness, half days, absences, overtime and - importantly -
 * a few forgotten check-outs, so the exceptions screen has something to show.
 */
function seedDemoPunches() {
  const staff = db.prepare(
    `SELECT e.id, e.emp_code, e.shift_id, s.start_time, s.end_time, s.weekly_off
     FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id
     WHERE e.role != 'admin' AND e.active = 1`).all();
  if (!staff.length) return 0;

  const already = db.prepare('SELECT COUNT(*) AS n FROM punches').get().n;
  if (already > 0) return 0;

  // Deterministic pseudo-random so re-seeding a fresh DB gives the same demo.
  let seed = 20261015;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const insert = db.prepare(
    `INSERT INTO punches (employee_id, punched_at, work_date, kind, source)
     VALUES (?, ?, ?, ?, ?)`);

  const pad = (n) => String(n).padStart(2, '0');
  const stampAt = (date, mins) =>
    `${date} ${pad(Math.floor((mins % 1440) / 60))}:${pad(mins % 60)}:00`;

  let count = 0;
  const run = db.transaction(() => {
    for (let back = 45; back >= 0; back--) {
      const date = addDays(isoDate(), -back);
      const wd = isoWeekday(date);

      for (const e of staff) {
        const offs = String(e.weekly_off || '6,7').split(',').map(Number);
        if (offs.includes(wd)) continue;

        const r = rnd();
        if (r < 0.04) continue;                       // absent

        const [sh, sm] = (e.start_time || '09:00').split(':').map(Number);
        const start = sh * 60 + sm;
        const overnight = (e.end_time || '18:00') <= (e.start_time || '09:00');

        // Arrival: usually within a few minutes, occasionally properly late.
        let inAt = start + Math.floor(rnd() * 9) - 4;
        if (r > 0.86) inAt = start + 16 + Math.floor(rnd() * 50);

        let span;
        if (r < 0.09) span = 150 + Math.floor(rnd() * 90);        // half day
        else if (r > 0.9) span = 585 + Math.floor(rnd() * 150);   // overtime
        else span = 530 + Math.floor(rnd() * 40);                 // normal

        const inStamp = stampAt(date, inAt);
        insert.run(e.id, inStamp, date, 'in', rnd() < 0.5 ? 'kiosk' : 'web');
        count += 1;

        // Roughly one day in forty, somebody forgets to check out.
        if (back > 0 && rnd() < 0.025) continue;

        const outMins = inAt + span;
        const outDate = outMins >= 1440 || overnight && outMins >= 1440
          ? addDays(date, 1) : date;
        insert.run(e.id, stampAt(outDate, outMins), date, 'out',
          rnd() < 0.5 ? 'kiosk' : 'web');
        count += 1;
      }
    }
  });
  run();
  return count;
}

function seedDemoExtras() {
  // A holiday in the recent past and an approved leave day, so those paths
  // are visible in the reports without anyone having to create them.
  db.prepare(`INSERT OR IGNORE INTO holidays (work_date, name) VALUES (?, ?)`)
    .run(addDays(isoDate(), -20), 'Company Foundation Day');

  const someone = db.prepare("SELECT id FROM employees WHERE emp_code = 'MW003'").get();
  if (someone) {
    db.prepare(
      `INSERT OR IGNORE INTO day_overrides (employee_id, work_date, status, note)
       VALUES (?, ?, 'leave', 'Approved annual leave')`)
      .run(someone.id, addDays(isoDate(), -8));
  }
}

// --- run -------------------------------------------------------------------

console.log('');
const nShifts = seedShifts();
const nDepts = seedDepartments();
console.log(`  Shifts:      ${nShifts ? nShifts + ' created' : 'already present'}`);
console.log(`  Departments: ${nDepts ? nDepts + ' created' : 'already present'}`);

const admin = seedAdmin();
if (admin.created) {
  console.log('\n  ----------------------------------------------------------');
  console.log('   Admin account created');
  console.log(`   Email:    ${admin.email}`);
  console.log(`   Password: ${admin.password}`);
  console.log('   Change this password after your first sign-in.');
  console.log('  ----------------------------------------------------------');
} else {
  console.log(`  Admin:       already exists (${admin.email})`);
}

if (demo) {
  const staff = seedDemoStaff();
  const punches = seedDemoPunches();
  seedDemoExtras();
  console.log(`\n  Demo staff:   ${staff.length ? staff.length + ' added' : 'already present'}`);
  console.log(`  Demo punches: ${punches ? punches + ' recorded over 45 days' : 'already present'}`);
  if (staff.length) {
    console.log('\n  Demo logins use the password "password123".');
    console.log('  Kiosk PINs are 1000 + the employee number, e.g. MW002 -> 1002.');
  }
}

console.log('\n  Done. Start the server with:  npm start\n');
db.close();
