'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const { db, DB_PATH, getSetting, setSetting } = require('./db');
const SqliteStore = require('./session-store');
const { loadUser } = require('./auth');
const svc = require('./lib/service');
const fmt = require('./lib/dates');
const ui = require('./lib/ui');
const { STATUS_LABELS } = require('./lib/attendance');

const app = express();
const PORT = process.env.PORT || 3000;
// Bind address. Defaults to every interface, which is what you want on a
// dedicated office box - but NOT on a machine with a VPN tunnel up, because
// /kiosk is deliberately unauthenticated and would be reachable through it.
// Set HOST to the office LAN address (e.g. 192.168.18.53) to pin it down.
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// Session secret
// ---------------------------------------------------------------------------
// Generated once and kept in the settings table so sessions survive restarts
// without asking whoever installs this to invent a secret. SESSION_SECRET in
// the environment overrides it.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', s);
  }
  return s;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------
// The stylesheet is cached hard for speed, which means a browser will happily
// keep serving the previous version for an hour after an update - showing a
// half-styled page that looks broken. Referencing it as /app.css?v=<hash of
// its contents> makes the URL change whenever the file does, so an update is
// picked up immediately while unchanged files still cache.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function assetVersion(...files) {
  const h = crypto.createHash('sha1');
  for (const f of files) {
    try {
      h.update(fs.readFileSync(path.join(PUBLIC_DIR, f)));
    } catch {
      h.update(String(Date.now()));
    }
  }
  return h.digest('hex').slice(0, 10);
}
// Hash the stylesheet AND the font declarations together, so changing either
// invalidates the cached pair rather than leaving a page styled by one and
// lettered by the other.
const ASSET_V = assetVersion('app.css', path.join('fonts', 'fonts.css'));

app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

app.use(session({
  name: 'mw.sid',
  store: new SqliteStore(),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
    // Served over plain HTTP on an office LAN by default; set SECURE_COOKIES=1
    // once a TLS terminator is in front of it.
    secure: process.env.SECURE_COOKIES === '1',
  },
}));

app.use(loadUser);

// Helpers and flash messages available to every template. This runs before
// the CSRF guard below, because that guard renders a page when it rejects and
// every template needs these locals to exist.
app.use((req, res, next) => {
  res.locals.fmt = fmt;
  res.locals.assetV = ASSET_V;
  res.locals.icon = ui.icon;
  res.locals.avatar = ui.avatar;
  res.locals.STATUS_LABELS = STATUS_LABELS;
  // The business date in progress, not the calendar date - on a night shift
  // these differ between midnight and the early afternoon.
  res.locals.today = svc.currentBusinessDate();
  res.locals.calendarToday = fmt.isoDate();
  // Nav badge counts. Only staff screens show them, so skip the work entirely
  // for a plain employee - it is a per-request scan of the month.
  res.locals.navCounts = (req.user && req.user.role !== 'employee')
    ? svc.navCounts()
    : null;
  res.locals.path = req.path;
  res.locals.query = req.query;
  if (req.session) {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  // Routes call res.flash('ok', '...') then redirect.
  res.flash = (kind, message) => {
    if (req.session) req.session.flash = { kind, message };
  };
  next();
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------
// Every state change in this app is a form POST, so a per-session token
// checked on all unsafe methods is enough; there is no cross-origin API.
app.use((req, res, next) => {
  if (req.session && !req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrf = req.session ? req.session.csrf : '';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sent = req.body && req.body._csrf;
    if (!sent || sent !== req.session.csrf) {
      return res.status(403).render('error', {
        title: 'Session expired',
        message: 'This form was stale. Please go back and try again.',
      });
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/me'));
app.use('/kiosk', require('./routes/kiosk'));
app.use('/admin', require('./routes/admin'));
app.use('/reports', require('./routes/reports'));

app.get('/healthz', (req, res) => res.json({ ok: true, db: DB_PATH }));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: 'That page does not exist.',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).render('error', {
    title: status >= 500 ? 'Something broke' : 'Cannot do that',
    message: status >= 500
      ? 'An unexpected error occurred. Check the server log.'
      : err.message,
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (require.main === module) {
  const hasAdmin = db.prepare(
    "SELECT 1 FROM employees WHERE role = 'admin' AND active = 1").get();

  const server = app.listen(PORT, HOST, () => {
    const addr = server.address();
    // Print the URL that actually works: when HOST is pinned to a LAN address,
    // localhost is NOT reachable, and saying otherwise sends whoever installs
    // this chasing a connection refused.
    const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`\n  Mindwave Attendance  ->  http://${host}:${PORT}`);
    console.log(`  Kiosk                ->  http://${host}:${PORT}/kiosk`);
    console.log(`  Listening on: ${addr.address}:${addr.port}`);
    console.log(`  Database: ${DB_PATH}`);
    if (HOST === '0.0.0.0') {
      console.log('  NOTE: bound to every interface. If this machine runs a VPN or');
      console.log('        is internet-facing, set HOST to your office LAN address.');
    }
    if (!hasAdmin) {
      console.log('\n  No admin account exists yet. Run:  npm run seed\n');
    } else {
      console.log('');
    }
  });

  const close = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

module.exports = app;
