'use strict';
/**
 * PostgreSQL access layer (Supabase).
 *
 * Everything here is async, because node-postgres is. Call sites keep `?`
 * placeholders, which are translated to Postgres's `$1..$n` on the way out -
 * that keeps the SQL readable and meant the port did not have to renumber a
 * hundred queries by hand.
 *
 * Three shapes cover every query in the app:
 *   one(sql, ...args)  -> the first row, or undefined
 *   all(sql, ...args)  -> an array of rows
 *   run(sql, ...args)  -> { rowCount, rows } for writes
 * and `tx(fn)` runs a function against a single pooled client, so a batch of
 * writes commits or rolls back together.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool, types } = require('pg');
const { invalidate, memo } = require('./lib/request-cache');

// Return BIGINT and NUMERIC as JavaScript numbers. COUNT(*) comes back as a
// string otherwise, and `'3' > 2` is the kind of bug that hides for months.
// Guarded because a test double for `pg` need not implement the type registry.
if (types && typeof types.setTypeParser === 'function') {
  types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
  types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
}

const CONNECTION = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';

/**
 * Supabase requires TLS. Its pooler presents a certificate that does not chain
 * to a root bundled with Node, so verification is relaxed for that host only -
 * the connection is still encrypted. Anything else keeps full verification.
 */
function sslFor(url) {
  if (!url) return false;
  if (/sslmode=disable/.test(url)) return false;
  if (/supabase\.(co|com)/.test(url)) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: CONNECTION,
  ssl: sslFor(CONNECTION),
  // Serverless invocations are short and numerous; a small pool with a brisk
  // idle timeout avoids exhausting Supabase's connection limit.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  // An idle client dropped by the server must not take the process down.
  console.error('[db] idle client error:', err.message);
});

/** `?` -> `$1..$n`, ignoring question marks inside quoted literals. */
function toPg(sql) {
  let i = 0;
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let p = 0; p < sql.length; p++) {
    const c = sql[p];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === '?' && !inSingle && !inDouble) {
      i += 1;
      out += `$${i}`;
    } else {
      out += c;
    }
  }
  return out;
}

async function query(sql, args) {
  const text = toPg(sql);
  try {
    return await pool.query(text, args);
  } catch (e) {
    // Without the statement, a Postgres error is near-impossible to place.
    e.message = `${e.message}\n  SQL: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
    throw e;
  }
}

const all = async (sql, ...args) => (await query(sql, args)).rows;
const one = async (sql, ...args) => (await query(sql, args)).rows[0];
const run = async (sql, ...args) => {
  const r = await query(sql, args);
  // A write makes anything this request has already remembered potentially
  // stale, so the per-request memo is emptied rather than allowed to serve a
  // value from before the write.
  invalidate();
  return { rowCount: r.rowCount, rows: r.rows };
};

/**
 * Run `fn` inside a transaction. `fn` receives helpers bound to one client, so
 * every statement inside genuinely shares the transaction.
 */
async function tx(fn) {
  const client = await pool.connect();
  const bound = {
    all: async (sql, ...args) => (await client.query(toPg(sql), args)).rows,
    one: async (sql, ...args) => (await client.query(toPg(sql), args)).rows[0],
    run: async (sql, ...args) => {
      const r = await client.query(toPg(sql), args);
      invalidate();
      return { rowCount: r.rowCount, rows: r.rows };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(bound);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch { /* the connection may already be gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// --- schema -----------------------------------------------------------------

// Columns added after the first release. Applied on every boot; ADD COLUMN
// IF NOT EXISTS makes that a no-op once present.
const COLUMN_MIGRATIONS = [
  ['employees', 'attendance_exempt', 'INTEGER NOT NULL DEFAULT 0'],
  ['day_overrides', 'leave_type',
    "TEXT CHECK (leave_type IS NULL OR leave_type IN ('sick','casual'))"],
];

let ready = null;

/** Fingerprint of the schema this build expects, so a stale one is noticed. */
function schemaFingerprint(sql) {
  return crypto.createHash('sha1')
    .update(sql).update(JSON.stringify(COLUMN_MIGRATIONS))
    .digest('hex').slice(0, 16);
}

/**
 * Create the schema if it is missing. Safe on every cold start: every statement
 * is IF NOT EXISTS, and the promise is cached so concurrent requests do not
 * race through it.
 *
 * On a long-running server this happens once at boot and the cost is
 * invisible. On a serverless host there is no "once": every cold instance is a
 * new process, and a quiet week of traffic means most page loads start one. So
 * the schema is fingerprinted and the result recorded - a cold start that
 * finds its own fingerprint already there skips the DDL and spends a single
 * round trip instead of three plus however long Postgres takes to take locks
 * on twenty objects.
 *
 * Anything unexpected - no settings table, a different fingerprint, a failed
 * read - falls through to running the DDL, which is the behaviour this
 * replaces and is safe to repeat.
 */
function init() {
  if (!ready) {
    ready = (async () => {
      if (!CONNECTION) {
        throw new Error(
          'No database configured. Set DATABASE_URL to your Supabase connection string.');
      }
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const want = schemaFingerprint(sql);

      try {
        const r = await pool.query(
          'SELECT value FROM settings WHERE key = $1', ['schema_fingerprint']);
        if (r.rows[0] && r.rows[0].value === want) return;
      } catch { /* no settings table yet, or no database yet: build it below */ }

      await pool.query(sql);
      // CREATE TABLE IF NOT EXISTS never adds a column to a table that already
      // exists, so additive changes need applying separately.
      for (const [table, column, decl] of COLUMN_MIGRATIONS) {
        await pool.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${decl}`);
      }
      // Recorded only once the DDL has actually succeeded, so a half-applied
      // schema is never mistaken for a finished one.
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['schema_fingerprint', want]);
    })().catch((e) => {
      ready = null;              // let the next request retry rather than wedge
      throw e;
    });
  }
  return ready;
}

// --- small helpers used everywhere ------------------------------------------

/** "YYYY-MM-DD HH:MM:SS" local, matching how every other timestamp is stored. */
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Settings are read one key at a time by callers but fetched as a table.
 *
 * A page asks for the self-entry window, the leave allowance and the kiosk
 * lock separately - five round trips for five short rows. The whole table is
 * a handful of rows, so it is fetched once per request and answered from
 * there. A write empties the memo, so a route that saves a setting and reads
 * it back still sees the new value.
 */
async function getSetting(key, fallback = null) {
  const rows = await memo('settings', () => all('SELECT key, value FROM settings'));
  const row = rows.find((r) => r.key === key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    key, String(value),
  );
}

async function audit(actorId, action, target, detail) {
  // Capture the name now: actor_id is set to NULL if the employee is ever
  // deleted, and an audit entry with no actor is useless.
  let actorName = null;
  if (actorId != null) {
    const row = await one('SELECT name FROM employees WHERE id = ?', actorId);
    if (row) actorName = row.name;
  }
  await run(
    `INSERT INTO audit_log (actor_id, actor_name, action, target, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    actorId ?? null, actorName, action, target ?? null,
    detail == null ? null : String(detail), nowStamp(),
  );
}

module.exports = {
  pool, init, all, one, run, tx, toPg,
  getSetting, setSetting, audit, nowStamp,
  DB_URL: CONNECTION,
};
