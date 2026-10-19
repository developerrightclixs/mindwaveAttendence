# Mindwave Attendance

A self-hosted attendance system for a single-site organisation of up to a few
hundred staff. Employees check in and out from their browser or from a shared
kiosk at the entrance; the system applies shift rules to decide what each day
counts as, and HR exports the month for payroll.

No build step and no CDN. Express and EJS on top of PostgreSQL (Supabase).
The two typefaces (Afacad and Urbanist, both OFL) are self-hosted from
`public/fonts`, so the app and the entrance kiosk render correctly even on a
network with no outside internet access.

## Quick start

```bash
npm install
cp .env.example .env          # then put your Supabase URL in DATABASE_URL
npm run seed                  # creates shifts, departments and an admin account
npm start                     # http://localhost:3000
```

`DATABASE_URL` comes from the Supabase dashboard under
**Project Settings -> Database -> Connection string**. Use the *Session pooler*
URI for a long-running server and the *Transaction pooler* URI on a serverless
host such as Vercel.

To work on it without a database at all:

```bash
npm run dev:memory            # runs against an in-memory Postgres
```

Nothing persists in that mode - it rebuilds the schema on every start - but it
is the whole app, real SQL included.

`npm run seed` creates a first admin account and prints its password once.
Sign in, create your own named admin account, then **delete the seed admin** so
every action in the audit trail carries a real person's name. The seed only
creates one if no admin exists, so it will not come back.

To explore with realistic data first:

```bash
npm run seed -- --demo
```

That adds 10 sample employees and 45 days of punches, including some deliberate
mistakes (forgotten check-outs, late arrivals, a leave day, a holiday) so the
reports and the exceptions screen have something to show. Demo logins use the
password `password123`; kiosk PINs are 1000 + the employee number, so `MW002`
is `1002`.

## Adding your staff

Every person needs one employee record, but the minimum is small: a **name**
and an **employee code**. Email and password are only needed by people who sign
in from a browser; a kiosk-only worker needs just a PIN, which the system can
generate.

For more than a handful of people, don't use the form — paste your existing
spreadsheet into **Employees → Import from spreadsheet** (`/admin/import`).

```csv
code,name,email,department,shift,role,joined_on,manager
MW011,Nadia Qureshi,nadia@yourco.com,Engineering,General (09:00-18:00),manager,2026-01-15,
MW012,Rashid Mehmood,,Operations,Night (22:00-06:00),employee,01/02/2026,MW011
```

Only `name` is required. Headers are matched flexibly (`Employee Code`,
`emp_code`, `Badge No` and `ID` all work; so do `DOJ` and `joined_on`), and a
copy-paste straight out of Excel is fine — tabs, commas and semicolons are all
detected.

The import is a two-step flow: it shows a preview of exactly what will be
created, with per-row problems listed by line number, and writes nothing until
you confirm. It is all-or-nothing — a half-imported staff list is worse than
none, because you cannot tell which rows landed.

What it does for you:

- **Generates employee codes** from initials when the column is blank (`AS001`).
- **Generates kiosk PINs**, avoiding repeated digits and sequences like `1234`.
- **Generates passwords** for anyone given an email but no password, so an
  account that cannot be signed into is never created silently.
- **Creates departments** named in the file that don't exist yet.
- **Links managers** by employee code, including a manager introduced in the
  same file as their reports.
- **Reads both** `YYYY-MM-DD` and `DD/MM/YYYY` joining dates, and rejects
  impossible ones like `2026-02-30` rather than rolling them over.

Unknown shift names are an error rather than a guess, since the shift decides
the late and overtime rules.

Generated PINs and passwords are **shown once** on the confirmation screen —
print or save it there. They are stored hashed and cannot be recovered; reset
them from the employee's edit page instead.

## Letting staff fill in their own past timings

Setup has a switch, **Employee manual entry**, with a start date. While it is
open, staff see *Fill in my timings* on their own page: a list of the nights in
the window that are missing a start or an end time, each with a small form
pre-filled with their shift times.

It exists so a backlog of history can be completed by the people who actually
know it, rather than by HR guessing. It is deliberately a **window you close**,
not a standing permission - an attendance record its own subject can keep
rewriting is no longer evidence. Close it once the backfill is done.

What an employee may do while it is open:

- fill in a night **inside the window** that has no times yet, for themselves only.

What they may not do, enforced server-side:

- change a night that already has times (HR corrects those),
- touch a night HR has already marked (leave, absent, holiday),
- enter anything before the window start or before their joining date,
- enter a night that has not happened yet.

Every entry is written with source `self`, shows a **self-reported** badge on
the register and on their month view, and lands in the audit trail under their
name with whatever reason they gave. So the numbers still carry provenance: you
can always tell which times were captured live at the kiosk and which were
supplied afterwards.

## How attendance is captured

**Browser self-service** — `/` after signing in. One button that checks in or
out depending on your current state. Shows today's status and the month so far.

**Entrance kiosk** — `/kiosk`. A shared tablet or PC that nobody is logged in
to. The employee types their code and PIN; the system records whichever punch
is next for them and clears the screen after a few seconds. Wrong PINs are
throttled per employee code, and a wrong code and a wrong PIN give the same
message so the screen cannot be used to discover who works here.

> The kiosk is deliberately unauthenticated — that is the point of a shared
> device. Only expose it on the office network, never to the internet.

**Employee backfill** — `/my/timings`, when the manual-entry window is open.
Staff complete their own missing nights; see below.

**HR correction** — `/admin/register`. Add a missing punch, delete a wrong one,
or mark a whole day as leave, holiday or absent. Every correction is recorded in
the audit trail with who made it and why.

## How a day is judged

Punches are the source of truth, stored in PostgreSQL. Timestamps are kept as
local wall-clock text rather than `timestamptz`, deliberately: every shift rule
is written in local time ("the shift starts at 20:00"), and an overnight
shift's business date is derived from that same clock. Storing an absolute
instant would mean converting back before every comparison.

Day summaries are **derived on every read**
rather than stored, so changing a shift rule or a holiday immediately corrects
every past day for the affected staff — there is no stale cached total that can
disagree with the punch record.

Each shift defines the thresholds:

| Setting | Meaning |
|---|---|
| Start / end | The scheduled window. An end at or before the start means an overnight shift. |
| Late grace | Arriving within this is not late. Past it, lateness is measured **from the shift start**, not from the end of grace. |
| Unpaid break | Deducted from worked time — but only the part not already taken. Clocking out for a 60-minute lunch is not charged a second 60 minutes. |
| Break applies after | Shorter days are charged no break at all, so a 3-hour half day is not billed a lunch nobody took. |
| Half day under | Worked time below this counts as 0.5 of a payable day. |
| Absent under | Too little worked time to count as attendance at all. |
| Overtime after / grace | Worked minutes beyond the threshold are overtime; overruns shorter than the grace are ignored. |
| Weekly off | Days of the week nobody is expected in. |

Resulting day statuses: `present`, `late`, `half_day`, `absent`, `leave`,
`holiday`, `weekly_off`, plus two that are excluded from every total —
`upcoming` (the date has not happened yet) and `not_employed` (before the
employee's join date).

Rules worth knowing:

- **Future dates are never absences.** A report run mid-month counts only the
  days that have happened.
- **Work on a weekly off or holiday** is credited entirely as overtime and is
  never marked late, since no schedule applied that day.
- **An HR override wins over everything**, including punches.
- **Messy punch streams are reported, not rejected.** A forgotten check-out, a
  double check-in or an orphan check-out produces a flag on the day and appears
  under Exceptions, so it can be fixed before payroll.
- **Overnight shifts** attribute a post-midnight check-out to the previous
  business date, so a 20:00–05:00 shift is one day, not two halves. See
  [Overnight shifts](#overnight-shifts) — this is the organisation's normal
  case.

## Overnight shifts

The organisation's standard shift is **20:00 to 05:00, nine hours, fully paid,
Saturday and Sunday nights off** — so overnight is the normal case here, not an
edge case.

A night crossing midnight touches two calendar dates but is **one business
date: the date the night began.** A shift starting Tuesday 20:00 and ending
Wednesday 05:00 is recorded entirely against Tuesday, and appears as one row on
Tuesday's register rather than two halves.

Which business date a punch belongs to is decided by a cut-over in the middle
of the off-shift gap. For 20:00–05:00 the gap runs 05:00 to 20:00, so the
cut-over is **12:30**:

| Punch at | Belongs to |
|---|---|
| 19:45 (arriving early) | **tonight** |
| 20:00, 23:30 | tonight |
| 00:30, 02:00, 05:00 | the night that started yesterday |
| 05:40 (leaving late) | the night that started yesterday |

The cut-over is deliberately *not* the shift start time. If it were, an
employee clocking in at 19:45 — eight minutes early is ordinary on an 8 PM
shift — would be filed against a shift that had already ended, leaving tonight
looking like an absence and yesterday holding an orphan check-in.

A consequence worth knowing for the weekly off: **"Saturday off" means the
night *starting* Saturday evening.** On Mon–Fri nights with Sat+Sun off, the
working week is five nights: the last one ends Saturday 05:00, and the next
begins Monday 20:00. That is 45 paid hours a week.

Lateness, early exits and overtime are all measured across midnight against the
shift window, so a 20:35 arrival is 35 minutes late and a 07:30 departure earns
2h30m of overtime.

## Roles

| Role | Can see |
|---|---|
| Employee | Only their own attendance. |
| Manager | Themselves plus anyone whose "Reports to" is set to them, and the reports for that team. |
| Admin | Everyone, plus shifts, employees, holidays, corrections and the audit trail. |

The last active admin cannot be demoted, deactivated or deleted, so the system
cannot lock everyone out of its own configuration.

Every correction, login and configuration change is written to the audit trail
with the actor's **name recorded at the time**, not just a reference to their
account. When someone leaves and their account is removed, their past entries
still show who made them, marked `removed` — which is exactly when a payroll
dispute is most likely to need them.

## Reports

- **Monthly** (`/reports/monthly`) — one row per employee: payable days,
  present/late/half/absent counts, worked vs expected hours, overtime.
  Exports to CSV.
- **Day-by-day** (`/reports/detail`) — every employee-day with punch times and
  flags. The CSV that payroll questions get audited against.
- **Exceptions** (`/reports/exceptions`) — missing punches, unexplained
  absences and arrivals 30+ minutes late. Work this list to empty before
  running payroll.

CSV exports are UTF-8 with a BOM so Excel opens names correctly, and any field
starting with `=`, `+`, `-` or `@` is quoted so a name or note can never be
interpreted as a spreadsheet formula.

## Configuration

All optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DB_PATH` | `data/attendance.db` | SQLite file location. |
| `SESSION_SECRET` | generated once, stored in the DB | Session signing key. |
| `SECURE_COOKIES` | off | Set to `1` once TLS terminates in front of the app. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@mindwave.local` / random | Used only by the first `npm run seed`. |

## Running it for real

See **[DEPLOY.md](DEPLOY.md)** for the full go-live procedure: running as a
Windows service, LAN binding, firewall, HTTPS, automatic backups, the kiosk
device, and a first-night checklist.

The short version, and the parts that actually bite:

1. **Run it as a service**, not in a terminal — a terminal dies when you log out.
2. **Pin `HOST` to your office LAN address.** The default binds every interface,
   including any VPN tunnel, and `/kiosk` is intentionally unauthenticated.
3. **Put TLS in front of it** and set `SECURE_COOKIES=1`. Until then passwords
   and PINs cross the network in clear text.
4. **Schedule `npm run backup`** and copy a backup off the machine. It snapshots
   safely while the server runs and verifies the result opens.
5. **Keep the machine awake and keep Windows Update out of the shift window.**
   On a night shift, the default small-hours reboot lands mid-shift.
6. **Check the clock.** The app pins its own timezone (`Asia/Karachi`, or
   `APP_TZ`) rather than inheriting the host's, because a cloud host runs in
   UTC and would shift every check-in by the offset. **Setup → Server clock**
   shows the time it is actually working from.

## Tests

```bash
npm test
```

167 tests. 73 cover the rules engine (break deduction, grace handling, overtime
thresholds, half days, overnight shifts and their work-date attribution, future
dates, malformed punch streams, the monthly rollup), 35 cover self-entry limits
and the night-shift business date, 46 cover the CSV importer (delimiters and
quoting, header aliases, duplicate and auto-generated codes, PIN and password
rules, date formats, manager resolution, and partial-failure handling), 6 pin
the process timezone, including the `TZ=:UTC` a serverless host injects, and 7
hold the per-request memo to its two safety properties - it never outlives a
request, and any write empties it. These are the calculations that end up in
someone's pay and the path that creates staff records, so they are worth
keeping green.

## Layout

```
api/index.js           Vercel entry point (exports the app, never listens)
src/
  server.js            express app, bootstrap gate, sessions, CSRF, error pages
  db.js                PostgreSQL pool, query helpers, schema init
  schema.sql           tables (PostgreSQL)
  seed.js              first-run setup and demo data
  auth.js              password/PIN hashing, login, route guards
  session-store.js     PostgreSQL session store
  lib/
    dates.js           local-time helpers
    attendance.js      the rules engine - the heart of the system
    attendance.test.js its tests
    import.js          CSV staff import: parse, validate, plan
    import.test.js     its tests
    service.js         all attendance reads and writes (async)
  routes/              auth, me, kiosk, admin, reports
  views/               EJS templates
scripts/
  dev-memory.js        run the app on an in-memory Postgres
  export.js            dump every table to JSON
public/app.css         one stylesheet, light and dark
public/theme.js        the light/dark/auto switcher
public/fonts/          self-hosted Afacad + Urbanist (OFL)
data/attendance.db     the database
```

The rules live in `lib/attendance.js` and nowhere else. If a policy changes —
how lateness is measured, when a break applies — that is the only file to edit,
and `attendance.test.js` will tell you what you broke.
