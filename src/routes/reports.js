'use strict';
const express = require('express');
const { requireRole } = require('../auth');
const svc = require('../lib/service');
const { monthBounds, addDays, prettyDate, formatDuration } = require('../lib/dates');

const router = express.Router();
router.use(requireRole('manager'));

const hours = (mins) => (mins / 60).toFixed(2);

/**
 * Quote a CSV field.
 *
 * A leading =, +, - or @ makes Excel treat the text as a formula, so such a
 * value is prefixed with a single quote. Employee names and notes are free
 * text that ends up in spreadsheets sent around the company.
 */
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const csvRow = (cells) => cells.map(csvCell).join(',');

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 names correctly.
  res.send('﻿' + rows.map(csvRow).join('\r\n') + '\r\n');
}

/** Monthly summary, one row per employee. */
router.get('/monthly', (req, res) => {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : svc.currentBusinessDate();
  const departmentId = req.query.dept ? Number(req.query.dept) : null;
  // A manager only ever sees their own team.
  const managerId = req.user.role === 'manager' ? req.user.id : null;

  const { from, to } = monthBounds(month);
  const employees = svc.listEmployees({ departmentId, managerId });
  const rows = employees.map((e) => {
    const r = svc.employeeDays(e.id, from, to);
    return { employee: e, totals: r.totals };
  });

  if (req.query.format === 'csv') {
    const out = [[
      'Employee code', 'Name', 'Department', 'Shift',
      'Payable days', 'Present', 'Late', 'Half days', 'Absent', 'Leave',
      'Holidays', 'Weekly offs',
      'Worked hours', 'Expected hours', 'Overtime hours',
      'Late minutes', 'Early-exit minutes', 'Days needing attention',
    ]];
    for (const r of rows) {
      out.push([
        r.employee.emp_code, r.employee.name,
        r.employee.department_name || '', r.employee.shift_name || '',
        r.totals.payableDays, r.totals.present, r.totals.late, r.totals.halfDay,
        r.totals.absent, r.totals.leave, r.totals.holiday, r.totals.weeklyOff,
        hours(r.totals.workedMinutes), hours(r.totals.expectedMinutes),
        hours(r.totals.overtimeMinutes),
        r.totals.lateMinutes, r.totals.earlyMinutes, r.totals.problemDays,
      ]);
    }
    return sendCsv(res, `attendance-${from.slice(0, 7)}.csv`, out);
  }

  res.render('reports/monthly', {
    title: 'Monthly report',
    rows,
    from,
    to,
    month: from,
    prevMonth: addDays(from, -1),
    nextMonth: addDays(to, 1),
    departments: svc.listDepartments(),
    departmentId,
  });
});

/** Full punch-level detail for one month - what payroll queries get audited against. */
router.get('/detail', (req, res) => {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : svc.currentBusinessDate();
  const { from, to } = monthBounds(month);
  const managerId = req.user.role === 'manager' ? req.user.id : null;
  const employees = svc.listEmployees({ managerId });

  const out = [[
    'Employee code', 'Name', 'Date', 'Weekday', 'Shift', 'Status',
    'First in', 'Last out', 'Worked hours', 'Break minutes',
    'Late minutes', 'Early-exit minutes', 'Overtime hours',
    'Day credit', 'Note', 'Data problems',
  ]];
  for (const e of employees) {
    const r = svc.employeeDays(e.id, from, to);
    for (const d of r.days) {
      if (d.status === 'not_employed' || d.status === 'upcoming') continue;
      out.push([
        e.emp_code, e.name, d.date, prettyDate(d.date).split(',')[0],
        d.shiftName, d.statusLabel,
        d.firstInClock || '', d.lastOutClock || '',
        hours(d.workedMinutes), d.breakMinutes,
        d.lateMinutes, d.earlyMinutes, hours(d.overtimeMinutes),
        d.dayCredit, d.note || '', d.problems.join('; '),
      ]);
    }
  }
  sendCsv(res, `attendance-detail-${from.slice(0, 7)}.csv`, out);
});

/** Everything wrong with the month, so HR can fix it before payroll runs. */
router.get('/exceptions', (req, res) => {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : svc.currentBusinessDate();
  const { from, to } = monthBounds(month);
  const managerId = req.user.role === 'manager' ? req.user.id : null;
  const employees = svc.listEmployees({ managerId });
  // The night in progress is not yet an exception: an open check-in at 01:00
  // is someone at work, not a missing punch.
  const today = svc.currentBusinessDate();

  const items = [];
  for (const e of employees) {
    const r = svc.employeeDays(e.id, from, to);
    for (const d of r.days) {
      // Today is still in progress; an open check-in is not yet a problem.
      if (d.date >= today) continue;
      if (d.problems.length) {
        items.push({ employee: e, day: d, kind: 'data', detail: d.problems.join('; ') });
      } else if (d.status === 'absent' && !d.isOff) {
        items.push({ employee: e, day: d, kind: 'absent', detail: 'No attendance recorded' });
      } else if (d.lateMinutes >= 30) {
        items.push({
          employee: e, day: d, kind: 'late',
          detail: `${formatDuration(d.lateMinutes)} late`,
        });
      }
    }
  }
  items.sort((a, b) => (a.day.date < b.day.date ? 1 : -1));

  res.render('reports/exceptions', {
    title: 'Exceptions',
    items,
    month: from,
    from,
    to,
    prevMonth: addDays(from, -1),
    nextMonth: addDays(to, 1),
  });
});

module.exports = router;
