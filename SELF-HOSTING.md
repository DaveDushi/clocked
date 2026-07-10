# Self-hosting the Clocked Worker

This guide explains how to deploy the Cloudflare Worker included in this repository, connect the Windows desktop app to it, and understand the HTTP endpoints exposed by the Worker.

> [!IMPORTANT]
> The Worker in this repository is also the codebase for the hosted commercial service. It includes account verification, teams, Stripe subscription checks, marketing pages, and optional integrations. A complete clone of the hosted service therefore requires more configuration than the desktop app's basic synchronization endpoint.

## What you need

- A Cloudflare account with Workers and D1 available.
- Node.js and npm.
- Wrangler authenticated to your Cloudflare account.
- A public Worker URL, either a `workers.dev` address or a custom domain.
- A long random Better Auth secret.
- Optional provider accounts for email, billing, Google sign-in, and marketing automation.

From the repository root:

```sh
cd worker
npm install
npx wrangler login
```

## 1. Create the D1 database

Create a database:

```sh
npx wrangler d1 create clocked
```

Wrangler prints a database ID. Copy it into `worker/wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "clocked",
    "database_id": "YOUR_D1_DATABASE_ID",
    "migrations_dir": "migrations"
  }
]
```

Apply all migrations:

```sh
npx wrangler d1 migrations apply clocked --remote
```

For local development, use:

```sh
npx wrangler d1 migrations apply clocked --local
```

## 2. Configure the public URL

Choose the URL users will open and the desktop app will call.

For a standard `workers.dev` deployment, remove the repository owner's `routes` section from `wrangler.jsonc`. After the first deployment, Wrangler will show a URL similar to:

```text
https://clocked.<your-subdomain>.workers.dev
```

Set `BETTER_AUTH_URL` to that exact origin, with no trailing slash:

```jsonc
"BETTER_AUTH_URL": "https://clocked.<your-subdomain>.workers.dev"
```

For a custom domain, replace the existing repository-owner routes with your own Cloudflare zone and set `BETTER_AUTH_URL` to the same public origin.

Do not leave `clocked.daviddusi.com`, the repository owner's Cloudflare account ID, D1 ID, routes, email addresses, or Stripe price IDs in your deployment.

## 3. Configure required variables and secrets

### Required for account authentication

Generate a strong random value of at least 32 characters and save it as a Worker secret:

```sh
npx wrangler secret put BETTER_AUTH_SECRET
```

Set these non-secret variables in `wrangler.jsonc`:

```jsonc
"vars": {
  "REPORT_TZ": "America/New_York",
  "BETTER_AUTH_URL": "https://your-worker.example.com",
  "MAIL_FROM": "timesheet@your-domain.example",
  "MAIL_TO": ""
}
```

`REPORT_TZ` must be an IANA timezone name. It controls report periods and scheduled-send dates.

### Email

The Worker uses email for verification, timesheet delivery, and contact messages. Configure the provider expected by the current code:

```sh
npx wrangler secret put RESEND_API_KEY
```

Use a verified sender in `MAIL_FROM`. Depending on the email path you enable, you may also need Cloudflare Email Routing and a verified destination.

Without working email delivery, users may be unable to complete email verification, and most authenticated product endpoints require a verified account.

### Stripe and access checks

The current account-based product endpoints require the user to belong to an organization with paid access. To run the complete account, dashboard, team, and billing flow unchanged, configure Stripe:

```sh
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Replace all `STRIPE_PRICE_*` values in `wrangler.jsonc` with your own Stripe recurring Price IDs. Configure a Stripe webhook that sends events to:

```text
POST https://your-worker.example.com/api/stripe/webhook
```

Self-hosters who do not want billing should not insert fake Stripe values. Instead, create and maintain a small code change that replaces the hosted service's paid-access policy with the access policy appropriate for their private deployment. Keep that modification explicit so future upstream updates do not silently re-enable subscription checks.

### Optional integrations

Only configure these when you use the related feature:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MARKETING_AGENT_SECRET
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_TOKEN_SECRET
```

The marketing cron and public marketing pages are not required for desktop synchronization. You may remove the marketing cron and routes from your fork if they are outside your use case.

## 4. Review scheduled jobs

The repository currently defines two daily cron triggers:

```jsonc
"triggers": { "crons": ["0 6 * * *", "0 14 * * *"] }
```

- `0 6 * * *` evaluates scheduled timesheet delivery for each account.
- `0 14 * * *` runs the optional marketing agent.

For a private deployment, keep the report cron and remove the marketing cron unless you intentionally configure and use that subsystem.

## 5. Deploy

```sh
npx wrangler deploy
```

Verify the deployment:

```sh
curl https://your-worker.example.com/health
```

Expected response:

```text
clocked-worker ok
```

Open the Worker URL in a browser to reach the landing page and dashboard.

## 6. Create an account and connect the desktop app

1. Open the Worker URL.
2. Create an account and complete email verification.
3. Complete whatever access or subscription flow your deployment uses.
4. Open the dashboard and retrieve the account's `clk_` sync token.
5. In the Windows tray app, open **Settings**.
6. Under advanced sync settings, set the Worker URL to your deployment origin.
7. Paste the `clk_` token into **Bearer token** and save.
8. Use **Sync now** and confirm the session appears in the dashboard.

The desktop app sends records only after both a Worker URL and token are configured. Local-only tracking continues to work without either value.

## Endpoint model

The Worker uses three primary authentication models:

- **Public:** no account is required.
- **Cookie:** the browser dashboard sends a Better Auth session cookie. Most data endpoints also require verified email and paid access under the upstream hosted-service policy.
- **Bearer:** the Windows app sends `Authorization: Bearer clk_...`.

The endpoint list below documents the major public and product routes. Better Auth also owns additional routes beneath `/api/auth/*` that are not individually implemented in `src/index.ts`.

## Public and service endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public | Landing page and browser dashboard shell. |
| `GET` or `HEAD` | `/download` | Public | Redirects or serves the current desktop download response. |
| `GET` | `/health` | Public | Lightweight deployment health check. |
| `GET` | `/favicon.ico`, `/favicon.png` | Public | Site icon. |
| `GET` | `/og.jpg`, `/og.png` | Public | Social preview image. |
| `GET` | `/robots.txt` | Public | Search-crawler directives. |
| `GET` | `/sitemap.xml` | Public | Search-engine sitemap. |
| `GET` | `/llms.txt` | Public | Machine-readable site/project information. |
| `GET` | `/press` | Public | Press page. |
| `GET` | `/news` | Public | News page. |
| `GET` | `/news.xml` | Public | News feed. |
| `POST` | `/api/contact-sales` | Public, rate-limited | Sends a sales-contact form submission. |

## Authentication endpoints

All paths beginning with `/api/auth/` are delegated to Better Auth. Important examples include:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/sign-up/email` | Create an email/password account. |
| `POST` | `/api/auth/sign-in/email` | Sign in with email and password. |
| Better Auth managed | `/api/auth/*` | Session, sign-out, verification, OAuth, and other configured authentication operations. |

Use the dashboard or the Better Auth client rather than treating every authentication route as a stable handwritten API. The available subroutes depend on the Better Auth configuration and enabled plugins.

## Current-user endpoints

These use the browser session cookie.

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/me` | Signed-in user | Returns the current account, verification state, organization memberships, access state, and editing permissions. |
| `GET` | `/api/token` | Verified user with access | Returns or creates the account's `clk_` desktop sync token. |
| `POST` | `/api/token/regenerate` | Verified user with access, rate-limited | Revokes the old sync token and returns a new one. |
| `GET` | `/api/hours?period=YYYY-MM` | Verified user with access | Returns per-day hours for a month. If `period` is omitted, the previous month is used. |
| `GET` | `/preview?period=YYYY-MM` | Verified user with access | Returns the user's report as CSV without sending email. |
| `POST` | `/api/send?period=YYYY-MM` | Verified user with access, rate-limited | Generates and emails the report immediately. |
| `GET` | `/api/settings` | Verified user with access | Reads effective report recipients and send day. |
| `POST` | `/api/settings` | Verified user with access | Updates personal report recipients and send day when not controlled by a team manager. |
| `POST` or `DELETE` | `/api/manual-session` | Verified user with access and edit permission | Creates or deletes manual time entries. Query/body requirements are implemented by `handleManualSession`. |

A valid `period` uses `YYYY-MM`. Invalid periods return `400`.

## Desktop synchronization endpoint

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/sessions` | `Authorization: Bearer clk_...` | Upserts desktop sessions into D1 for the token's account. |

Example:

```sh
curl -X POST https://your-worker.example.com/sessions \
  -H "Authorization: Bearer clk_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "sessions": [
      {
        "id": "example-session-1",
        "start_utc": "2026-07-09T13:00:00Z",
        "end_utc": "2026-07-09T17:30:00Z",
        "start_reason": "unlock",
        "end_reason": "lock"
      }
    ]
  }'
```

The endpoint is idempotent by session ID, allowing the desktop app to retry synchronization safely. Invalid or missing tokens return `401`. Under the upstream hosted policy, an account without paid access returns `402`. Rate limits may return `429`.

### Legacy global bearer token

The repository retains an opt-in legacy mode for a single shared token:

```sh
npx wrangler secret put BEARER_TOKEN
```

Add this variable:

```jsonc
"ALLOW_LEGACY_BEARER_TOKEN": "true"
```

The desktop app can then send that token to `/sessions`. This mode is disabled by default and stores the sessions without an account association. It is retained for compatibility and is not recommended for multi-user deployments, browser dashboards, or deployments that need per-user isolation.

## Team and organization endpoints

These require a browser session, verified account, paid access under the upstream policy, and manager authorization for the specified organization.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/team/members?organizationId=...` | Lists organization members. |
| `GET` | `/api/team/hours?organizationId=...&userId=...&period=YYYY-MM` | Returns a member's monthly hours. |
| `GET` | `/api/team/preview?organizationId=...&userId=...&period=YYYY-MM` | Returns a member's report as CSV. |
| `GET` | `/api/team/settings?organizationId=...` | Reads team-level recipients and send-day settings. |
| `POST` | `/api/team/settings?organizationId=...` | Updates team-level recipients and send day. |
| `POST` or `DELETE` | `/api/team/manual-session?organizationId=...&userId=...` | Lets a manager adjust a member's time entries. |

Additional organization and invitation routes may be present elsewhere in the same request handler. Review `worker/src/index.ts` before exposing a fork publicly, especially after pulling upstream changes.

## Billing endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/stripe/webhook` | Receives Stripe webhook events. Signature verification uses `STRIPE_WEBHOOK_SECRET`. |
| `POST` | `/api/billing/checkout` | Creates a Stripe Checkout session for a supported plan. |
| `POST` | `/api/billing/portal` | Creates a Stripe customer portal session. |
| `POST` | `/api/billing/change-plan` | Changes an existing subscription with server-side plan and seat checks. |

Do not expose billing routes with placeholder secrets or another operator's Stripe Price IDs.

## Marketing endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/marketing/status` | Public | Returns marketing-agent status. |
| `POST` | `/api/marketing/run` | `Authorization: Bearer <MARKETING_AGENT_SECRET>` | Manually triggers the marketing agent; authenticated calls are rate-limited. |
| `GET` | `/{configured-indexnow-key}.txt` | Public | Serves the IndexNow verification key file when configured. |

Remove or disable these routes in a private time-tracking deployment that does not use them.

## Common HTTP responses

| Status | Meaning |
|---|---|
| `200` | Request completed successfully. |
| `400` | Invalid period, payload, recipient, send day, plan, or other input. |
| `401` | Missing or invalid browser session or bearer token. |
| `402` | Subscription or paid access is required by the upstream policy. |
| `403` | Email is unverified, role is insufficient, or the requested operation is controlled by a manager. |
| `404` | No matching route. |
| `409` | The requested billing or membership change conflicts with a seat/member constraint. |
| `429` | A route-specific rate limit was exceeded. |
| `500` or `502` | Internal processing or provider failure. |

## Local development

Create `worker/.dev.vars` and never commit it:

```dotenv
BETTER_AUTH_SECRET="replace-with-a-long-development-secret"
BETTER_AUTH_URL="http://localhost:8787"
RESEND_API_KEY=""
```

Then run:

```sh
cd worker
npx wrangler d1 migrations apply clocked --local
npm run dev
```

Health check:

```sh
curl http://localhost:8787/health
```

A minimal API exercise:

```sh
BASE=http://localhost:8787

curl -s -c cookies.txt \
  -X POST "$BASE/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"use-a-long-test-password","name":"You"}'
```

Email verification and paid-access checks still follow the current application policy. For automated local testing, use the repository's test setup or a clearly isolated development-only access override rather than weakening production authentication.

## Security checklist

Before making a deployment public:

- Replace every repository-owner account ID, database ID, domain, route, email address, and Stripe Price ID.
- Store secrets with `wrangler secret put`; never commit `.dev.vars` or production credentials.
- Use HTTPS and an exact `BETTER_AUTH_URL` matching the public origin.
- Verify email configuration before allowing sign-ups.
- Decide explicitly whether your fork uses subscription checks.
- Remove integrations and public routes you do not use.
- Keep D1 migrations current.
- Rotate exposed sync tokens and provider secrets.
- Review Cloudflare logs, D1 backups, retention, and data-deletion procedures.
- Publish a privacy policy identifying you as the operator of your deployment.

## Updating a self-hosted deployment

Pull upstream changes, inspect migrations and configuration changes, apply new remote migrations, and then deploy:

```sh
git pull
cd worker
npm install
npx wrangler d1 migrations apply clocked --remote
npx wrangler deploy
```

Always review changes to authentication, billing, migrations, endpoint behavior, and scheduled jobs before deploying them to an existing database.
