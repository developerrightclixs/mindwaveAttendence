/**
 * Run the whole app against an in-memory Postgres - no Supabase needed.
 *
 *   node scripts/dev-memory.js
 *
 * Useful for development and for proving the SQL layer end to end without a
 * network. Nothing persists: the database is rebuilt on every start.
 *
 * pg-mem can impersonate the `pg` module, so src/db.js connects to it without
 * knowing. That exercises the actual queries, the actual routes and the actual
 * templates - the only thing not being tested is Supabase's network.
 */
const { newDb } = require('pg-mem');
const path = require('node:path');

process.chdir(path.join(__dirname, '..'));

const mem = newDb({ autoCreateForeignKeyIndices: true });

// A few functions the app leans on that pg-mem does not ship.
mem.public.registerFunction({
  name: 'lower', args: ['text'], returns: 'text', implementation: (x) => (x || '').toLowerCase(),
});

const pg = mem.adapters.createPg();
require.cache[require.resolve('pg')] = { id: 'pg', filename: 'pg', loaded: true, exports: pg };

process.env.DATABASE_URL = 'postgres://memory/test?sslmode=disable';
process.env.PORT = process.env.PORT || '3400';
process.env.SESSION_SECRET = 'in-memory-test-secret';

const app = require(path.join(process.cwd(), 'src', 'server.js'));
const { init } = require(path.join(process.cwd(), 'src', 'db.js'));

(async () => {
  await init();

  const svc = require(path.join(process.cwd(), 'src', 'lib', 'service.js'));
  const { run, nowStamp } = require(path.join(process.cwd(), 'src', 'db.js'));
  const { setPassword, setPin } = require(path.join(process.cwd(), 'src', 'auth.js'));

  // Minimal fixture: one night shift, one admin, one employee.
  const shift = await run(
    `INSERT INTO shifts (name, start_time, end_time, grace_minutes, break_minutes,
       break_after_minutes, half_day_minutes, min_present_minutes,
       overtime_after_minutes, overtime_grace_minutes, weekly_off, created_at)
     VALUES ('Night (20:00-05:00)','20:00','05:00',10,0,0,270,60,540,15,'6,7',?)
     RETURNING id`, nowStamp());
  const sid = shift.rows[0].id;

  const admin = await run(
    `INSERT INTO employees (emp_code,name,email,role,shift_id,joined_on,active,created_at)
     VALUES ('SE001','Sabih Ul Ebad','sabih@mindwave.pk','admin',?,'2026-10-01',1,?)
     RETURNING id`, sid, nowStamp());
  await setPassword(admin.rows[0].id, 'testpass123');

  const emp = await run(
    `INSERT INTO employees (emp_code,name,email,role,shift_id,joined_on,active,created_at)
     VALUES ('NH001','Noman Haider','noman@mindwave.pk','employee',?,'2026-10-01',1,?)
     RETURNING id`, sid, nowStamp());
  await setPassword(emp.rows[0].id, 'testpass123');
  await setPin(emp.rows[0].id, '8059');

  await svc.setSelfEntryWindow({ enabled: true, from: '2026-10-01' }, admin.rows[0].id);

  app.listen(Number(process.env.PORT), () => {
    console.log(`READY on ${process.env.PORT}`);
  });
})().catch((e) => {
  console.error('BOOT FAILED:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
