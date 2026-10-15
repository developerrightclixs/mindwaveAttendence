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
const path = require('node:path');
const { Pool, types } = require('pg');

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

/**
 * Create the schema if it is missing. Safe on every cold start: every statement
 * is IF NOT EXISTS, and the promise is cached so concurrent requests do not
 * race through it.
 */
function init() {
  if (!ready) {
    ready = (async () => {
      if (!CONNECTION) {
        throw new Error(
          'No database configured. Set DATABASE_URL to your Supabase connection string.');
      }
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await pool.query(sql);
      // CREATE TABLE IF NOT EXISTS never adds a column to a table that already
      // exists, so additive changes need applying separately.
      for (const [table, column, decl] of COLUMN_MIGRATIONS) {
        await pool.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${decl}`);
      }
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

async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE key = ?', key);
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
