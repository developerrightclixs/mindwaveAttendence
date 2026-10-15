'use strict';
const express = require('express');
const { authenticate, setPassword, verify } = require('../auth');
const { one, audit } = require('../db');

const router = express.Router();

/** Only allow redirects back to our own paths. */
function safeNext(next) {
  return typeof next === 'string' && /^\/[^/\\]/.test(next) ? next : '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, email: '', next: req.query.next || '' });
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
    });
  }
  // New session id on login so a fixated pre-login cookie cannot be reused.
  const target = safeNext(req.body.next);
  req.session.regenerate(async (err) => {
    if (err) throw err;
    req.session.userId = emp.id;
    await audit(emp.id, 'login.ok', null, null);
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
