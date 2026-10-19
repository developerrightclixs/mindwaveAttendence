/**
 * One-time migration: the SQLite backup -> Supabase.
 *
 * Carries the password and PIN hashes across verbatim, so nobody has to be
 * issued new credentials. Identity columns are re-sequenced afterwards, since
 * explicit ids are inserted here and Postgres would otherwise hand out ids
 * that are already taken.
 */
require('../src/lib/timezone').applyTimezone();
const Database = require('better-sqlite3');
const { one, init, run, tx, pool, nowStamp } = require('../src/db');

const SRC = process.argv[2];
const COMMIT = process.argv.includes('--commit');
// Punch history is opt-in. The sheet import was deliberately cleared so staff
// could re-enter their own nights; silently restoring it would undo that.
const WITH_PUNCHES = process.argv.includes('--with-punches');

(async () => {
  const lite = new Database(SRC, { readonly: true });
  await init();

  const read = (t) => lite.prepare(`SELECT * FROM ${t}`).all();

  const src = {
    departments: read('departments'),
    shifts: read('shifts'),
    employees: read('employees'),
    punches: read('punches'),
    day_overrides: read('day_overrides'),
    holidays: read('holidays'),
    settings: read('settings'),
    audit_log: read('audit_log'),
  };

  console.log('In the SQLite backup:');
  for (const [t, rows] of Object.entries(src)) {
    const skip = (t === 'punches' && !WITH_PUNCHES) ? '  (SKIPPED - pass --with-punches to include)' : '';
    console.log(`  ${t.padEnd(16)} ${String(rows.length).padEnd(5)}${skip}`);
  }
  if (!WITH_PUNCHES) src.punches = [];

  const existing = Number((await one('SELECT COUNT(*) AS n FROM employees')).n);
  console.log(`\nAlready in Supabase: ${existing} employees`);
  if (existing > 0) {
    console.error('REFUSED: Supabase already holds employees. Migrating now would');
    console.error('duplicate them. Clear them first if this is a redo.');
    process.exit(1);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN - nothing written. Re-run with --commit.');
    console.log('Would carry across, preserving ids and credential hashes:');
    for (const e of src.employees) {
      console.log(`  ${String(e.id).padEnd(4)} ${e.emp_code.padEnd(8)} ${e.name.padEnd(18)}`
        + `${e.email || 'kiosk only'}  pw=${e.password_hash ? 'yes' : 'no'} pin=${e.pin_hash ? 'yes' : 'no'}`);
    }
    await pool.end();
    lite.close();
    return;
  }

  const now = nowStamp();

  await tx(async (t) => {
    // Order matters: departments and shifts are referenced by employees,
    // employees by everything else.
    for (const d of src.departments) {
      await t.run(
        'INSERT INTO departments (id, name, created_at) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?)',
        d.id, d.name, d.created_at || now);
    }
    for (const s of src.shifts) {
      await t.run(
        `INSERT INTO shifts (id, name, start_time, end_time, grace_minutes,
           break_minutes, break_after_minutes, half_day_minutes, min_present_minutes,
           overtime_after_minutes, overtime_grace_minutes, weekly_off, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.id, s.name, s.start_time, s.end_time, s.grace_minutes, s.break_minutes,
        s.break_after_minutes, s.half_day_minutes, s.min_present_minutes,
        s.overtime_after_minutes, s.overtime_grace_minutes, s.weekly_off,
        s.created_at || now);
    }
    // Employees first without manager_id, so a manager who appears later in
    // the list does not break the self-reference.
    for (const e of src.employees) {
      await t.run(
        `INSERT INTO employees (id, emp_code, name, email, password_hash, pin_hash,
           role, department_id, shift_id, joined_on, active, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        e.id, e.emp_code, e.name, e.email, e.password_hash, e.pin_hash, e.role,
        e.department_id, e.shift_id, e.joined_on, e.active, e.created_at || now);
    }
    for (const e of src.employees) {
      if (e.manager_id) {
        await t.run('UPDATE employees SET manager_id = ? WHERE id = ?', e.manager_id, e.id);
      }
    }
    for (const p of src.punches) {
      await t.run(
        `INSERT INTO punches (id, employee_id, punched_at, work_date, kind, source,
           note, created_by, created_at)
         OVERRIDING SYSTEM VALUE VALUES (?,?,?,?,?,?,?,?,?)`,
        p.id, p.employee_id, p.punched_at, p.work_date, p.kind, p.source,
        p.note, p.created_by, p.created_at || now);
    }
    for (const o of src.day_overrides) {
      await t.run(
        `INSERT INTO day_overrides (employee_id, work_date, status, note, set_by, set_at)
         VALUES (?,?,?,?,?,?)`,
        o.employee_id, o.work_date, o.status, o.note, o.set_by, o.set_at || now);
    }
    for (const h of src.holidays) {
      await t.run('INSERT INTO holidays (work_date, name) VALUES (?, ?)', h.work_date, h.name);
    }
    for (const s of src.settings) {
      await t.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, s.key, s.value);
    }
    for (const a of src.audit_log) {
      await t.run(
        `INSERT INTO audit_log (id, actor_id, actor_name, action, target, detail, at)
         OVERRIDING SYSTEM VALUE VALUES (?,?,?,?,?,?,?)`,
        a.id, a.actor_id, a.actor_name, a.action, a.target, a.detail, a.at || now);
    }
  });

  // Explicit ids were inserted, so the identity sequences still start at 1.
  // Without this the next insert collides with a row that already exists.
  for (const t of ['departments', 'shifts', 'employees', 'punches', 'audit_log']) {
    await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'),
                 COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
  }

  console.log('\nMigrated. Now in Supabase:');
  for (const t of ['departments', 'shifts', 'employees', 'punches',
    'day_overrides', 'holidays', 'settings', 'audit_log']) {
    const n = (await one(`SELECT COUNT(*) AS n FROM ${t}`)).n;
    console.log(`  ${t.padEnd(16)} ${n}`);
  }

  await pool.end();
  lite.close();
})().catch((e) => {
  console.error('Migration failed:', e.message.split('\n')[0]);
  process.exit(1);
});
