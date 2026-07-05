# clocked

Automatic Windows time tracker. A background tray app clocks you in/out from
machine **power** and **session** events, stores sessions locally in SQLite, and
syncs them to a Cloudflare Worker that emails you a monthly report — whether or
not your laptop is awake at month-end.

```
Windows tray app (Rust)                     Cloudflare Worker (TypeScript)
  wake / unlock  -> clock in                  POST /sessions -> D1 (upsert by id)
  sleep / lock   -> clock out                 cron (daily, acts on the 1st)
  local SQLite (source of truth)   --HTTPS--> emails previous month via send_email
```

## Clock rules

- **Clock in:** system resume, session unlock, app start.
- **Clock out:** system suspend, session lock, shutdown, quit.
- No idle timeout. At most one open session at a time.
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

Run `clocked.exe`. It creates `%APPDATA%\clocked\data\` containing:

- `clocked.db` — sessions
- `config.toml` — sync settings (written as a blank template on first run)
- `clocked.log` — diagnostics

Right-click the tray icon for: status, today's total, **Sync now**,
**Start at login** (toggles the `HKCU\...\Run` entry), **Open data folder**, **Quit**.

Local-only mode works with no config — it just won't sync or email.

### Enable syncing

Edit `%APPDATA%\clocked\data\config.toml`:

```toml
worker_url   = "https://clocked-worker.<subdomain>.workers.dev"
bearer_token = "<same random secret you set on the Worker>"
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

# 3. Set the shared secret (must match the app's config.toml).
npx wrangler secret put BEARER_TOKEN

# 4. Edit wrangler.jsonc:
#      REPORT_TZ  -> your IANA timezone, e.g. "America/New_York"
#      MAIL_TO / send_email.destination_address -> your recipient address
#      MAIL_FROM  -> an address on your Cloudflare-managed sending domain
#
#    Prerequisites for the send_email binding:
#      - Email Routing enabled on the account
#      - MAIL_TO verified as an Email Routing destination
#      - the MAIL_FROM domain verified for sending

npx wrangler deploy
```

### Endpoints

| Method | Path                    | Auth   | Purpose                                  |
|--------|-------------------------|--------|------------------------------------------|
| GET    | `/`                     | –      | health check                             |
| POST   | `/sessions`             | Bearer | ingest synced sessions (upsert by id)    |
| GET    | `/preview?period=YYYY-MM` | Bearer | return the report body (no email)        |
| POST   | `/send-test?period=YYYY-MM` | Bearer | build **and email** now (bypasses gate)  |

### Monthly send

A cron runs daily at 06:00 UTC; the handler only acts when it's the **1st in
`REPORT_TZ`**, emailing the **previous full calendar month** exactly once
(tracked in the `sent_reports` table). It sends on the 1st and ignores any
late-arriving data for that month.

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
echo 'BEARER_TOKEN="devtoken"' > .dev.vars
npx wrangler d1 migrations apply clocked --local
npx wrangler d1 execute clocked --local --command \
  "INSERT INTO sessions VALUES ('t1','2026-06-30T02:00:00Z','2026-06-30T05:00:00Z','unlock','suspend')"
npx wrangler dev --local
# in another shell:
curl -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/preview?period=2026-06"
```
