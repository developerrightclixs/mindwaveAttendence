'use strict';
/**
 * SQLite-backed session store. The default MemoryStore would log everyone out
 * on every restart, which on a self-hosted office box means every deploy.
 */
const { Store } = require('express-session');
const { db } = require('./db');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

class SqliteStore extends Store {
  constructor() {
    super();
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET
                         data = excluded.data, expires_at = excluded.expires_at`),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    };
    // Clear anything already expired, then sweep hourly.
    this.sweep();
    this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    this.timer.unref();
  }

  sweep() {
    try {
      this.stmts.sweep.run(Date.now());
    } catch {
      /* a failed sweep is not worth taking the server down for */
    }
  }

  expiryOf(sess) {
    const ms = sess && sess.cookie && sess.cookie.maxAge
      ? sess.cookie.maxAge
      : DEFAULT_TTL_MS;
    return Date.now() + ms;
  }

  get(sid, cb) {
    let row;
    try {
      row = this.stmts.get.get(sid);
    } catch (e) {
      return cb(e);
    }
    if (!row) return cb(null, null);
    if (row.expires_at < Date.now()) {
      this.stmts.del.run(sid);
      return cb(null, null);
    }
    try {
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.del.run(sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.expiryOf(sess), sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
}

module.exports = SqliteStore;
