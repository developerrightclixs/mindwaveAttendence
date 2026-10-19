'use strict';
// The timezone is pinned before anything else is loaded, because every module
// below reasons in local wall-clock time and a Date built under the wrong zone
// cannot be corrected afterwards.
const TIMEZONE = require('./lib/timezone').applyTimezone();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const { pool, init, one, getSetting, setSetting, DB_URL } = require('./db');
const PgStore = require('./session-store');
const { loadUser } = require('./auth');
const { withRequestCache } = require('./lib/request-cache');
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

// Session lifetimes. The short one covers a single shift plus slack, so an
// unattended browser does not stay signed in indefinitely. "Remember me"
// swaps in the long one at login; `rolling` then keeps extending whichever
// the session was given, because the cookie settings are stored per session.
const SESSION_HOURS = 12;
const REMEMBER_DAYS = Number(process.env.REMEMBER_ME_DAYS || 30);

// ---------------------------------------------------------------------------
// Session secret
// ---------------------------------------------------------------------------
// Generated once and kept in the settings table so sessions survive restarts
// without asking whoever installs this to invent a secret. SESSION_SECRET in
// the environment overrides it.
async function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = await getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', s);
  }
  return s;
}

// Resolved once at boot and shared by the session middleware and the
// signed-cookie parser, which must agree or the kiosk unlock breaks.
let SECRET = process.env.SESSION_SECRET || '';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// Everything downstream runs inside this request's own memo, so the repeated
// lookups a page makes (the shift list, the active employees, the month's
// holidays) cost one query each instead of one per asking. The store is
// created per request and shared with nothing.
app.use((req, res, next) => withRequestCache(() => next()));

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

// ---------------------------------------------------------------------------
// Bootstrap gate
// ---------------------------------------------------------------------------
// Everything below needs the database: the session store reads from it, and
// the session secret is kept in it. This gate runs BEFORE any of that, and
// before the routes, so nothing can be served with a half-initialised app.
// Static assets are mounted above it on purpose - the stylesheet should still
// load if the database is unreachable.

let bootstrapped = null;

function bootstrap() {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await init();
      SECRET = await resolveSessionSecret();
    })().catch((e) => {
      bootstrapped = null;             // let the next request retry
      throw e;
    });
  }
  return bootstrapped;
}

// Built once, after the secret is known. Constructing them at module load
// would bake in an empty secret and silently invalidate every cookie.
let cookieMw = null;
let sessionMw = null;

// Locals that need nothing but this process. They are set before bootstrap,
// not after it, because bootstrap is the step that fails when the database is
// unreachable - and it answers with next(e), which skips every middleware
// below and lands in the error handler. Set them afterwards and the error page
// renders without them: a ReferenceError on `assetV` inside head.ejs, thrown
// while reporting the original fault, which is then lost behind it.
app.use((req, res, next) => {
  res.locals.fmt = fmt;
  res.locals.assetV = ASSET_V;
  res.locals.icon = ui.icon;
  res.locals.avatar = ui.avatar;
  res.locals.STATUS_LABELS = STATUS_LABELS;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.calendarToday = fmt.isoDate();
  res.locals.today = fmt.isoDate();
  res.locals.rememberDays = REMEMBER_DAYS;
  res.locals.navCounts = null;
  res.locals.flash = null;
  // head.ejs and foot.ejs read `user` bare, so it has to exist even when
  // loadUser never got the chance to run. The real value lands below.
  res.locals.user = null;
  res.locals.csrf = '';
  next();
});

app.use(async (req, res, next) => {
  try {
    await bootstrap();
  } catch (e) {
    return next(e);
  }
  if (!cookieMw) {
    // Signed cookies carry the kiosk device unlock, which outlives a session.
    cookieMw = cookieParser(SECRET);
    sessionMw = session({
      name: 'mw.sid',
      store: new PgStore(),
      secret: SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_HOURS * 60 * 60 * 1000,
        // Plain HTTP on an office LAN by default; set SECURE_COOKIES=1 once a
        // TLS terminator is in front of it.
        secure: process.env.SECURE_COOKIES === '1',
      },
    });
  }
  cookieMw(req, res, (err) => (err ? next(err) : sessionMw(req, res, next)));
});

// "Keep me signed in" is a property of the session, not of the one response
// that set it. `rolling` renews whatever window the cookie already carries,
// which only stays 30 days for as long as originalMaxAge survives being
// serialised into the store and read back out - a quiet dependency on a
// detail of express-session. Re-asserting it here from the flag the login
// stored makes the long window the session's own state: whatever came back
// from the database, a remembered session is extended to the full window on
// every request, and a short one is left alone.
app.use((req, res, next) => {
  if (req.session && req.session.remember) {
    req.session.cookie.maxAge = REMEMBER_DAYS * 24 * 60 * 60 * 1000;
  }
  next();
});

app.use(loadUser);

// Helpers and flash messages available to every template. This runs before
// the CSRF guard below, because that guard renders a page when it rejects and
// every template needs these locals to exist.
app.use(async (req, res, next) => {
  // The cheap, synchronous locals are already set above, before bootstrap, so
  // that a database failure still renders a readable error page. What is left
  // here is only what the database itself can answer.
  // The business date in progress, not the calendar date - on a night shift
  // these differ between midnight and the early afternoon.
  //
  // These are awaited, not assigned as promises: a template that received a
  // pending promise would render "[object Promise]" into the page rather than
  // fail, which is the kind of bug that ships.
  res.locals.today = await svc.currentBusinessDate();
  // Nav badge counts. Only staff screens show them, so skip the work entirely
  // for a plain employee - it is a per-request scan of the month.
  res.locals.navCounts = (req.user && req.user.role !== 'employee')
    ? await svc.navCounts()
    : null;
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

app.get('/healthz', async (req, res) => {
  // Prove the database answers, not merely that the process is up - on a
  // managed Postgres the connection is the thing that fails.
  try {
    await one('SELECT 1 AS ok');
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'unreachable', error: e.message });
  }
});

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
// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      await bootstrap();
    } catch (e) {
      console.error('\n  Cannot reach the database.');
      console.error('  ' + e.message.split('\n')[0]);
      console.error('  Set DATABASE_URL to your Supabase connection string.\n');
      process.exit(1);
    }

    const hasAdmin = await one(
      "SELECT 1 FROM employees WHERE role = 'admin' AND active = 1");

    const server = app.listen(PORT, HOST, () => {
      const addr = server.address();
      const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
      const where = DB_URL.replace(/:[^:@/]*@/, ':****@');
      console.log(`\n  Mindwave Attendance  ->  http://${host}:${PORT}`);
      console.log(`  Kiosk                ->  http://${host}:${PORT}/kiosk`);
      console.log(`  Listening on: ${addr.address}:${addr.port}`);
      console.log(`  Database: ${where.slice(0, 72)}`);
      // Printed because every shift rule is read off this clock. If it says
      // UTC, lateness and night-shift dates are already wrong.
      console.log(`  Clock: ${TIMEZONE} - ${fmt.isoStamp()}`);
      if (!hasAdmin) {
        console.log('\n  No admin account exists yet. Run:  npm run seed\n');
      } else {
        console.log('');
      }
    });

    const close = () => {
      server.close(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
      });
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  })();
}

module.exports = app;
