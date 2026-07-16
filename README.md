# clocked

**Automatic Windows time tracking — no timers.**

[Live site](https://clocked.daviddusi.com) · [Download for Windows](https://clocked.daviddusi.com/download) · [Press kit](https://clocked.daviddusi.com/press)

A background tray app clocks you in/out from machine **power** and **session**
events, stores sessions locally in SQLite, and syncs them to a Cloudflare Worker
that emails a monthly report — whether or not your laptop is awake at month-end.

| | |
|--|--|
| **Desktop** | Open source (MIT), Windows tray, local SQLite source of truth |
| **Cloud** | Optional paid host for sync, dashboard, teams, email timesheets |
| **Self-host** | Point the app at your own Worker |

```
Windows tray app (Rust)                     Cloudflare Worker (TypeScript)
  wake / unlock  -> clock in                  POST /sessions -> D1 (upsert by id)
  sleep / lock   -> clock out                 cron (daily; per-user send day)
  local SQLite (source of truth)   --HTTPS--> Resend: monthly timesheet email
```

### Why it exists

Most trackers make you babysit a timer. clocked uses what Windows already knows
(unlock, lock, idle, sleep) so freelancers and small teams get honest hours
without screenshots or keylogging. While you're clocked in it also attributes
time to the focused app, and infers a **privacy-safe context** when it can
(browser hostname, document name from the title bar — never full URLs or
keystrokes). Full window titles stay off by default. Totals stay local first,
with optional project rollups in the cloud.

## Clock rules

- **Clock in:** system resume, session unlock, app start, activity after idle.
- **Clock out:** system suspend, session lock, shutdown, quit, idle timeout.
- **Idle:** after 15 min with no keyboard/mouse input the clock stops
  (`end_reason = idle`), backdated to the last input so the idle stretch isn't
  counted; the next input resumes it (`start_reason = active`). A balloon warns
  ~2 min before. Tune with `idle_timeout_secs` in `config.toml` (seconds; `0`
  disables).
- **Manual pause:** the tray **Pause tracking** / **Resume tracking** toggle
  stops the clock (`reason = manual`). The pause holds while you keep working,
  but the next time you open the machine (wake / unlock / app start) it clears
  automatically and tracking resumes — so you never have to remember to unpause
  after closing the laptop. Toggle **Resume tracking** to resume immediately.
- **After-hours prompt:** if you wake/unlock/launch the computer outside your
  configured working hours, a Yes/No popup asks whether you're working. **No**
  keeps you clocked out (nothing tracks until you say otherwise); the answer is
  remembered for that evening and reset the next time you're active during work
  hours. Set `work_start` / `work_end` / `work_days` in `config.toml` (blank
  times disable it; overnight windows like `22:00`–`06:00` are supported).
- At most one open session at a time.
- If the app dies with a session open (crash / hard power-off), the next launch
  closes it at the last heartbeat (`end_reason = crash`).

A **session** is one continuous present-span. The monthly report prints **one row
per session**, tab-separated, in your configured timezone:

```
Monday, June 29, 2026	10:00	18:00
```

Sessions crossing local midnight are split so each row stays within one day.

---

## Part 1 — Desktop app

### Build & run

```sh
cargo build --release
# binary: target/release/clocked.exe  (no console window)
```

### Deploy a desktop release

After committing your changes, run:

```powershell
.\deploy.ps1
```

The script reads the version from `Cargo.toml`, runs tests, builds the Inno Setup
installer, pushes the current branch, creates/pushes tag `v<version>` if needed,
and creates or updates the matching GitHub Release with the installer asset.
Bump `Cargo.toml` first when you want installed apps to detect a new update.

Run `clocked.exe`. It creates `%APPDATA%\clocked\data\` containing:

- `clocked.db` — sessions
- `config.toml` — sync settings (written as a blank template on first run)
- `clocked.log` — diagnostics

Right-click the tray icon for a short status (tracking / today / top projects
and sites), **Pause**, **Open timesheet**, **Settings**, optional **Sync now**,
**Check for updates**, and **Quit**. When a newer release exists the update line
becomes a download link; otherwise it re-checks GitHub. The **Settings** window
edits `config.toml` (sync, idle, goal,
working hours) plus:

- **Start at login** — enabled by default by the installer; a per-user
  `HKCU\...\Run` entry runs clocked at each Windows **sign-in** (not on
  lock/unlock).
- **Keep clocked running** — a per-user Scheduled Task (`clocked-keepalive`) that
  relaunches clocked at **logon and on workstation unlock**. Combined with the
  single-instance guard, unlocking after a quit brings it back.

### Browser extension (optional)

For accurate browser sites (not just window-title guesses), download the
extension zip from [clocked.daviddusi.com/download/extension](https://clocked.daviddusi.com/download/extension)
(or use `extension/chrome` from the repo). Unzip, load unpacked in Chrome/Edge
Developer mode, and paste the **same** `clk_…` token in Options. The tray app
listens on `http://127.0.0.1:19532` and only accepts that token; only hostnames
are sent, never full URLs.

Local-only mode works with no config — it just won't sync or email.

### Enable syncing

Open the Worker's URL in a browser, **Create account**, and copy the
per-account **sync token** it shows you (starts with `clk_`). Then right-click
the tray icon ? **Settings?**, paste the token into **Bearer token**, and click
**Save** ? syncing starts automatically (no restart needed). The app defaults to
`https://clocked.daviddusi.com`; changing the Worker URL is tucked under
**Advanced settings** for self-hosted/dev installs. This writes the same
`%APPDATA%\clocked\data\config.toml`:

```toml
worker_url   = "https://clocked.daviddusi.com"
bearer_token = "<the clk_… token from your account's dashboard>"

# Optional behavior tuning (defaults shown):
idle_timeout_secs = 900   # auto clock-out after 15 min idle; 0 disables
target_hours      = 8     # daily goal shown in the tray; 0 hides it

# Working hours — outside these, opening the computer prompts "Are you working?".
# Blank work_start/work_end (or empty work_days) disables the prompt.
work_start = "09:00"
work_end   = "17:00"
work_days  = ["Mon", "Tue", "Wed", "Thu", "Fri"]
```

The app pushes unsynced sessions on startup, on resume, hourly, and via **Sync now**.

---

## Part 2 — Cloudflare Worker

### One-time setup

```sh
cd worker
npm install

# 1. Create the D1 database, then paste its id into wrangler.jsonc (database_id).
npx wrangler d1 create clocked

# 2. Apply schema to the remote DB.
npx wrangler d1 migrations apply clocked --remote

# 3. Set the better-auth signing secret (any long random string).
#    Per-account clk_ tokens are preferred. A legacy global BEARER_TOKEN is only
#    honored if you also set ALLOW_LEGACY_BEARER_TOKEN=true (not recommended).
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put RESEND_API_KEY

# 4. Edit wrangler.jsonc:
#      REPORT_TZ       -> your IANA timezone, e.g. "America/New_York"
#      BETTER_AUTH_URL -> this Worker's public URL (used for sign-up/session cookies)
#      MAIL_FROM       -> an address on your Cloudflare-managed sending domain
#      MAIL_TO         -> default recipient (each account can override it in the dashboard)
#
#    Prerequisites for the send_email binding:
#      - Email Routing enabled on the account
#      - MAIL_TO verified as an Email Routing destination
#      - the MAIL_FROM domain verified for sending

npx wrangler deploy
```

### Endpoints

| Method | Path                        | Auth    | Purpose                                          |
|--------|-----------------------------|---------|--------------------------------------------------|
| GET    | `/`                         | –       | landing page + dashboard (single self-contained app) |
| GET    | `/health`                   | –       | health check                                     |
| POST   | `/api/auth/sign-up/email`   | –       | create an account (better-auth)                  |
| POST   | `/api/auth/sign-in/email`   | –       | sign in (better-auth)                            |
| GET    | `/api/token`                | Cookie  | this account's `clk_` sync token (created on first read) |
| POST   | `/api/token/regenerate`     | Cookie  | revoke + reissue this account's token            |
| GET    | `/api/hours?period=YYYY-MM` | Cookie  | this account's per-day hours (dashboard)         |
| POST   | `/sessions`                 | Bearer  | ingest synced sessions for the token's account (upsert by id) |
| POST   | `/activity`                 | Bearer  | daily app/project aggregates (no titles; paid account only) |
| GET    | `/preview?period=YYYY-MM`   | Cookie  | this account's report body (no email)            |
| POST   | `/send-test?period=YYYY-MM` | Cookie  | build **and email** this account's report now (bypasses gate) |

Sign-up is public: each new account gets its own `clk_` Bearer token and only
ever sees its own sessions. The desktop app authenticates its sync with that
token; a global `BEARER_TOKEN` secret, if set, still works as a legacy fallback
(those sessions land unattributed to any account).

### Monthly send

A cron runs daily at 06:00 UTC; the handler only acts when it's the **1st in
`REPORT_TZ`**, emailing **every account** its own **previous full calendar
month** exactly once (tracked per account in the `sent_reports` table). Each
account's recipient is the address it set in the dashboard, falling back to its
sign-up email. It sends on the 1st and ignores late-arriving data for that month.

---

## Testing

### Desktop app
- `cargo test` — session state machine + crash recovery.
- Run `clocked.exe`, lock (Win+L) / unlock, sleep / wake; inspect
  `clocked.db` and `clocked.log`. Force-kill mid-session, relaunch → the open
  session is closed at ~last heartbeat with `end_reason = crash`.

### Worker (locally, no email)
```sh
cd worker
printf 'BEARER_TOKEN="devtoken"\nBETTER_AUTH_SECRET="dev-only-secret-change-me"\nBETTER_AUTH_URL="http://localhost:8787"\n' > .dev.vars
npx wrangler d1 migrations apply clocked --local
npm run dev   # serves the app + APIs on http://localhost:8787 (better-auth needs the vite build)

# in another shell — sign up, grab the account's token, sync a session, read hours:
BASE=http://localhost:8787
curl -s -c cj.txt -X POST $BASE/api/auth/sign-up/email -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"supersecret12","name":"You"}'
TOK=$(curl -s -b cj.txt $BASE/api/token | sed -n 's/.*"token":"\(clk_[^"]*\)".*/\1/p')
curl -s -X POST $BASE/sessions -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"sessions":[{"id":"t1","start_utc":"2026-06-30T02:00:00Z","end_utc":"2026-06-30T05:00:00Z","start_reason":"unlock","end_reason":"suspend"}]}'
curl -s -b cj.txt "$BASE/api/hours?period=2026-06"
```
