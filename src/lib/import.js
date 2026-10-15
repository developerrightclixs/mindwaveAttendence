'use strict';
/**
 * Bulk employee import from pasted CSV.
 *
 * Onboarding is the one moment this system asks for a lot of typing, and the
 * data almost always already exists in a spreadsheet. This parses that paste,
 * validates every row, and reports problems per row rather than failing the
 * whole batch on one bad cell - so HR can fix three rows instead of re-doing
 * fifty.
 *
 * Nothing here writes to the database. `plan()` produces a preview that the
 * route renders, and only an explicit commit applies it.
 */
const { isoDate } = require('./dates');

// Accepted header spellings -> canonical field. Deliberately forgiving,
// because these headers come from whatever the HR spreadsheet already says.
const HEADER_ALIASES = {
  code: 'emp_code', emp_code: 'emp_code', employee_code: 'emp_code',
  employeecode: 'emp_code', employee_id: 'emp_code', id: 'emp_code',
  badge: 'emp_code', badge_no: 'emp_code',

  name: 'name', full_name: 'name', fullname: 'name',
  employee_name: 'name', employee: 'name',

  email: 'email', work_email: 'email', mail: 'email',

  department: 'department', dept: 'department', team: 'department',

  shift: 'shift', shift_name: 'shift',

  role: 'role', access: 'role',

  manager: 'manager', manager_code: 'manager', reports_to: 'manager',

  joined_on: 'joined_on', joined: 'joined_on', join_date: 'joined_on',
  joining_date: 'joined_on', doj: 'joined_on', start_date: 'joined_on',

  pin: 'pin', kiosk_pin: 'pin',

  password: 'password',
};

const KNOWN_FIELDS = [
  'emp_code', 'name', 'email', 'department', 'shift', 'role',
  'manager', 'joined_on', 'pin', 'password',
];

const normaliseHeader = (h) => String(h || '')
  .replace(/^﻿/, '')
  .trim()
  .toLowerCase()
  .replace(/[\s.\-/]+/g, '_');

/** Tab or semicolon if the header line uses more of them than commas. */
function pickDelimiter(src) {
  const firstLine = src.split('\n', 1)[0] || '';
  const count = (ch) => (firstLine.split(ch).length - 1);
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * Minimal RFC4180-ish CSV reader: quoted fields, doubled quotes inside them,
 * and comma, tab or semicolon delimiters (a paste out of Excel is tabs).
 */
function splitRows(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const delimiter = pickDelimiter(src);
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);

  // Drop blank lines, including the one a trailing newline produces.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Map the header row to canonical field names. */
function readHeader(cells) {
  const fields = [];
  const unknown = [];
  for (const cell of cells) {
    const key = normaliseHeader(cell);
    const field = HEADER_ALIASES[key];
    fields.push(field || null);
    if (!field && key) unknown.push(String(cell).trim());
  }
  return { fields, unknown };
}

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DMY_RE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/;

/** Accept YYYY-MM-DD and DD/MM/YYYY; reject anything else rather than guess. */
function parseJoinedOn(raw) {
  const s = String(raw || '').trim();
  if (!s) return { value: null };
  const pad = (n) => String(n).padStart(2, '0');

  let m = DATE_RE.exec(s);
  if (m) {
    const iso = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    return isRealDate(iso) ? { value: iso } : { error: `"${s}" is not a real date` };
  }
  m = DMY_RE.exec(s);
  if (m) {
    const iso = `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return isRealDate(iso)
      ? { value: iso }
      : { error: `"${s}" is not a real date (read as day/month/year)` };
  }
  return { error: `joining date "${s}" must be YYYY-MM-DD or DD/MM/YYYY` };
}

function isRealDate(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** A readable PIN that is not sequential or a date-like 4 digits. */
function generatePin(rand = Math.random) {
  for (;;) {
    const pin = String(Math.floor(rand() * 9000) + 1000);
    if (/^(\d)\1{3}$/.test(pin)) continue;        // 1111
    if ('0123456789'.includes(pin)) continue;     // 1234, 2345 ...
    return pin;
  }
}

/**
 * Turn pasted text into a validated plan.
 *
 * @param {string} text        the pasted CSV
 * @param {object} ctx
 * @param {Array}  ctx.departments  [{id, name}]
 * @param {Array}  ctx.shifts       [{id, name}]
 * @param {Set}    ctx.existingCodes employee codes already in the database
 * @param {Set}    ctx.existingEmails emails already in the database
 * @param {number} [ctx.defaultShiftId] shift for rows that name none
 * @param {Function} [ctx.rand]     injectable randomness for tests
 */
function plan(text, ctx) {
  const {
    departments = [], shifts = [], existingCodes = new Set(),
    existingEmails = new Set(), defaultShiftId = null, rand = Math.random,
  } = ctx || {};

  const rows = splitRows(text);
  if (!rows.length) {
    return { ok: false, fatal: 'Nothing to import - paste some rows first.', items: [] };
  }

  const { fields, unknown } = readHeader(rows[0]);
  if (!fields.includes('name')) {
    return {
      ok: false,
      items: [],
      fatal: 'No "name" column found. The first row must be a header row, and '
        + 'one column must be the employee name. Recognised headers include: '
        + KNOWN_FIELDS.join(', ') + '.',
    };
  }

  // Name lookups are case- and space-insensitive; HR spreadsheets are not tidy.
  const key = (s) => String(s || '').trim().toLowerCase();
  const deptByName = new Map(departments.map((d) => [key(d.name), d]));
  const shiftByName = new Map(shifts.map((s) => [key(s.name), s]));

  const items = [];
  const seenCodes = new Set();
  const seenEmails = new Set();
  // Codes claimed by earlier rows count as taken, so two blank-code rows do
  // not both generate the same auto code.
  const takenCodes = new Set([...existingCodes].map(key));

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (field) => {
      const i = fields.indexOf(field);
      return i === -1 ? '' : String(cells[i] == null ? '' : cells[i]).trim();
    };

    const errors = [];
    const notes = [];

    const name = get('name');
    if (!name) {
      items.push({ line: r + 1, skip: true, errors: ['No name in this row'], raw: cells });
      continue;
    }

    // --- code ---
    let code = get('emp_code');
    if (!code) {
      code = autoCode(name, takenCodes);
      notes.push(`code auto-assigned: ${code}`);
    }
    if (takenCodes.has(key(code)) || seenCodes.has(key(code))) {
      errors.push(`employee code "${code}" already exists`);
    }

    // --- email ---
    const email = get('email') || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`"${email}" is not a valid email`);
    } else if (email) {
      const k = key(email);
      if (existingEmails.has(k) || seenEmails.has(k)) {
        errors.push(`email "${email}" is already in use`);
      }
    }

    // --- password ---
    let password = get('password') || null;
    if (email && !password) {
      // A login with no password cannot sign in, so make one and surface it
      // rather than silently creating an unusable account.
      password = generatePin(rand) + generatePin(rand);
      notes.push('password generated - give it to them to change');
    }
    if (password && password.length < 8) {
      errors.push('password must be at least 8 characters');
    }
    if (password && !email) {
      notes.push('password ignored - no email to sign in with');
      password = null;
    }

    // --- pin ---
    let pin = get('pin') || null;
    if (pin && !/^\d{4,8}$/.test(pin)) {
      errors.push(`PIN "${pin}" must be 4 to 8 digits`);
      pin = null;
    }
    let pinGenerated = false;
    if (!pin) {
      pin = generatePin(rand);
      pinGenerated = true;
    }

    // --- department ---
    const deptName = get('department');
    let department = null;
    if (deptName) {
      department = deptByName.get(key(deptName)) || null;
      if (!department) notes.push(`department "${deptName}" will be created`);
    }

    // --- shift ---
    const shiftName = get('shift');
    let shift = null;
    if (shiftName) {
      shift = shiftByName.get(key(shiftName)) || null;
      if (!shift) errors.push(`no shift named "${shiftName}" - create it first`);
    } else if (defaultShiftId) {
      shift = shifts.find((s) => s.id === Number(defaultShiftId)) || null;
      if (shift) notes.push(`shift defaulted to ${shift.name}`);
    } else {
      notes.push('no shift - the 09:00-18:00 defaults will apply');
    }

    // --- role ---
    const roleRaw = key(get('role'));
    let role = 'employee';
    if (roleRaw) {
      if (['admin', 'manager', 'employee'].includes(roleRaw)) {
        role = roleRaw;
      } else {
        errors.push(`role "${get('role')}" must be admin, manager or employee`);
      }
    }
    if (role !== 'employee' && !email) {
      errors.push(`a ${role} needs an email to sign in with`);
    }

    // --- joined on ---
    const jo = parseJoinedOn(get('joined_on'));
    if (jo.error) errors.push(jo.error);
    const joinedOn = jo.value || isoDate();

    items.push({
      line: r + 1,
      skip: false,
      errors,
      notes,
      emp_code: code,
      name,
      email,
      password,
      pin,
      pinGenerated,
      role,
      joined_on: joinedOn,
      departmentName: deptName || null,
      departmentId: department ? department.id : null,
      shiftId: shift ? shift.id : null,
      shiftName: shift ? shift.name : null,
      managerCode: get('manager') || null,
    });

    if (!errors.length) {
      seenCodes.add(key(code));
      takenCodes.add(key(code));
      if (email) seenEmails.add(key(email));
    }
  }

  // Manager references are resolved against both the file and the database,
  // so a spreadsheet can introduce a manager and their reports in one go.
  const codesInFile = new Set(items.filter((i) => !i.skip).map((i) => key(i.emp_code)));
  for (const it of items) {
    if (it.skip || !it.managerCode) continue;
    const mk = key(it.managerCode);
    if (!codesInFile.has(mk) && !takenCodes.has(mk) && !existingCodes.has(it.managerCode)) {
      it.notes.push(`manager "${it.managerCode}" not found - left unassigned`);
      it.managerCode = null;
    }
  }

  const valid = items.filter((i) => !i.skip && !i.errors.length);
  const bad = items.filter((i) => i.skip || i.errors.length);

  return {
    ok: valid.length > 0 && bad.length === 0,
    items,
    valid,
    bad,
    unknownHeaders: unknown,
    newDepartments: [...new Set(
      valid.filter((i) => i.departmentName && !i.departmentId)
        .map((i) => i.departmentName),
    )],
  };
}

// Connector particles carry no initial. Without this, "Sabih Ul Ebad" becomes
// SUE and "Abd ur Rehman" becomes AUR - the particle crowds out the real name.
const NAME_PARTICLES = new Set([
  'ul', 'ur', 'us', 'ud', 'uz', 'al', 'el', 'bin', 'ibn', 'bint', 'binte',
  'van', 'von', 'de', 'da', 'del', 'della', 'di', 'du', 'la', 'le', 'the',
]);

/** Code from a person's initials plus a number, avoiding anything taken. */
function autoCode(name, taken) {
  const words = String(name).trim().split(/\s+/)
    .filter((w) => w && !NAME_PARTICLES.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  const initials = words
    .map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3)
    || 'EMP';
  for (let n = 1; n < 10000; n++) {
    const code = `${initials}${String(n).padStart(3, '0')}`;
    if (!taken.has(code.toLowerCase())) return code;
  }
  return `EMP${Date.now()}`;
}

module.exports = {
  plan, splitRows, pickDelimiter, readHeader, normaliseHeader,
  parseJoinedOn, generatePin, autoCode, KNOWN_FIELDS, HEADER_ALIASES,
  NAME_PARTICLES,
};
