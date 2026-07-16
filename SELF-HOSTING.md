# Self-host Clocked

Clocked includes a separate minimal Cloudflare Worker in [`self-hosted-worker/`](self-hosted-worker/). It is intentionally independent from the hosted Clocked service and does **not** include accounts, teams, billing, Stripe, dashboards, or marketing features.

It provides only:

- A shared bearer token for authentication.
- Session synchronization from the Windows app into Cloudflare D1.
- CSV report previews.
- Manual email delivery through Resend.
- An automatic previous-month email on the first day of each month.

## Endpoints

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/` | None | Shows Worker status and available endpoints. |
| `GET` | `/health` | None | Health check. |
| `POST` | `/sessions` | Bearer token | Inserts or updates synchronized sessions by session ID. |
| `GET` | `/preview?period=YYYY-MM` | Bearer token | Returns a CSV report. Defaults to the previous month. |
| `POST` | `/send?period=YYYY-MM` | Bearer token | Emails a CSV report through Resend. Defaults to the previous month. |

All protected requests use:

```http
Authorization: Bearer YOUR_SHARED_TOKEN
```

## 1. Install and authenticate Wrangler

```sh
cd self-hosted-worker
npm install
npx wrangler login
```

## 2. Create the D1 database

```sh
npx wrangler d1 create clocked-self-hosted
```

Cloudflare prints a database ID. Copy the example configuration:

```sh
cp wrangler.jsonc.example wrangler.jsonc
```

On Windows PowerShell:

```powershell
Copy-Item wrangler.jsonc.example wrangler.jsonc
```

Paste the new database ID into `wrangler.jsonc`.

Initialize the database:

```sh
npx wrangler d1 execute clocked-self-hosted --remote --file=schema.sql
```

## 3. Configure timezone and email

Edit these values in `wrangler.jsonc`:

```jsonc
"vars": {
  "REPORT_TZ": "America/New_York",
  "MAIL_FROM": "Clocked <timesheet@your-verified-domain.example>",
  "MAIL_TO": "you@example.com"
}
```

- `REPORT_TZ` must be an IANA timezone.
- `MAIL_FROM` must use a sender/domain verified in Resend.
- `MAIL_TO` may contain one address or comma-separated addresses.

The included cron runs at `06:00 UTC` on the first day of every month and emails the previous month's report. The Worker also checks the configured timezone before sending.

## 4. Set secrets

Create a strong shared token. This is the token you will paste into the Clocked desktop app:

```sh
npx wrangler secret put BEARER_TOKEN
```

Add your Resend API key:

```sh
npx wrangler secret put RESEND_API_KEY
```

Never commit either value.

## 5. Deploy

```sh
npx wrangler deploy
```

Wrangler will print a URL similar to:

```text
https://clocked-self-hosted.<your-subdomain>.workers.dev
```

Test it:

```sh
curl https://clocked-self-hosted.<your-subdomain>.workers.dev/health
```

Expected response:

```text
clocked-self-hosted ok
```

## 6. Connect the Windows app

Open Clocked's **Settings** and enter:

- **Worker URL:** your deployed Worker origin, without a trailing slash.
- **Bearer token:** the exact value saved as `BEARER_TOKEN`.

Save, then select **Sync now** from the tray menu.

The desktop app will send requests like:

```http
POST /sessions
Authorization: Bearer YOUR_SHARED_TOKEN
Content-Type: application/json

{
  "sessions": [
    {
      "id": "example-session-1",
      "start_utc": "2026-07-09T13:00:00Z",
      "end_utc": "2026-07-09T17:30:00Z",
      "start_reason": "unlock",
      "end_reason": "lock"
    }
  ]
}
```

The Worker upserts by `id`, so retrying the same session does not create a duplicate.

## Preview a report

```sh
curl \
  -H "Authorization: Bearer YOUR_SHARED_TOKEN" \
  "https://YOUR_WORKER/preview?period=2026-07"
```

The result is CSV containing the date, start time, end time, duration, and session reasons.

Omit `period` to preview the previous calendar month:

```sh
curl \
  -H "Authorization: Bearer YOUR_SHARED_TOKEN" \
  "https://YOUR_WORKER/preview"
```

## Send a report immediately

```sh
curl -X POST \
  -H "Authorization: Bearer YOUR_SHARED_TOKEN" \
  "https://YOUR_WORKER/send?period=2026-07"
```

The email includes a CSV attachment and a summary of total sessions and hours.

## Local development

Create `self-hosted-worker/.dev.vars`:

```dotenv
BEARER_TOKEN="dev-token-change-me"
RESEND_API_KEY=""
```

Initialize the local D1 database:

```sh
npx wrangler d1 execute clocked-self-hosted --local --file=schema.sql
```

Start the Worker:

```sh
npm run dev
```

Test synchronization:

```sh
curl -X POST http://localhost:8787/sessions \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"sessions":[{"id":"test-1","start_utc":"2026-07-09T13:00:00Z","end_utc":"2026-07-09T14:00:00Z","start_reason":"unlock","end_reason":"lock"}]}'
```

## Security and privacy notes

- Anyone with the shared bearer token can upload sessions, preview reports, and trigger report emails.
- Use a long random token and rotate it if exposed.
- Use HTTPS; Cloudflare Workers provide it automatically.
- This minimal Worker is designed for one person or one trusted installation. It does not isolate multiple users.
- Session timestamps and reasons are stored in your own D1 database.
- Your configured Resend account receives the report contents for email delivery.
- Review and publish a privacy policy appropriate for your deployment.
