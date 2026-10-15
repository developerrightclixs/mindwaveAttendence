'use strict';
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { getEmployeeByEmail, getEmployeeByCode } = require('./lib/service');

const ROUNDS = 10;

const hash = (plain) => bcrypt.hashSync(String(plain), ROUNDS);
const verify = (plain, stored) => !!stored && bcrypt.compareSync(String(plain), stored);

/** Validate an email + password login. Returns the employee row or null. */
function authenticate(email, password) {
  const emp = getEmployeeByEmail(String(email || '').trim());
  if (!emp || !emp.active || !emp.password_hash) return null;
  return verify(password, emp.password_hash) ? emp : null;
}

/**
 * Validate a kiosk code + PIN. Employee code is public (it is on the badge),
 * so the PIN is the only secret and is stored hashed like a password.
 */
function authenticatePin(empCode, pin) {
  const emp = getEmployeeByCode(String(empCode || '').trim());
  if (!emp || !emp.active || !emp.pin_hash) return null;
  return verify(pin, emp.pin_hash) ? emp : null;
}

function setPassword(employeeId, plain) {
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?')
    .run(hash(plain), employeeId);
}

function setPin(employeeId, pin) {
  const clean = String(pin || '').trim();
  if (clean === '') {
    db.prepare('UPDATE employees SET pin_hash = NULL WHERE id = ?').run(employeeId);
    return;
  }
  if (!/^\d{4,8}$/.test(clean)) {
    throw Object.assign(new Error('PIN must be 4 to 8 digits'), { status: 400 });
  }
  db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hash(clean), employeeId);
}

// --- route guards ----------------------------------------------------------

/** Attach req.user from the session on every request. */
function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  if (id) {
    const u = db.prepare(
      `SELECT e.id, e.emp_code, e.name, e.email, e.role, e.department_id,
              e.shift_id, e.active, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`).get(id);
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
function canViewEmployee(user, employeeId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (Number(user.id) === Number(employeeId)) return true;
  if (user.role === 'manager') {
    const row = db.prepare('SELECT manager_id FROM employees WHERE id = ?').get(employeeId);
    return !!row && Number(row.manager_id) === Number(user.id);
  }
  return false;
}

module.exports = {
  hash, verify, authenticate, authenticatePin, setPassword, setPin,
  loadUser, requireLogin, requireRole, canViewEmployee,
};
