'use strict';
/**
 * The entrance kiosk: a shared tablet or PC that nobody is logged into.
 *
 * Deliberately not session-authenticated - the whole point is that anyone can
 * walk up to it. The employee code plus a PIN is the credential, and the page
 * never lists employees or reveals whether a code exists, so it cannot be used
 * to enumerate staff. It must only be reachable on the office network.
 */
const express = require('express');
const {
  authenticatePin, kioskPassphraseSet, kioskDeviceUnlocked,
  unlockKioskDevice, checkKioskPassphrase, kioskNeedsSetup,
} = require('../auth');
const svc = require('../lib/service');
const { prettyDate } = require('../lib/dates');

const router = express.Router();

// A wrong PIN is cheap to retry on a touchscreen, so throttle per employee
// code. In-memory is right here: a restart clearing the counters is harmless,
// and this never runs as more than one process.
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 2 * 60 * 1000;

function throttleCheck(code) {
  const rec = attempts.get(code);
  if (!rec) return null;
  if (Date.now() - rec.first > LOCKOUT_MS) {
    attempts.delete(code);
    return null;
  }
  if (rec.count >= MAX_ATTEMPTS) {
    const wait = Math.ceil((LOCKOUT_MS - (Date.now() - rec.first)) / 1000);
    return `Too many wrong PINs. Try again in ${wait} seconds, or see HR.`;
  }
  return null;
}

function throttleFail(code) {
  const rec = attempts.get(code);
  if (!rec || Date.now() - rec.first > LOCKOUT_MS) {
    attempts.set(code, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

// Device lock. When a passphrase is set, this tablet must be unlocked once
// before anybody can punch from it - the difference between a shared screen
// inside the office and an open punch endpoint on the internet.
async function render(res, extra) {
  res.render('kiosk', {
    title: 'Attendance kiosk',
    layout: false,
    error: null,
    result: null,
    locked: false,
    needsSetup: await kioskNeedsSetup(),
    date: prettyDate(await svc.currentBusinessDate()),
    ...extra,
  });
}

router.use(async (req, res, next) => {
  if (req.path === '/unlock' || await kioskDeviceUnlocked(req)) return next();
  return render(res, { locked: true });
});

router.post('/unlock', async (req, res) => {
  if (!(await kioskPassphraseSet())) return res.redirect('/kiosk');
  if (!(await checkKioskPassphrase(req.body.passphrase))) {
    return render(res, { locked: true, error: 'That passphrase is not right.' });
  }
  await unlockKioskDevice(res, process.env.SECURE_COOKIES === '1');
  res.redirect('/kiosk');
});

router.get('/', (req, res) => render(res, {}));

router.post('/', async (req, res) => {
  const code = String(req.body.emp_code || '').trim();
  const pin = String(req.body.pin || '').trim();

  const show = (error, result) => render(res, { error, result });

  const locked = throttleCheck(code.toLowerCase());
  if (locked) return show(locked, null);

  const emp = await authenticatePin(code, pin);
  if (!emp) {
    throttleFail(code.toLowerCase());
    // One message for a bad code and a bad PIN, so the kiosk cannot be used
    // to discover which employee codes are real.
    return show('That employee code and PIN do not match.', null);
  }

  attempts.delete(code.toLowerCase());

  try {
    const r = await svc.recordPunch({
      employeeId: emp.id,
      source: 'kiosk',
      actorId: emp.id,
    });
    const state = await svc.employeeDays(emp.id, r.work_date, r.work_date);
    return show(null, {
      name: emp.name,
      kind: r.kind,
      time: r.punched_at.slice(11, 16),
      worked: state ? state.days[0].workedMinutes : 0,
      late: state ? state.days[0].lateMinutes : 0,
    });
  } catch (e) {
    return show(e.message, null);
  }
});

module.exports = router;
