'use strict';
const express = require('express');
const { requireLogin, canViewEmployee } = require('../auth');
const svc = require('../lib/service');
const { monthBounds, addDays } = require('../lib/dates');

const router = express.Router();

/** Employee home: punch button plus this month at a glance. */
router.get('/', requireLogin, (req, res) => {
  const state = svc.punchState(req.user.id);
  // punchState already resolved which night this employee is on; the summary
  // row must match it, or at 01:00 a working employee is told they have not
  // checked in.
  const workDate = state.workDate;
  const { from, to } = monthBounds(workDate);
  const mine = svc.employeeDays(req.user.id, from, to);
  const todayDay = mine.days.find((d) => d.date === workDate);

  res.render('home', {
    title: 'My attendance',
    state,
    todayDay,
    days: [...mine.days].filter((d) => d.date <= workDate).reverse(),
    totals: mine.totals,
    employee: mine.employee,
    selfEntryOpen: svc.selfEntryWindow().enabled,
    month: from,
  });
});

/** Self check-in / check-out. */
router.post('/punch', requireLogin, (req, res) => {
  try {
    const r = svc.recordPunch({
      employeeId: req.user.id,
      kind: req.body.kind || null,
      source: 'web',
      actorId: req.user.id,
    });
    res.flash('ok', r.kind === 'in'
      ? `Checked in at ${r.punched_at.slice(11, 16)}.`
      : `Checked out at ${r.punched_at.slice(11, 16)}. Have a good evening.`);
  } catch (e) {
    res.flash('err', e.message);
  }
  res.redirect('/');
});

// ---------------------------------------------------------------------------
// Filling in past timings
// ---------------------------------------------------------------------------
// Employees may record their own times for nights inside the open backfill
// window. This is a deliberate, closable amnesty so the history can be
// completed by the people who actually know it; every entry is written with
// source 'self' and lands in the audit trail under their name.

router.get('/my/timings', requireLogin, (req, res) => {
  const data = svc.selfEntryNights(req.user.id);
  res.render('my-timings', {
    title: 'Fill in my timings',
    window: data.window,
    nights: data.nights,
    employee: data.employee || null,
    shift: req.user.shift_id ? svc.getShift(req.user.shift_id) : null,
  });
});

router.post('/my/timings', requireLogin, (req, res) => {
  const workDate = String(req.body.work_date || '');
  try {
    svc.recordSelfEntry({
      employeeId: req.user.id,
      workDate,
      inTime: String(req.body.in_time || '').trim(),
      outTime: String(req.body.out_time || '').trim(),
      note: req.body.note,
      actorId: req.user.id,
    });
    res.flash('ok', `Times saved for ${workDate}.`);
  } catch (e) {
    res.flash('err', e.message);
  }
  res.redirect('/my/timings');
});

/**
 * One employee's month. Employees reach their own; managers reach their team;
 * admins reach anyone.
 */
router.get('/employee/:id', requireLogin, (req, res, next) => {
  const id = Number(req.params.id);
  if (!canViewEmployee(req.user, id)) {
    return res.status(403).render('error', {
      title: 'Not allowed',
      message: 'You can only view your own attendance.',
    });
  }
  const month = /^\d{4}-\d{2}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : svc.employeeBusinessDate(id);
  const { from, to } = monthBounds(month);
  const data = svc.employeeDays(id, from, to);
  if (!data) return next();

  res.render('employee-month', {
    title: `${data.employee.name} - attendance`,
    data,
    from,
    to,
    prevMonth: addDays(from, -1),
    nextMonth: addDays(to, 1),
    canEdit: req.user.role === 'admin',
  });
});

module.exports = router;
