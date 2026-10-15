# Going live

Taking this from "runs in a terminal" to "the team uses it every night".

Everything below assumes the app stays on your office LAN. Do **not** port-forward
it to the internet: `/kiosk` is intentionally unauthenticated, and the app speaks
plain HTTP until you put TLS in front of it (step 4).

---

## 0. Pick the machine

It must be **powered on and awake at 20:00 every working night**, and stay up
until after 05:00. A desktop that sleeps at midnight will take the attendance
system down in the middle of every shift.

```powershell
# Never sleep, never hibernate, screen off is fine
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

Check the clock and timezone. Shift rules are evaluated in local wall-clock
time, so a wrong timezone silently shifts everyone's lateness:

```powershell
Get-TimeZone                      # expect Pakistan Standard Time (UTC+05:00)
w32tm /resync                     # sync with the time server
```

### Keep Windows Update out of your shift

This is the one that will bite a night-shift team. A default Windows box
reboots for updates in the small hours — right through the middle of a shift,
losing check-outs.

```powershell
# Treat 18:00-07:00 as "active hours" so automatic restarts avoid the shift
$k = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
Set-ItemProperty $k SmartActiveHoursState -Value 0 -Type DWord
Set-ItemProperty $k ActiveHoursStart      -Value 18 -Type DWord
Set-ItemProperty $k ActiveHoursEnd        -Value 7  -Type DWord
```

Active hours cap at a 12-hour window, so 18:00–07:00 is the widest useful
setting. Install updates deliberately on a Saturday or Sunday instead.

---

## 1. Decide the bind address

The server binds every interface by default. **If this machine runs a VPN**
(yours has a PIA tunnel up), that exposes the unauthenticated kiosk page
through the tunnel. Pin it to the office LAN instead:

```powershell
ipconfig | Select-String IPv4        # find the Ethernet address
```

On the current machine that is `192.168.18.53` (Ethernet), with
`10.143.2.147` belonging to the VPN adapter — bind the first, not the second.

Create `.env`-style settings as machine environment variables:

| Variable | Value | Why |
|---|---|---|
| `HOST` | `192.168.18.53` | LAN only, not the VPN |
| `PORT` | `3000` | or `80` to drop the `:3000` from URLs |
| `DB_PATH` | `F:\AttandenceManagemtnSyaystem-Mindwave\data\attendance.db` | explicit beats relative |
| `SECURE_COOKIES` | `1` | **only after** step 4 |

A static IP matters: if DHCP moves this machine, every bookmark and the kiosk
break. Reserve it on the router or set it statically.

---

## 2. Run it as a Windows service

A terminal window is not a deployment — it dies when you log out. Use NSSM,
which is the least fragile option on Windows:

```powershell
# Install nssm (or download from https://nssm.cc and unzip)
winget install NSSM.NSSM

$node = (Get-Command node).Source
$app  = 'F:\AttandenceManagemtnSyaystem-Mindwave'

nssm install MindwaveAttendance $node "$app\src\server.js"
nssm set MindwaveAttendance AppDirectory $app
nssm set MindwaveAttendance AppEnvironmentExtra `
  HOST=192.168.18.53 PORT=3000 `
  DB_PATH=$app\data\attendance.db
nssm set MindwaveAttendance Start SERVICE_AUTO_START
nssm set MindwaveAttendance AppStdout $app\logs\service.log
nssm set MindwaveAttendance AppStderr $app\logs\service.log
nssm set MindwaveAttendance AppRotateFiles 1
nssm set MindwaveAttendance AppRotateBytes 10485760

New-Item -ItemType Directory -Force "$app\logs" | Out-Null
nssm start MindwaveAttendance
```

Verify it survives a reboot — this is the step people skip and regret:

```powershell
Restart-Computer
# after it comes back, from another machine:
curl http://192.168.18.53:3000/healthz      # {"ok":true,...}
```

Service controls: `nssm restart MindwaveAttendance`, `nssm stop ...`,
`nssm status ...`, `nssm edit ...`.

---

## 3. Open the firewall to the LAN only

```powershell
New-NetFirewallRule -DisplayName 'Mindwave Attendance' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 `
  -RemoteAddress 192.168.18.0/24 -Profile Private
```

`-RemoteAddress` scopes it to your subnet, so the rule does not also open the
port on any other network the machine joins.

Test from a second machine, not from the server itself — `localhost` working
proves nothing about the LAN:

```powershell
curl http://192.168.18.53:3000/healthz
```

> **Gotcha:** once `HOST` is pinned to the LAN address, `http://localhost:3000`
> on the server itself stops responding — the socket is bound to one interface
> only. That is correct, not a fault. Use the LAN address everywhere, including
> on the server. The startup banner prints the URL that actually works.

---

## 4. HTTPS (do this before real use)

Right now passwords and kiosk PINs cross the network in clear text. Anyone on
the office wifi can read them. Put Caddy in front — it is a single binary and
issues its own trusted certificate for internal names:

```powershell
winget install CaddyServer.Caddy
```

`Caddyfile`:

```
attendance.mindwave.local {
    tls internal
    reverse_proxy 127.0.0.1:3000
}
```

Then:

1. Change the app to `HOST=127.0.0.1` so only Caddy can reach it directly.
2. Set `SECURE_COOKIES=1` and restart the service.
3. Point `attendance.mindwave.local` at the server — a DNS record on your
   router, or a `hosts` entry on each device.
4. Install Caddy's root certificate on every machine and the kiosk tablet, or
   browsers will warn. Caddy writes it to
   `%AppData%\Local\Caddy\pki\authorities\local\root.crt`.

If you already own a real domain, use a normal public certificate instead and
skip the root-certificate distribution entirely.

---

## 5. Automatic backups

The database is one file; losing it loses your attendance history. `npm run
backup` takes a consistent snapshot **while the server is running**, verifies
it opens, and keeps the most recent 30.

```powershell
$app = 'F:\AttandenceManagemtnSyaystem-Mindwave'
$action  = New-ScheduledTaskAction -Execute (Get-Command node).Source `
             -Argument "$app\scripts\backup.js" -WorkingDirectory $app
# 06:00 — after the shift ends, so each backup contains a complete night
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00am
Register-ScheduledTask -TaskName 'MindwaveAttendanceBackup' `
  -Action $action -Trigger $trigger -RunLevel Highest -Force
```

Run it once by hand first, then **copy a backup off this machine** — a backup
sitting on the same disk as the original is not a backup. Each file is
self-contained, so copying the single `.db` is enough.

To restore: stop the service, copy the chosen backup over
`data\attendance.db`, delete any leftover `attendance.db-wal` and
`attendance.db-shm`, start the service.

---

## 6. Set up the kiosk device

On the tablet or PC at the entrance:

1. Open `http://192.168.18.53:3000/kiosk` (or the HTTPS name from step 4).
2. Add it to the home screen / set it as the browser's startup page.
3. Launch the browser in kiosk mode so staff cannot navigate away:
   `msedge.exe --kiosk http://192.168.18.53:3000/kiosk --edge-kiosk-type=fullscreen`
4. Disable sleep on that device too.

The page clears itself a few seconds after each punch, so one person's name is
never left on screen for the next.

---

## Putting it on the internet

### Why not Vercel (or any serverless host)

Vercel runs **stateless functions on a read-only filesystem**. This app is a
single long-lived process that writes continuously to one SQLite file. Deployed
there it fails immediately - `src/db.js` calls `mkdirSync` at startup and gets
`EROFS`, so every route returns `FUNCTION_INVOCATION_FAILED`.

Pointing `DB_PATH` at `/tmp` does not rescue it. `/tmp` is wiped between cold
starts and is not shared between concurrent invocations, so the database would
be recreated empty every few minutes and two simultaneous requests would see
two different databases. An attendance system that silently forgets attendance
is worse than one that is plainly down.

Making it serverless-compatible means moving to hosted Postgres, and that is a
rewrite rather than a port: 102 synchronous query sites and 5 transactions all
become `async`, cascading through the service layer, every route, auth, the
session store, the seeder, the importer and the backup script.

**Use a host that runs a real process with a disk instead.** The code runs
unchanged.

### Railway, Render or Fly.io

A `Dockerfile` and a `render.yaml` are in the repo. The one setting that
matters on any of them is a **persistent volume mounted at `/data`** - without
it, every deploy wipes your history.

| Setting | Value |
|---|---|
| Volume mount path | `/data` |
| `DB_PATH` | `/data/attendance.db` |
| `SECURE_COOKIES` | `1` |
| `HOST` | `0.0.0.0` |
| `SESSION_SECRET` | a long random string, set once and kept |
| Health check path | `/healthz` |

Railway: new project from the repo, add a Volume mounted at `/data`, set the
variables above. Render: point it at `render.yaml`; note a disk needs a paid
instance type. Fly.io: `fly launch`, then `fly volumes create data`.

All three terminate TLS for you, which is what `SECURE_COOKIES=1` requires.

### Carry your existing data across

A fresh volume is empty, so the app would start with no employees at all. Copy
the database you already have up to the volume **before** the first real use:

```powershell
# with the service stopped locally, take a clean single-file copy
npm run backup
```

Then upload that file to the volume as `/data/attendance.db` - Railway and Fly
both give you a shell (`fly ssh console`, Railway's console) to drop it in.
Skip this and you will be re-adding all eight staff, their PINs, departments,
shift and settings by hand.

### Lock the kiosk first

`/kiosk` takes a code and a PIN from anyone who opens it. On a LAN that is the
point; on a public URL it is an open punch endpoint. **Set a kiosk passphrase
in Setup before the app is reachable publicly** - each device is then unlocked
once and remembers for six months, and staff still just tap code and PIN.
Setup shows a red warning while no passphrase is set.

### Then delete the Vercel project

Leave it up and you have a broken URL that staff may bookmark.

---

## 7. First night checklist

- [ ] Service running and survives a reboot (`/healthz` from another machine)
- [ ] Clock, timezone and active hours set
- [ ] Firewall scoped to the LAN; reachable from a second machine
- [ ] Every employee has their password and PIN, and has changed the password
- [ ] Kiosk device open on `/kiosk` and tested with one real punch
- [ ] Backup task registered and one backup copied off the machine
- [ ] HTTPS in place, `SECURE_COOKIES=1`
- [ ] If public: kiosk passphrase set, volume mounted, database copied across
- [ ] You know where `logs\service.log` is

Then, the morning after the first night, open **Reports → Exceptions**. It
lists forgotten check-outs and unexplained absences. Working that list to empty
each morning is the whole operational routine — about two minutes a day, and it
keeps the month's payroll export clean.

---

## Day-to-day

| Task | Where |
|---|---|
| Who is in right now | Dashboard |
| Fix a missed punch | Register → the day → Edit |
| Mark leave or a holiday | Register → Edit, or Setup → Holidays |
| Month figures for payroll | Reports → Monthly → Export CSV |
| What needs fixing | Reports → Exceptions |
| Who changed a record | Setup → Audit trail |
| Add staff | Employees → Import from spreadsheet |

Remember the night-shift rule: a shift is recorded against **the date it
started**. The night of Thursday 20:00 to Friday 05:00 is "Thursday" on every
screen and in every export.
