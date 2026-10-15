'use strict';
/**
 * PostgreSQL-backed session store.
 *
 * The default MemoryStore would log everyone out on every restart - and on a
 * serverless host, where each invocation is a new process, it would log them
 * out between page loads. Sessions have to live in the database.
 */
const { Store } = require('express-session');
const { all, one, run } = require('./db');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

class PgStore extends Store {
  constructor() {
    super();
    this.lastSweep = 0;
    // No timer: a serverless invocation may not live long enough to fire one,
    // and a long-lived process gets the same effect from the lazy sweep below.
  }

  /** Drop expired rows, at most once an hour, without blocking the request. */
  maybeSweep() {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    run('DELETE FROM sessions WHERE expires_at < ?', now)
      .catch((e) => console.error('[sessions] sweep failed:', e.message));
  }

  expiryOf(sess) {
    const ms = sess && sess.cookie && sess.cookie.maxAge
      ? sess.cookie.maxAge
      : DEFAULT_TTL_MS;
    return Date.now() + ms;
  }

  get(sid, cb) {
    this.maybeSweep();
    one('SELECT data, expires_at FROM sessions WHERE sid = ?', sid)
      .then((row) => {
        if (!row) return cb(null, null);
        if (Number(row.expires_at) < Date.now()) {
          run('DELETE FROM sessions WHERE sid = ?', sid).catch(() => {});
          return cb(null, null);
        }
        try {
          cb(null, JSON.parse(row.data));
        } catch (e) {
          cb(e);
        }
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    run(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET
         data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      sid, JSON.stringify(sess), this.expiryOf(sess),
    ).then(() => cb(null)).catch(cb);
  }

  destroy(sid, cb) {
    run('DELETE FROM sessions WHERE sid = ?', sid)
      .then(() => cb(null)).catch(cb);
  }

  touch(sid, sess, cb) {
    run('UPDATE sessions SET expires_at = ? WHERE sid = ?', this.expiryOf(sess), sid)
      .then(() => cb(null)).catch(cb);
  }

  length(cb) {
    one('SELECT COUNT(*) AS n FROM sessions')
      .then((r) => cb(null, Number(r.n))).catch(cb);
  }

  clear(cb) {
    run('DELETE FROM sessions').then(() => cb(null)).catch(cb);
  }

  all(cb) {
    all('SELECT sid, data FROM sessions WHERE expires_at >= ?', Date.now())
      .then((rows) => {
        const out = {};
        for (const r of rows) {
          try {
            out[r.sid] = JSON.parse(r.data);
          } catch { /* skip a corrupt row rather than fail the lot */ }
        }
        cb(null, out);
      })
      .catch(cb);
  }
}

module.exports = PgStore;
