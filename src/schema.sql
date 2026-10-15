PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Org structure
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A shift defines the rules used to judge a day's attendance.
-- All *_time values are local wall-clock "HH:MM".
CREATE TABLE IF NOT EXISTS shifts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL UNIQUE,
  start_time          TEXT    NOT NULL,          -- e.g. "09:00"
  end_time            TEXT    NOT NULL,          -- e.g. "18:00"
  -- Minutes after start_time that are forgiven before a punch counts as late.
  grace_minutes       INTEGER NOT NULL DEFAULT 10,
  -- Unpaid break deducted from worked time.
  break_minutes       INTEGER NOT NULL DEFAULT 60,
  -- The break is only deducted once worked time passes this point. Without it,
  -- a 3-hour half day would be charged a full lunch break nobody took.
  break_after_minutes INTEGER NOT NULL DEFAULT 360,
  -- A day with less worked time than this is a half day.
  half_day_minutes    INTEGER NOT NULL DEFAULT 240,
  -- A day with less worked time than this is absent despite having punches.
  min_present_minutes INTEGER NOT NULL DEFAULT 60,
  -- Worked minutes beyond this count as overtime.
  overtime_after_minutes INTEGER NOT NULL DEFAULT 480,
  -- Overtime shorter than this is ignored (avoids crediting 3-minute overruns).
  overtime_grace_minutes INTEGER NOT NULL DEFAULT 15,
  -- Comma-separated ISO weekday numbers that are non-working. 1=Mon .. 7=Sun
  weekly_off          TEXT    NOT NULL DEFAULT '6,7',
  -- Shift that ends past midnight (end_time <= start_time) spans two dates.
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code       TEXT    NOT NULL UNIQUE,        -- payroll / badge id
  name           TEXT    NOT NULL,
  email          TEXT    UNIQUE,                 -- login id; NULL = kiosk-only staff
  password_hash  TEXT,
  pin_hash       TEXT,                           -- kiosk PIN
  role           TEXT    NOT NULL DEFAULT 'employee'
                 CHECK (role IN ('admin','manager','employee')),
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  shift_id       INTEGER REFERENCES shifts(id)      ON DELETE SET NULL,
  manager_id     INTEGER REFERENCES employees(id)   ON DELETE SET NULL,
  joined_on      TEXT    NOT NULL DEFAULT (date('now')),
  -- Inactive staff keep their history but cannot punch or log in.
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_dept   ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(active);

-- ---------------------------------------------------------------------------
-- Attendance facts
-- ---------------------------------------------------------------------------
-- Punches are the source of truth and are never updated in place; corrections
-- are new punches or an explicit admin edit that records who changed it.
CREATE TABLE IF NOT EXISTS punches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Local wall-clock "YYYY-MM-DD HH:MM:SS". Stored local, not UTC, because
  -- shift rules are expressed in local time and the org is single-timezone.
  punched_at   TEXT    NOT NULL,
  -- The business date this punch is attributed to. For overnight shifts this
  -- can differ from date(punched_at), so it is stored rather than derived.
  work_date    TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('in','out')),
  -- 'self' is a punch the employee added for a past night themselves, which
  -- is deliberately distinguishable from one recorded live at the time.
  source       TEXT    NOT NULL DEFAULT 'web'
               CHECK (source IN ('web','kiosk','admin','import','self')),
  note         TEXT,
  created_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_punches_emp_date ON punches(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_punches_date     ON punches(work_date);

-- Day-level overrides let HR mark leave/holiday or pin a status that the
-- punch data alone would not produce. Absence of a row means "derive it".
CREATE TABLE IF NOT EXISTS day_overrides (
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date    TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN
                 ('present','late','half_day','absent','leave','holiday','weekly_off')),
  note         TEXT,
  set_by       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  set_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS holidays (
  work_date  TEXT PRIMARY KEY,
  name       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Plumbing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  -- The actor's name as it was at the time. actor_id goes NULL when the
  -- employee row is deleted, so without this an audit trail would forget who
  -- made a correction as soon as that person left the company - exactly when
  -- a payroll dispute is most likely to need it.
  actor_name  TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
