'use strict';
const test = require('node:test');
const assert = require('node:assert');
const imp = require('./import');

const CTX = {
  departments: [{ id: 1, name: 'Engineering' }, { id: 2, name: 'Sales' }],
  shifts: [{ id: 10, name: 'General' }, { id: 11, name: 'Night' }],
  existingCodes: new Set(['MW001']),
  existingEmails: new Set(['taken@x.com']),
  rand: () => 0.5,                       // deterministic generated PINs
};

const plan = (text, extra = {}) => imp.plan(text, { ...CTX, ...extra });

// --- delimiters and quoting ------------------------------------------------

test('comma, tab and semicolon delimiters are all detected', () => {
  assert.equal(imp.pickDelimiter('a,b,c'), ',');
  assert.equal(imp.pickDelimiter('a\tb\tc'), '\t');
  assert.equal(imp.pickDelimiter('a;b;c'), ';');
});

test('quoted fields keep their commas', () => {
  const rows = imp.splitRows('name,dept\n"Khan, Sabih",Engineering');
  assert.deepEqual(rows[1], ['Khan, Sabih', 'Engineering']);
});

test('doubled quotes inside a quoted field unescape', () => {
  const rows = imp.splitRows('name\n"He said ""hi"""');
  assert.equal(rows[1][0], 'He said "hi"');
});

test('blank lines and a trailing newline are ignored', () => {
  const rows = imp.splitRows('name\nAyesha\n\n\n');
  assert.equal(rows.length, 2);
});

test('an Excel tab paste parses', () => {
  const r = plan('Name\tEmail\tDepartment\nAyesha Siddiqui\taye@x.com\tEngineering');
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].name, 'Ayesha Siddiqui');
  assert.equal(r.valid[0].departmentId, 1);
});

// --- headers ---------------------------------------------------------------

test('header aliases and odd spacing are accepted', () => {
  const r = plan('Employee Code,Full Name,Work Email,Dept,Shift Name,DOJ\n'
    + 'MW900,Bilal Ahmed,bilal@x.com,Sales,Night,2026-03-01');
  const row = r.valid[0];
  assert.equal(row.emp_code, 'MW900');
  assert.equal(row.name, 'Bilal Ahmed');
  assert.equal(row.email, 'bilal@x.com');
  assert.equal(row.departmentId, 2);
  assert.equal(row.shiftId, 11);
  assert.equal(row.joined_on, '2026-03-01');
});

test('a missing name column is a fatal error, not a silent import', () => {
  const r = plan('code,email\nMW900,a@x.com');
  assert.equal(r.ok, false);
  assert.match(r.fatal, /name/i);
  assert.equal(r.items.length, 0);
});

test('unrecognised headers are reported but do not block the import', () => {
  const r = plan('name,favourite colour\nAyesha,blue');
  assert.deepEqual(r.unknownHeaders, ['favourite colour']);
  assert.equal(r.valid.length, 1);
});

// --- codes -----------------------------------------------------------------

test('a blank code is auto-assigned from initials', () => {
  const r = plan('name,code\nAyesha Siddiqui,');
  assert.equal(r.valid[0].emp_code, 'AS001');
  assert.match(r.valid[0].notes.join(' '), /auto-assigned/);
});

test('auto-assigned codes do not collide within one file', () => {
  const r = plan('name\nAyesha Siddiqui\nAhmed Shah');
  assert.equal(r.valid[0].emp_code, 'AS001');
  assert.equal(r.valid[1].emp_code, 'AS002');
});

test('a code already in the database is rejected', () => {
  const r = plan('code,name\nMW001,Someone Else');
  assert.equal(r.bad.length, 1);
  assert.match(r.bad[0].errors.join(' '), /already exists/);
});

test('a code duplicated inside the file is rejected once', () => {
  const r = plan('code,name\nMW900,First Person\nMW900,Second Person');
  assert.equal(r.valid.length, 1);
  assert.equal(r.bad.length, 1);
});

test('code matching ignores case', () => {
  const r = plan('code,name\nmw001,Someone');
  assert.equal(r.bad.length, 1);
});

// --- emails and passwords --------------------------------------------------

test('a malformed email is rejected', () => {
  const r = plan('name,email\nAyesha,not-an-email');
  assert.match(r.bad[0].errors.join(' '), /not a valid email/);
});

test('an email already in use is rejected', () => {
  const r = plan('name,email\nAyesha,taken@x.com');
  assert.match(r.bad[0].errors.join(' '), /already in use/);
});

test('an email with no password gets one generated', () => {
  const r = plan('name,email\nAyesha,aye@x.com');
  const row = r.valid[0];
  assert.ok(row.password && row.password.length >= 8);
  assert.match(row.notes.join(' '), /password generated/);
});

test('a short supplied password is rejected rather than silently padded', () => {
  const r = plan('name,email,password\nAyesha,aye@x.com,short');
  assert.match(r.bad[0].errors.join(' '), /at least 8/);
});

test('a password with no email is dropped, not turned into a login', () => {
  const r = plan('name,password\nZainab,averylongpassword');
  assert.equal(r.valid[0].password, null);
  assert.equal(r.valid[0].email, null);
  assert.match(r.valid[0].notes.join(' '), /ignored/);
});

test('kiosk-only staff need no email at all', () => {
  const r = plan('code,name\nMW905,Zainab Khalid');
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].email, null);
  assert.ok(r.valid[0].pin);
});

// --- PINs ------------------------------------------------------------------

test('a PIN is generated when none is given', () => {
  const r = plan('name\nAyesha');
  assert.match(r.valid[0].pin, /^\d{4}$/);
  assert.equal(r.valid[0].pinGenerated, true);
});

test('a supplied PIN is kept as-is', () => {
  const r = plan('name,pin\nAyesha,4821');
  assert.equal(r.valid[0].pin, '4821');
  assert.equal(r.valid[0].pinGenerated, false);
});

test('a non-numeric PIN is an error', () => {
  const r = plan('name,pin\nAyesha,12ab');
  assert.match(r.bad[0].errors.join(' '), /4 to 8 digits/);
});

test('generated PINs avoid guessable sequences', () => {
  // Walk the generator across the whole random range.
  for (let i = 0; i < 200; i++) {
    const pin = imp.generatePin(() => i / 200);
    assert.ok(!/^(\d)\1{3}$/.test(pin), `repeated digits: ${pin}`);
    assert.ok(!'0123456789'.includes(pin), `sequential: ${pin}`);
  }
});

// --- shifts, departments, roles -------------------------------------------

test('an unknown shift is an error because rules depend on it', () => {
  const r = plan('name,shift\nAyesha,Graveyard');
  assert.match(r.bad[0].errors.join(' '), /no shift named/);
});

test('a new department is flagged for creation rather than rejected', () => {
  const r = plan('name,department\nAyesha,Marketing');
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].departmentId, null);
  assert.deepEqual(r.newDepartments, ['Marketing']);
});

test('department matching ignores case and padding', () => {
  const r = plan('name,department\nAyesha,"  engineering  "');
  assert.equal(r.valid[0].departmentId, 1);
  assert.deepEqual(r.newDepartments, []);
});

test('a default shift is applied to rows that name none', () => {
  const r = plan('name\nAyesha', { defaultShiftId: 10 });
  assert.equal(r.valid[0].shiftId, 10);
  assert.match(r.valid[0].notes.join(' '), /defaulted/);
});

test('an invalid role is rejected', () => {
  const r = plan('name,email,role\nAyesha,a@x.com,supervisor');
  assert.match(r.bad[0].errors.join(' '), /admin, manager or employee/);
});

test('a manager or admin without an email is rejected', () => {
  const r = plan('name,role\nAyesha,manager');
  assert.match(r.bad[0].errors.join(' '), /needs an email/);
});

// --- dates -----------------------------------------------------------------

test('both ISO and day/month/year joining dates are accepted', () => {
  assert.equal(imp.parseJoinedOn('2026-03-05').value, '2026-03-05');
  assert.equal(imp.parseJoinedOn('5/3/2026').value, '2026-03-05');
  assert.equal(imp.parseJoinedOn('05.03.2026').value, '2026-03-05');
});

test('an impossible date is rejected, not rolled over', () => {
  assert.ok(imp.parseJoinedOn('2026-02-30').error);
  assert.ok(imp.parseJoinedOn('32/01/2026').error);
});

test('an unparseable date is reported instead of guessed', () => {
  assert.ok(imp.parseJoinedOn('March 5th').error);
});

test('a blank joining date defaults to today without an error', () => {
  const r = imp.parseJoinedOn('');
  assert.equal(r.value, null);
  assert.equal(r.error, undefined);
});

// --- managers --------------------------------------------------------------

test('a manager introduced in the same file is linked', () => {
  const r = plan('code,name,email,role,manager\n'
    + 'MW910,Big Boss,boss@x.com,manager,\n'
    + 'MW911,Report One,,employee,MW910');
  assert.equal(r.bad.length, 0);
  assert.equal(r.valid[1].managerCode, 'MW910');
});

test('a manager who exists in the database is linked', () => {
  const r = plan('code,name,manager\nMW912,Report Two,MW001');
  assert.equal(r.valid[0].managerCode, 'MW001');
});

test('an unknown manager is dropped with a note, not a failure', () => {
  const r = plan('code,name,manager\nMW913,Report Three,NOPE');
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].managerCode, null);
  assert.match(r.valid[0].notes.join(' '), /not found/);
});

// --- whole-batch behaviour -------------------------------------------------

test('one bad row does not invalidate the good ones', () => {
  const r = plan('code,name,email\n'
    + 'MW920,Good One,good@x.com\n'
    + 'MW921,Bad One,nope\n'
    + 'MW922,Good Two,good2@x.com');
  assert.equal(r.valid.length, 2);
  assert.equal(r.bad.length, 1);
  assert.equal(r.bad[0].line, 3);        // 1-based, counting the header
  assert.equal(r.ok, false);             // but the batch is not clean
});

test('a nameless row is skipped and reported by line number', () => {
  const r = plan('code,name\nMW930,Real Person\nMW931,');
  assert.equal(r.valid.length, 1);
  assert.equal(r.bad[0].line, 3);
  assert.equal(r.bad[0].skip, true);
});

test('a clean batch reports ok', () => {
  const r = plan('code,name\nMW940,One Person\nMW941,Two Person');
  assert.equal(r.ok, true);
  assert.equal(r.valid.length, 2);
});

test('an empty paste is a fatal error', () => {
  assert.equal(plan('').ok, false);
  assert.match(plan('').fatal, /paste/i);
});

test('a header row with no data rows imports nothing and is not ok', () => {
  const r = plan('code,name,email');
  assert.equal(r.ok, false);
  assert.equal(r.valid.length, 0);
});

// --- auto code generation --------------------------------------------------

test('connector particles do not consume an initial', () => {
  // "Ul" is not a name, so the code should come from Sabih + Ebad.
  assert.equal(imp.autoCode('Sabih Ul Ebad', new Set()), 'SE001');
  assert.equal(imp.autoCode('Abd ur Rehman', new Set()), 'AR001');
  assert.equal(imp.autoCode('Muhammad bin Qasim', new Set()), 'MQ001');
  assert.equal(imp.autoCode('Ludwig van Beethoven', new Set()), 'LB001');
});

test('ordinary names are unaffected by particle skipping', () => {
  assert.equal(imp.autoCode('Noman Haider', new Set()), 'NH001');
  assert.equal(imp.autoCode('Taha Aslam', new Set()), 'TA001');
  assert.equal(imp.autoCode('Muhammad Hayyan', new Set()), 'MH001');
});

test('auto codes use at most three initials', () => {
  assert.equal(imp.autoCode('Ahmed Bilal Chaudhry Dar', new Set()), 'ABC001');
});

test('a name made only of particles still yields a usable code', () => {
  assert.equal(imp.autoCode('Ul', new Set()), 'EMP001');
});

test('auto codes step past codes already taken', () => {
  const taken = new Set(['nh001', 'nh002']);
  assert.equal(imp.autoCode('Noman Haider', taken), 'NH003');
});
