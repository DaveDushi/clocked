# clocked

**Automatic desktop time tracking — no timers.**

[Live site](https://clocked.easytomanage.com) · [Download](https://clocked.easytomanage.com/download) · [Press kit](https://clocked.easytomanage.com/press)

A background tray app clocks you in/out from machine **power** and **session**
events, stores sessions locally in SQLite, and syncs them to a Cloudflare Worker
that emails a monthly report — whether or not your laptop is awake at month-end.

| | |
|--|--|
| **Desktop** | Open source (MIT), Windows/macOS/Linux tray, local SQLite source of truth |
| **Cloud** | Optional free hosted account for sync, dashboard, teams, email timesheets |
| **Self-host** | Point the app at your own Worker |

```
Desktop tray app (Rust)                     Cloudflare Worker (TypeScript)
  wake / unlock  -> clock in                  POST /sessions -> D1 (upsert by id)
  sleep / lock   -> clock out                 cron (per-user day, time, timezone)
  local SQLite (source of truth)   --HTTPS--> email provider: monthly timesheet
```

### Why it exists

Most trackers make you babysit a timer. clocked uses what the operating system knows
(unlock, lock, idle, sleep) so freelancers and small teams get honest hours
without screenshots or keylogging. By default it only tracks **presence**
(when you were working) — no app or project breakdown. Optional **project
tracking** (`track_projects = true` in `config.toml`, or Settings → Advanced)
attributes time to the focused app and infers a privacy-safe context when it
can (browser hostname, document name from the title bar — never full URLs or
keystrokes). Full window titles stay off by default. Totals stay local first,
with optional project rollups in the cloud when that feature is on.

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
# Windows: target/release/clocked.exe (no console window)
# Linux/macOS: target/release/clocked
```

#### Linux (Wayland)

The Linux app uses GTK 3 + Ayatana AppIndicator for its tray, the standard
Wayland `ext-idle-notify-v1` protocol for exact idle time, Secret Service for
the sync token, and logind/desktop integration for lock and suspend handling.
Hyprland on Omarchy is fully supported; other Wayland desktops work when they
provide the idle-notify protocol and update logind's `LockedHint`.

Choose **Settings…** from the tray menu to edit sync, idle, goal, working-hours,
privacy, and startup options in a native GTK panel. Saving applies the changes
to the running tracker immediately.

On Arch/Omarchy, install build dependencies if needed and install for the
current user:

```sh
omarchy pkg add base-devel rust gtk3 libayatana-appindicator libsecret wayland wayland-protocols
./packaging/linux/install.sh
~/.local/bin/clocked
```

The installer adds a launcher and enables start-at-login through the standard
XDG autostart directory. No root access is required.

Tagged releases also include a prebuilt
`clocked-linux-x86_64-ubuntu-24.04.tar.gz`. Extract it and run `./install.sh`
from the extracted directory; GTK 3, Ayatana AppIndicator, Wayland, and
`secret-tool` must be installed by the system package manager.

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

Right-click the tray icon for a short status (tracking / today; with project
tracking on, also top projects and sites), **Pause**, **Open timesheet**,
**Settings**, optional **Sync now**, **Check for updates**, and **Quit**. When a
newer release exists the update line becomes a download link; otherwise it
re-checks GitHub. The **Settings** window edits `config.toml` (sync, idle, goal,
working hours) plus:

- **Start at login** — enabled by default by the installer; a per-user
  `HKCU\...\Run` entry runs clocked at each Windows **sign-in** (not on
  lock/unlock).
- **Keep clocked running** — a per-user Scheduled Task (`clocked-keepalive`) that
  relaunches clocked at **logon and on workstation unlock**. Combined with the
  single-instance guard, unlocking after a quit brings it back.

### Browser extension (optional)

For accurate browser sites (not just window-title guesses), download the
extension zip from [clocked.easytomanage.com/download/extension](https://clocked.easytomanage.com/download/extension)
(or use `extension/chrome` from the repo). Unzip, load unpacked in Chrome/Edge
Developer mode, and paste that computer's **same** `clk_…` device token in Options. The tray app
listens on `http://127.0.0.1:19532` and only accepts that token; only hostnames
are sent, never full URLs.

Local-only mode works with no config — it just won't sync or email.

### Enable syncing

Open the Worker's URL in a browser, **Create account**, add a named device, and
copy the **sync token** it shows you (starts with `clk_`). Each computer can have
its own token, so adding or revoking one device does not disconnect the others.
Then right-click
the tray icon ? **Settings?**, paste the token into **Bearer token**, and click
**Save** ? syncing starts automatically (no restart needed). The app defaults to
`https://clocked.easytomanage.com`; changing the Worker URL is tucked under
**Advanced settings** for self-hosted/dev installs. This writes the same
`%APPDATA%\clocked\data\config.toml`:

```toml
worker_url   = "https://clocked.easytomanage.com"
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
# Default email provider. See "Switch email providers" below for alternatives.
# Only needed if you select EMAIL_PROVIDER=resend instead of Cloudflare.
# npx wrangler secret put RESEND_API_KEY

# 4. Edit wrangler.jsonc:
#      REPORT_TZ       -> your IANA timezone, e.g. "America/New_York"
#      BETTER_AUTH_URL -> this Worker's public URL (used for sign-up/session cookies)
#      MAIL_FROM       -> an address on your provider-verified sending domain
#      MAIL_TO         -> default recipient (each account can override it in the dashboard)

npm run deploy
```

### Production deployment

The production Worker and D1 database are in **Edusi@easytomanage.com's Account**.
The site is <https://clocked.easytomanage.com>. Deploy from `worker` with
`npm run deploy`; the root `deploy.ps1` publishes desktop releases separately.

To finish outbound email setup, onboard **clocked.easytomanage.com** under
**Compute > Email Service > Email Sending** in edusi. The configured sender is
`timesheet@clocked.easytomanage.com`. The Worker already has its `EMAIL` binding
and `EMAIL_PROVIDER=cloudflare`. Sending remains unavailable until the domain
is verified; ordinary recipients require Workers Paid. Email Sending does not
require moving the apex domain's incoming mail to Cloudflare.

Add this authorized redirect URI to the existing Google OAuth web client:
`https://clocked.easytomanage.com/api/auth/callback/google`. Until it is
registered, Google sign-in returns `redirect_uri_mismatch`. The migrated
credentials remain configured; desktop token login works independently.

The old `clocked.daviddusi.com` Worker forwards API, desktop policy, and sync
requests to production and redirects web pages to the new domain. Its cron
schedule is empty. Keep it running while installed desktop clients use the old
address. To redeploy that compatibility Worker, run
`npx wrangler deploy --config legacy/wrangler.jsonc` from `worker`.

Run `node scripts/verify-deployment.mjs` from `worker` to check both live domains
without sending mail. New desktop builds default to the new domain; existing
release downloads continue to work through the compatibility Worker.

### Switch email providers

All outgoing email uses `worker/src/email-provider.ts`, including verification,
password resets, invitations, account approvals, sales enquiries, and timesheets
with CSV attachments. Set `EMAIL_PROVIDER` in `worker/wrangler.jsonc` to `resend`,
`cloudflare`, or `ses`. If omitted, it defaults to Resend. For local development,
set it in `.dev.vars`. An invalid provider or missing credentials returns an error.

To migrate from Resend to Cloudflare Email Sending:

1. In the Cloudflare account that hosts this Worker, open **Compute > Email
   Service > Email Sending** and onboard the sending domain used by `MAIL_FROM`.
   The domain must use Cloudflare DNS. Wait for the required DNS records to verify.
   Sending to arbitrary recipients requires Workers Paid; recipient verification
   is not required once the sending domain is onboarded.
2. Uncomment `"send_email": [{ "name": "EMAIL" }]` in `worker/wrangler.jsonc`.
   Set `"EMAIL_PROVIDER": "cloudflare"`. Keep `MAIL_FROM` on the verified domain.
   This binding uses the Worker's account and needs no email API key.
3. Run `npm test`, `npm run typecheck`, and `npm run deploy` from `worker`.
4. Use the dashboard to send a test report to an address you control. Check its
   HTML, plain text, and CSV attachment. Test a verification or password-reset
   email and check delivery in Cloudflare's outbound email activity logs.
5. After confirming delivery, remove the unused Resend secret if desired. To
   roll back, restore the secret, set `EMAIL_PROVIDER` to `resend`, and redeploy.

For local Cloudflare sending, `remote: true` on the binding connects to the live
service and sends real emails. Without it, local simulation does not prove inbox
delivery. Check the account's daily quota before a large report run. Cloudflare
currently limits each message to 50 recipients and 5 MiB including attachments.
See [Cloudflare setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
and [sending limits](https://developers.cloudflare.com/email-service/platform/limits/).

To use Amazon SES, verify the sender domain in the intended AWS region, enable
DKIM, and request production access to send to unverified recipients. Set
`EMAIL_PROVIDER` to `ses` and `SES_REGION` in Wrangler vars, for example
`eu-central-1`. Store credentials as secrets:

```sh
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
# Only for temporary credentials; these must be refreshed before expiry:
npx wrangler secret put SES_SESSION_TOKEN
```

Use credentials authorized for `ses:SendEmail` on your verified sending identity.
Deploy and test as above. The adapter signs SES v2 requests with SigV4 using
`aws4fetch`. It supports HTML, text, reply-to, multiple recipients, and attachments.
See [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

Providers submit messages once per call. There is no automatic retry or fallback
to another provider, because an ambiguous timeout can mean the email was already
accepted. A successful result means provider acceptance, not inbox delivery.
Report submissions are recorded in `sent_reports` after success; a crash between
provider acceptance and that database write can still cause a duplicate. Switching
providers does not transfer delivery logs, suppression lists, or bounce handling.
Check delivery monitoring and suppressions with the chosen provider before cutover.

### Invite managers and workers

The landing page's **Request access** form emails `ADMIN_INBOX` with the person's
name, reply-to email, individual or team request, and optional message and team
details. Requests do not create accounts or grant access. Review the email,
then send the appropriate invitation from the operator dashboard.

New accounts require a pending, unexpired invitation for their email address.
This applies to email/password signup and Google account creation. Existing
approved accounts keep access.

Sign in with the verified operator account, `ADMIN_INBOX` in `worker/src/email.ts`.
In **Invite someone**, choose **Team manager**, then enter their email and team name.
Clocked creates a separate team and sends an invitation that expires in seven
days. The invited manager becomes its owner when they verify their email and
open the invitation. The operator does not become a member of that team.
If email delivery fails, copy the saved invitation link from the same form.

Choose **Individual** to invite someone without a team. After verifying their
email and accepting the invitation, they can track time and manage their own
timesheets and delivery settings. No team is created. They can accept a team
invitation later. Only the operator can send these invitations or start new
teams; individuals and workers cannot invite others. Individual invitations
also expire after seven days.

Managers invite workers from **Team** by entering an email and selecting
**Worker**. Select **Manager** to invite another manager into that same team.
Recipients can create an account or sign in with an existing individual account.
Opening the invitation with the matching verified email joins the team and
approves access automatically. Existing accounts retain their recorded time;
their team controls timesheet delivery after they join.

For accounts created before invite-only onboarding, the existing approval links
and command still work. The command does not create an account or send email:

```sh
npm run users:approve -- person@example.com
```

Run `npm run verify:onboarding` in `worker` to check invite-only signup, manager
provisioning, and an existing individual account joining a team against an
isolated local Worker and D1 database. Add `-- --serve` to inspect the fixture.
It has no email credentials and does not send external email.

### Manager-assigned working hours

In the dashboard, open **Team > Working hours**. Choose **Team default**, set
the shift start/end and working days, then save. Select a person in **Schedule
for** to give them different hours. **Use team default** removes their override.
For the team default, **Use personal settings** restores each person's desktop
hours. **Turn off the after-hours prompt** is an explicit assignment and can
also be set per person.

Hours use each computer's local timezone. Selected days name the day a shift
starts: Friday 22:00 to 06:00 includes Saturday morning. These settings control
the after-hours prompt; tracking does not stop automatically at shift end.

Updated desktop apps fetch assignments on sync, including startup, wake and the
hourly sync. Use **Sync now** to fetch a change immediately. The next tracking
decision or heartbeat applies it without a restart. Offline computers retain
their last assignment. Personal config.toml hours remain intact and apply again
after an assignment ends. If a person belongs to multiple teams, their earliest
membership supplies working hours.

To roll out this feature, apply D1 migration `0019_working_hours.sql`, deploy the
Worker, and distribute the updated desktop app. Existing desktop versions keep
using their personal hours. Run `node scripts/verify-working-hours.mjs` from
`worker` to verify the APIs with isolated local accounts and D1 data.

### User list

List every registered app account, including verification and approval status,
organizations, and roles:

```sh
npm run users:list
npm run users:list -- --local
```

These operator commands use Wrangler's D1 access: they are not available to
regular app users. Anyone with Cloudflare credentials that can execute queries
against the `clocked` D1 database can run them.

### Endpoints

| Method | Path                        | Auth    | Purpose                                          |
|--------|-----------------------------|---------|--------------------------------------------------|
| GET    | `/`                         | –       | landing page + dashboard (single self-contained app) |
| GET    | `/health`                   | –       | health check                                     |
| POST   | `/api/auth/sign-up/email`   | –       | create an account (better-auth)                  |
| POST   | `/api/auth/sign-in/email`   | –       | sign in (better-auth)                            |
| GET    | `/api/token`                | Cookie  | legacy first-token view (created on first read)   |
| GET    | `/api/tokens`               | Cookie  | list this account's named device tokens           |
| POST   | `/api/tokens`               | Cookie  | mint an additional named device token             |
| DELETE | `/api/tokens/:id`           | Cookie  | revoke one device token without affecting others  |
| POST   | `/api/token/regenerate`     | Cookie  | legacy revoke-all + reissue endpoint               |
| GET    | `/api/hours?period=YYYY-MM` | Cookie  | this account's per-day hours (dashboard)         |
| POST   | `/sessions`                 | Bearer  | ingest synced sessions for the token's account (upsert by id) |
| POST   | `/activity`                 | Bearer  | daily app/project aggregates (no titles) |
| GET    | `/preview?period=YYYY-MM`   | Cookie  | this account's report body (no email)            |
| POST   | `/send-test?period=YYYY-MM` | Cookie  | build **and email** this account's report now (bypasses gate) |

Sign-up is invite-only. Verified accounts that accepted an invitation can mint
named `clk_` Bearer tokens. Each account only sees its own sessions. The desktop app authenticates its sync with that
token; a global `BEARER_TOKEN` secret, if set, still works as a legacy fallback
(those sessions land unattributed to any account).

### Automatic timesheet emails

A cron checks each account's dashboard-configured **day, time, and IANA
timezone**, emailing its **previous full calendar month** exactly once (tracked
per account in the `sent_reports` table). Existing accounts default to the
original 06:00 UTC schedule. Each account's recipient is the address it set in
the dashboard, falling back to its sign-up email. Team managers control the
shared delivery schedule for their members.

Delivery settings also offer an opt-in **Weekly** frequency. Choose a weekday,
time, and timezone. Each weekly email and CSV covers the seven completed local
dates before that weekday. Monday delivery covers the previous Monday through
Sunday, including weeks across month and year boundaries. Existing schedules
remain monthly. Turn off **Email automatically** to stop scheduled delivery.
Apply migration `0023_weekly_delivery.sql` before deploying the updated Worker.

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
