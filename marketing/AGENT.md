# Marketing agent

Autonomous worker that runs **daily at 14:00 UTC** on the clocked Cloudflare Worker.

## What it does (always)

1. **IndexNow** — notifies Bing/Yandex of key URLs (`/`, `/download`, `/press`, `/news`, …)
2. **Site tip** — publishes one tip/day to the public feed at `/news`
3. **Logs** — stores run results in D1 (`marketing_runs`)

## What it does (optional X)

If you set all four OAuth 1.0a user-context secrets, it may post to X **at most once every 3 days**:

```bash
cd worker
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_TOKEN_SECRET
```

Create an X developer app with **Read and Write**, generate user access tokens for the account you want to post from.

## Manual run

```bash
npx wrangler secret put MARKETING_AGENT_SECRET   # long random string

curl -X POST https://clocked.daviddusi.com/api/marketing/run \
  -H "Authorization: Bearer YOUR_SECRET"
```

## Status

https://clocked.daviddusi.com/api/marketing/status  
https://clocked.daviddusi.com/news  

## What it will never do

- Create fake social accounts
- Cold-email strangers
- Spam forums
- Bypass platform ToS
