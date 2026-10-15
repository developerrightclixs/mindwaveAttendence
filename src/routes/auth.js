'use strict';
const express = require('express');
const { authenticate, setPassword, verify } = require('../auth');
const { one, audit } = require('../db');

const router = express.Router();

// Kept in step with the cookie default in server.js.
const REMEMBER_DAYS = Number(process.env.REMEMBER_ME_DAYS || 30);

/** Only allow redirects back to our own paths. */
function safeNext(next) {
  return typeof next === 'string' && /^\/[^/\\]/.test(next) ? next : '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', {
    title: 'Sign in', error: null, email: '', remember: false,
    next: req.query.next || '',
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const emp = await authenticate(email, password);
  if (!emp) {
    await audit(null, 'login.fail', String(email || '').slice(0, 120), null);
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Wrong email or password.',
      email: String(email || ''),
      next: req.body.next || '',
      remember: !!req.body.remember,
    });
  }
  // New session id on login so a fixated pre-login cookie cannot be reused.
  const target = safeNext(req.body.next);
  const remember = !!req.body.remember;

  req.session.regenerate(async (err) => {
    if (err) throw err;
    req.session.userId = emp.id;
    if (remember) {
      // Stored on the session, so `rolling` keeps renewing this longer window
      // rather than snapping back to the default on the next request.
      req.session.remember = true;
      req.session.cookie.maxAge = REMEMBER_DAYS * 24 * 60 * 60 * 1000;
    }
    await audit(emp.id, 'login.ok', null, remember ? 'remembered on this device' : null);
    res.redirect(emp.role === 'employee' ? target : (target === '/' ? '/admin' : target));
  });
});

router.post('/logout', (req, res) => {
  const id = req.user && req.user.id;
  req.session.destroy(async () => {
    if (id) await audit(id, 'logout', null, null);
    res.redirect('/login');
  });
});

router.get('/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('password', { title: 'Change password', error: null });
});

router.post('/password', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { current, next: newPass, confirm } = req.body;
  const row = await one('SELECT password_hash FROM employees WHERE id = ?', req.user.id);

  const fail = (error) => res.status(400).render('password', {
    title: 'Change password', error,
  });

  if (!verify(current, row.password_hash)) return fail('Your current password is wrong.');
  if (!newPass || String(newPass).length < 8) {
    return fail('The new password must be at least 8 characters.');
  }
  if (newPass !== confirm) return fail('The two new passwords do not match.');

  await setPassword(req.user.id, newPass);
  await audit(req.user.id, 'password.change', null, null);
  res.flash('ok', 'Password changed.');
  res.redirect('/');
});

module.exports = router;
