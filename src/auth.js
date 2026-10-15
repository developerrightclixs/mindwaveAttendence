'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { one, run, getSetting, setSetting, audit } = require('./db');
const { getEmployeeByEmail, getEmployeeByCode } = require('./lib/service');

const ROUNDS = 10;

const hash = (plain) => bcrypt.hashSync(String(plain), ROUNDS);
const verify = (plain, stored) => !!stored && bcrypt.compareSync(String(plain), stored);

/** Validate an email + password login. Returns the employee row or null. */
async function authenticate(email, password) {
  const emp = await getEmployeeByEmail(String(email || '').trim());
  if (!emp || !emp.active || !emp.password_hash) return null;
  return verify(password, emp.password_hash) ? emp : null;
}

/**
 * Validate a kiosk code + PIN. Employee code is public (it is on the badge),
 * so the PIN is the only secret and is stored hashed like a password.
 */
async function authenticatePin(empCode, pin) {
  const emp = await getEmployeeByCode(String(empCode || '').trim());
  if (!emp || !emp.active || !emp.pin_hash) return null;
  return verify(pin, emp.pin_hash) ? emp : null;
}

// `q` lets these run inside a caller's transaction (the bulk importer).
function setPassword(employeeId, plain, q = null) {
  return (q || { run }).run(
    'UPDATE employees SET password_hash = ? WHERE id = ?', hash(plain), employeeId);
}

function setPin(employeeId, pin, q = null) {
  const db = q || { run };
  const clean = String(pin || '').trim();
  if (clean === '') {
    return db.run('UPDATE employees SET pin_hash = NULL WHERE id = ?', employeeId);
  }
  if (!/^\d{4,8}$/.test(clean)) {
    throw Object.assign(new Error('PIN must be 4 to 8 digits'), { status: 400 });
  }
  return db.run('UPDATE employees SET pin_hash = ? WHERE id = ?', hash(clean), employeeId);
}

// --- kiosk device lock ------------------------------------------------------

/**
 * The kiosk screen is deliberately unauthenticated - it is a shared device by
 * the door. That is safe on an office LAN and NOT safe on the public
 * internet, where the URL is a place to guess employee codes and PINs.
 *
 * A device passphrase closes that gap without spoiling the walk-up flow: the
 * tablet is unlocked once, keeps a signed cookie, and staff still just tap a
 * code and a PIN. The cookie carries a hash of the current passphrase, so
 * changing it logs every device out at once.
 */
const KIOSK_COOKIE = 'mw.kiosk';

async function kioskPassphraseSet() {
  return !!(await getSetting('kiosk_passphrase_hash', ''));
}

async function setKioskPassphrase(plain, actorId) {
  const clean = String(plain || '').trim();
  if (clean === '') {
    await setSetting('kiosk_passphrase_hash', '');
    await audit(actorId, 'kiosk.unlock_removed', null, 'kiosk left open');
    return false;
  }
  if (clean.length < 6) {
    throw Object.assign(new Error('The kiosk passphrase must be at least 6 characters'),
      { status: 400 });
  }
  await setSetting('kiosk_passphrase_hash', hash(clean));
  await audit(actorId, 'kiosk.passphrase_set', null,
    'all kiosk devices must unlock again');
  return true;
}

/** Token stored on the device; tied to the passphrase currently in force. */
async function kioskDeviceToken() {
  const stored = await getSetting('kiosk_passphrase_hash', '');
  return crypto.createHash('sha256').update('kiosk:' + stored).digest('hex').slice(0, 32);
}

/**
 * Whether this device may take punches.
 *
 * With no passphrase configured the kiosk is open, which is correct on an
 * office LAN. On a public deployment that would be an open punch endpoint, and
 * a fresh install has no passphrase yet - so when the app is running behind
 * TLS (SECURE_COOKIES=1, i.e. it is on the internet) an unconfigured kiosk
 * fails CLOSED rather than open. There is no window where a new deployment is
 * publicly punchable.
 */
async function kioskDeviceUnlocked(req) {
  if (!(await kioskPassphraseSet())) return !isPublicDeployment();
  const c = req.signedCookies && req.signedCookies[KIOSK_COOKIE];
  return !!c && c === (await kioskDeviceToken());
}

const isPublicDeployment = () => process.env.SECURE_COOKIES === '1';

/** True when the kiosk is shut because nobody has configured it yet. */
async function kioskNeedsSetup() {
  return isPublicDeployment() && !(await kioskPassphraseSet());
}

async function unlockKioskDevice(res, secure) {
  res.cookie(KIOSK_COOKIE, await kioskDeviceToken(), {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: !!secure,
    maxAge: 180 * 24 * 60 * 60 * 1000,             // a door tablet, not a session
  });
}

async function checkKioskPassphrase(plain) {
  const stored = await getSetting('kiosk_passphrase_hash', '');
  return !!stored && verify(plain, stored);
}

// --- route guards ----------------------------------------------------------

/** Attach req.user from the session on every request. */
async function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  if (id) {
    const u = await one(
      `SELECT e.id, e.emp_code, e.name, e.email, e.role, e.department_id,
              e.shift_id, e.active, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`, id);
    // A user deactivated mid-session loses access at their next request.
    if (u && u.active) req.user = u;
    else req.session.destroy(() => {});
  }
  res.locals.user = req.user || null;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    const back = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${back}`);
  }
  next();
}

/** Allow only the listed roles. Admins pass every check. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    res.status(403).render('error', {
      title: 'Not allowed',
      message: 'You do not have access to that page.',
    });
  };
}

/**
 * A manager may view their own team; an admin may view anyone; everyone else
 * only themselves. Used by any route that takes an :id in the path.
 */
async function canViewEmployee(user, employeeId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (Number(user.id) === Number(employeeId)) return true;
  if (user.role === 'manager') {
    const row = await one('SELECT manager_id FROM employees WHERE id = ?', employeeId);
    return !!row && Number(row.manager_id) === Number(user.id);
  }
  return false;
}

module.exports = {
  hash, verify, authenticate, authenticatePin, setPassword, setPin,
  loadUser, requireLogin, requireRole, canViewEmployee,
  KIOSK_COOKIE, kioskPassphraseSet, setKioskPassphrase, kioskDeviceUnlocked,
  unlockKioskDevice, checkKioskPassphrase, kioskNeedsSetup, isPublicDeployment,
};
