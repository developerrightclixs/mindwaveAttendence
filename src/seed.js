'use strict';
/**
 * First-run setup.
 *
 *   npm run seed     shifts, departments and an admin account *   npm run seed     shifts, departments and an admin account
 *
 * Safe to re-run: it only ever inserts what is missing.
 */
require('./lib/timezone').applyTimezone();
const crypto = require('node:crypto');
const { init, all, one, run, audit, nowStamp, pool } = require('./db');
const { setPassword } = require('./auth');
const { isoDate } = require('./lib/dates');

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
];

const DEPARTMENTS = [
  'Production', 'Quality Assurance', 'Design Junior',
  'Project Manager', 'Social Media', 'Management', 'Office Boy',
];

async function seedShifts() {
  let n = 0;
  for (const s of SHIFTS) {
    const exists = await one('SELECT 1 FROM shifts WHERE name = ?', s.name);
    if (exists) continue;
    await run(
      `INSERT INTO shifts
         (name, start_time, end_time, grace_minutes, break_minutes, break_after_minutes,
          half_day_minutes, min_present_minutes, overtime_after_minutes,
          overtime_grace_minutes, weekly_off, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.name, s.start_time, s.end_time, s.grace_minutes, s.break_minutes,
      s.break_after_minutes, s.half_day_minutes, s.min_present_minutes,
      s.overtime_after_minutes, s.overtime_grace_minutes, s.weekly_off, nowStamp());
    n += 1;
  }
  return n;
}

async function seedDepartments() {
  let n = 0;
  for (const d of DEPARTMENTS) {
    const r = await run(
      `INSERT INTO departments (name, created_at) VALUES (?, ?)
       ON CONFLICT (name) DO NOTHING`, d, nowStamp());
    n += r.rowCount;
  }
  return n;
}

async function seedAdmin() {
  const existing = await one("SELECT * FROM employees WHERE role = 'admin'");
  if (existing) return { created: false, email: existing.email };

  // A random first password beats a hardcoded one; it is printed once here and
  // the admin is told to change it.
  const password = process.env.ADMIN_PASSWORD
    || crypto.randomBytes(6).toString('base64url');
  const email = process.env.ADMIN_EMAIL || 'admin@mindwave.local';
  const shift = await one('SELECT id FROM shifts ORDER BY id LIMIT 1');

  const res = await run(
    `INSERT INTO employees
       (emp_code, name, email, role, shift_id, joined_on, active, created_at)
     VALUES (?, ?, ?, 'admin', ?, ?, 1, ?)
     RETURNING id`,
    'ADMIN', 'System Administrator', email, shift ? shift.id : null,
    isoDate(), nowStamp());

  const id = res.rows[0].id;
  await setPassword(id, password);
  await audit(null, 'seed.admin', `employee:${id}`, email);
  return { created: true, email, password };
}

(async () => {
  try {
    await init();
  } catch (e) {
    console.error('\n  Cannot reach the database.');
    console.error('  ' + e.message.split('\n')[0]);
    console.error('  Set DATABASE_URL to your Supabase connection string.\n');
    process.exit(1);
  }

  console.log('');
  const nShifts = await seedShifts();
  const nDepts = await seedDepartments();
  console.log(`  Shifts:      ${nShifts ? nShifts + ' created' : 'already present'}`);
  console.log(`  Departments: ${nDepts ? nDepts + ' created' : 'already present'}`);

  const admin = await seedAdmin();
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

  const staff = await all('SELECT COUNT(*) AS n FROM employees');
  console.log(`\n  Employees in the database: ${staff[0].n}`);
  console.log('  Done. Start the server with:  npm start\n');
  await pool.end();
})();
