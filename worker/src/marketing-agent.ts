/**
 * Autonomous marketing agent for clocked.
 *
 * Runs on a schedule (Worker cron). Always:
 *   - IndexNow: tell Bing/Yandex about key URLs (legitimate SEO, not spam)
 *   - Rotate a public tip/post on the site feed
 *   - Log every run to D1
 *
 * Optionally (when secrets are set):
 *   - Post to X via OAuth 1.0a user context (X_API_KEY, X_API_SECRET,
 *     X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)
 *
 * Does NOT create fake social accounts or cold-email spam.
 */

import type { Env } from "./types";

const SITE = "https://clocked.daviddusi.com";
const INDEXNOW_KEY_META = "indexnow_key";

interface Tip {
  title: string;
  body: string;
  x: string;
}

/** Curated tips — rotated into the public feed; also used for optional X posts. */
const TIP_POOL: Tip[] = [
  {
    title: "No more timer babysitting",
    body: "clocked clocks you in on unlock and out on lock/idle — so your timesheet matches real presence, not the last time you remembered to click Start.",
    x: "Stop babysitting a timer. clocked (Windows) clocks in/out from unlock, lock, and idle — then emails a monthly timesheet. https://clocked.daviddusi.com",
  },
  {
    title: "Laptop asleep? Report still sends",
    body: "Sessions live on your PC and sync when you're online. The cloud emails the monthly timesheet on schedule even if the laptop was closed that day.",
    x: "Your laptop can be asleep at month-end. clocked still emails the timesheet from the cloud. https://clocked.daviddusi.com",
  },
  {
    title: "Open-source desktop, paid cloud",
    body: "The tray app is open source. Hosted sync, dashboard, and email are the convenience layer — or self-host the Worker.",
    x: "Open-source Windows tray time tracker + optional cloud sync. Not spyware — power & input events only. https://clocked.daviddusi.com https://github.com/DaveDushi/clocked",
  },
  {
    title: "Built for people who bill hours",
    body: "Freelancers, consultants, small agencies — honest hours without screenshots or keylogging.",
    x: "For freelancers who bill time: automatic Windows tracking from real PC events. No screenshots. No keylogging. https://clocked.daviddusi.com",
  },
  {
    title: "Teams without surveillance theater",
    body: "Managers see member hours and can fix wrong clockings. Workers aren't live-monitored — hours come from the app they installed.",
    x: "Team timesheets without surveillance theater. Managers review hours; the tray app tracks presence, not keystrokes. https://clocked.daviddusi.com",
  },
  {
    title: "Idle is not billable",
    body: "After idle timeout, clocked ends the session at last input so coffee runs don't inflate the day.",
    x: "Idle ≠ billable. clocked backdates clock-out to last input after idle — clean hours by default. https://clocked.daviddusi.com",
  },
  {
    title: "One token, sync done",
    body: "Create an account, paste the clk_ token into tray Settings, and sessions sync over HTTPS.",
    x: "Install tray app → account → paste sync token. Hours accumulate. Monthly CSV email. That's the whole loop. https://clocked.daviddusi.com",
  },
  {
    title: "Timesheets that survive a closed laptop",
    body: "Your sessions live on your PC and sync when online, but the monthly email is sent from the cloud — so a laptop that's shut on the 1st doesn't cost you the invoice.",
    x: "Bill on the 1st? clocked emails your timesheet from the cloud even if your laptop's shut. https://clocked.daviddusi.com",
  },
  {
    title: "Invoice-ready CSV, every month",
    body: "The monthly email carries a day-by-day CSV: total hours, days worked, vacation days flagged. Drop it straight into an invoice or a client report — no manual tallying.",
    x: "Month-end = a CSV in your inbox with total hours, days worked, and vacation flagged. Invoice, done. https://clocked.daviddusi.com",
  },
  {
    title: "Presence, not keystrokes",
    body: "clocked reads OS power and input events — unlock, lock, sleep, idle. It never records what you type, what's on screen, or which apps you use. Honest hours, zero surveillance.",
    x: "clocked tracks presence from unlock/lock/idle — never keystrokes, screens, or app names. Time tracking you can show a client. https://clocked.daviddusi.com",
  },
  {
    title: "Cheaper than the timer you forget",
    body: "A forgotten timer costs you real billed hours every week. clocked is a few cents a day and never forgets to start — it pays for itself the first time you'd have missed an afternoon.",
    x: "The timer you forgot to start cost more than a whole year of clocked. Automatic tracking, cents a day. https://clocked.daviddusi.com",
  },
  {
    title: "Fix a wrong clocking in two clicks",
    body: "Miss an idle timeout or leave the PC unlocked overnight? Open the dashboard, delete the bad session or add a manual one. Managers can correct any team member's hours the same way.",
    x: "Bad clocking from an overnight unlock? Delete it or add a manual entry in two clicks. Managers can fix the whole team's. https://clocked.daviddusi.com",
  },
];

export interface MarketingRunResult {
  ok: boolean;
  summary: string;
  actions: { name: string; ok: boolean; detail: string }[];
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Ensure IndexNow API key exists (and is served at /{key}.txt). */
export async function ensureIndexNowKey(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM marketing_meta WHERE key = ?`)
    .bind(INDEXNOW_KEY_META)
    .first<{ value: string }>();
  if (row?.value && /^[a-f0-9]{8,128}$/i.test(row.value)) return row.value;

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    `INSERT INTO marketing_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(INDEXNOW_KEY_META, key)
    .run();
  return key;
}

export async function indexNowKeyFileResponse(env: Env, pathname: string): Promise<Response | null> {
  // IndexNow hosts the key as https://host/{key}.txt
  const m = pathname.match(/^\/([a-f0-9]{8,128})\.txt$/i);
  if (!m) return null;
  const key = await ensureIndexNowKey(env);
  if (m[1].toLowerCase() !== key.toLowerCase()) return null;
  return new Response(key, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}

async function submitIndexNow(env: Env): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = await ensureIndexNowKey(env);
    const urlList = [
      `${SITE}/`,
      `${SITE}/download`,
      `${SITE}/press`,
      `${SITE}/llms.txt`,
      `${SITE}/news`,
      `${SITE}/sitemap.xml`,
    ];
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "clocked.daviddusi.com",
        key,
        keyLocation: `${SITE}/${key}.txt`,
        urlList,
      }),
    });
    // 200/202/204 accepted; 400 often "already known"; 429 rate-limit still means the channel works.
    const ok =
      res.status === 200 ||
      res.status === 202 ||
      res.status === 204 ||
      res.status === 400 ||
      res.status === 429;
    const text = (await res.text()).slice(0, 200);
    return { ok, detail: `IndexNow HTTP ${res.status}${text ? ": " + text : ""}` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

/**
 * Pick the tip least recently posted on a channel (never-posted first), so the
 * feed and X cycle through the whole pool before repeating — and each channel
 * rotates independently instead of echoing the same daily tip. Falls back to
 * pool order if the history query fails.
 */
async function pickFreshTip(env: Env, channel: string): Promise<Tip> {
  let lastByTitle = new Map<string, string>();
  try {
    const res = await env.DB.prepare(
      `SELECT title, MAX(created_at) AS last FROM marketing_posts WHERE channel = ? GROUP BY title`,
    )
      .bind(channel)
      .all<{ title: string; last: string }>();
    lastByTitle = new Map((res.results ?? []).map((r) => [r.title, r.last] as const));
  } catch {
    /* fall back to pool order */
  }
  // "" (never posted) sorts before any ISO timestamp; Array.sort is stable so
  // ties keep pool order.
  return [...TIP_POOL].sort((a, b) =>
    (lastByTitle.get(a.title) ?? "").localeCompare(lastByTitle.get(b.title) ?? ""),
  )[0]!;
}

async function publishSiteTip(env: Env): Promise<{ ok: boolean; detail: string; postId?: string }> {
  try {
    const tip = await pickFreshTip(env, "site");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Dedupe: one tip per calendar day
    const existing = await env.DB.prepare(
      `SELECT id FROM marketing_posts WHERE kind = 'tip' AND created_at >= ? LIMIT 1`,
    )
      .bind(now.slice(0, 10))
      .first();
    if (existing) {
      return { ok: true, detail: "tip already published today", postId: (existing as { id: string }).id };
    }
    await env.DB.prepare(
      `INSERT INTO marketing_posts (id, kind, title, body, created_at, channel)
       VALUES (?, 'tip', ?, ?, ?, 'site')`,
    )
      .bind(id, tip.title, tip.body + "\n\n" + tip.x, now)
      .run();
    return { ok: true, detail: `published tip: ${tip.title}`, postId: id };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

/** OAuth 1.0a HMAC-SHA1 for X API user-context posts. */
async function oauth1Header(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string,
): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: "1.0",
  };
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k]!)}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(paramStr)}`;
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(base));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  params.oauth_signature = sig;
  const header =
    "OAuth " +
    Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}="${enc(params[k]!)}"`)
      .join(", ");
  return header;
}

async function maybePostToX(env: Env): Promise<{ ok: boolean; detail: string }> {
  const ck = env.X_API_KEY;
  const cs = env.X_API_SECRET;
  const at = env.X_ACCESS_TOKEN;
  const ats = env.X_ACCESS_TOKEN_SECRET;
  if (!ck || !cs || !at || !ats) {
    return {
      ok: true,
      detail: "X skipped (set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET to enable)",
    };
  }

  // At most one X post every 3 days.
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT id FROM marketing_posts WHERE channel = 'x' AND created_at >= ? LIMIT 1`,
  )
    .bind(cutoff)
    .first();
  if (recent) return { ok: true, detail: "X skipped (posted within last 3 days)" };

  const tip = await pickFreshTip(env, "x");
  const url = "https://api.x.com/2/tweets";
  try {
    const auth = await oauth1Header("POST", url, ck, cs, at, ats);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: tip.x }),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, detail: `X HTTP ${res.status}: ${body.slice(0, 180)}` };
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO marketing_posts (id, kind, title, body, created_at, channel)
       VALUES (?, 'tip', ?, ?, ?, 'x')`,
    )
      .bind(id, tip.title, tip.x + "\n\n" + body.slice(0, 500), new Date().toISOString())
      .run();
    return { ok: true, detail: `posted to X: ${tip.title}` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

/** Full agent cycle — safe to call from cron or authenticated manual trigger. */
export async function runMarketingAgent(env: Env): Promise<MarketingRunResult> {
  const actions: MarketingRunResult["actions"] = [];

  const indexNow = await submitIndexNow(env);
  actions.push({ name: "indexnow", ok: indexNow.ok, detail: indexNow.detail });

  const tip = await publishSiteTip(env);
  actions.push({ name: "site_tip", ok: tip.ok, detail: tip.detail });

  const x = await maybePostToX(env);
  actions.push({ name: "x", ok: x.ok, detail: x.detail });

  const ok = actions.every((a) => a.ok);
  const summary = actions.map((a) => `${a.name}:${a.ok ? "ok" : "fail"}`).join(" · ");
  const runId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO marketing_runs (id, ran_at, ok, summary, details) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(runId, new Date().toISOString(), ok ? 1 : 0, summary, JSON.stringify(actions))
      .run();
  } catch (e) {
    console.error("marketing_runs insert failed:", String((e as Error)?.message ?? e));
  }

  return { ok, summary, actions };
}

export async function marketingStatusResponse(env: Env): Promise<Response> {
  try {
    const runs = await env.DB.prepare(
      `SELECT id, ran_at, ok, summary FROM marketing_runs ORDER BY ran_at DESC LIMIT 10`,
    ).all();
    const posts = await env.DB.prepare(
      `SELECT id, kind, title, channel, created_at FROM marketing_posts ORDER BY created_at DESC LIMIT 20`,
    ).all();
    const xConfigured = !!(
      env.X_API_KEY &&
      env.X_API_SECRET &&
      env.X_ACCESS_TOKEN &&
      env.X_ACCESS_TOKEN_SECRET
    );
    return json({
      agent: "clocked-marketing-agent",
      site: SITE,
      xConfigured,
      recentRuns: runs.results ?? [],
      recentPosts: posts.results ?? [],
      note: xConfigured
        ? "X posting enabled (max 1 post / 3 days)."
        : "X posting disabled until OAuth 1.0a secrets are set. IndexNow + site tips still run.",
    });
  } catch (e) {
    return json({ error: "marketing tables missing — apply migrations", detail: String(e) }, 503);
  }
}

export async function newsPageResponse(env: Env): Promise<Response> {
  let posts: { title: string; body: string; created_at: string; channel: string | null }[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT title, body, created_at, channel FROM marketing_posts ORDER BY created_at DESC LIMIT 30`,
    ).all<{ title: string; body: string; created_at: string; channel: string | null }>();
    posts = res.results ?? [];
  } catch {
    /* empty until migration */
  }

  const items = posts
    .map(
      (p) => `<article class="card">
  <div class="meta">${escapeHtml(p.created_at.slice(0, 10))} · ${escapeHtml(p.channel || "site")}</div>
  <h2>${escapeHtml(p.title)}</h2>
  <p>${escapeHtml(p.body).replace(/\n/g, "<br/>")}</p>
</article>`,
    )
    .join("\n");

  // Blog structured data for search rich results. `</` is neutralised so a body
  // string can never break out of the script tag.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "clocked — news & tips",
    url: `${SITE}/news`,
    blogPost: posts.slice(0, 10).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      datePublished: p.created_at,
      articleBody: p.body,
      url: `${SITE}/news`,
      publisher: { "@type": "Organization", name: "clocked", url: SITE },
    })),
  }).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>News — clocked</title>
<meta name="description" content="Tips and updates from the clocked marketing agent." />
<link rel="canonical" href="${SITE}/news" />
<link rel="alternate" type="application/rss+xml" title="clocked news &amp; tips" href="${SITE}/news.xml" />
<script type="application/ld+json">${jsonLd}</script>
<meta property="og:image" content="${SITE}/og.jpg" />
<link rel="icon" href="/favicon.ico" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme:dark; --bg:#0a0b10; --panel:#151823; --border:#242938; --fg:#e9eaf0; --muted:#8b91a0; --amber:#f2a950; --mono:"IBM Plex Mono",monospace; }
  body { margin:0; font:16px/1.55 "Space Grotesk",system-ui,sans-serif; color:var(--fg); background:var(--bg); }
  body::before { content:""; position:fixed; inset:0 0 auto; height:2px; background:linear-gradient(90deg,transparent,var(--amber),#ff8a3d,transparent); }
  .wrap { max-width:640px; margin:0 auto; padding:36px 20px 72px; }
  a { color:var(--amber); text-decoration:none; }
  h1 { margin:0 0 8px; font-size:28px; }
  .lead { color:var(--muted); margin:0 0 24px; }
  .nav { margin-bottom:20px; font-size:14px; }
  .nav a { color:var(--muted); margin-right:12px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px 18px; margin-bottom:12px; }
  .card h2 { margin:0 0 8px; font-size:17px; }
  .card p { margin:0; color:var(--muted); font-size:14.5px; }
  .meta { font-family:var(--mono); font-size:11px; color:var(--amber); letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .empty { color:var(--muted); font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="nav"><a href="/">Home</a><a href="/press">Press</a><a href="/download">Download</a><a href="/news.xml">RSS</a><a href="/api/marketing/status">Agent status</a></div>
  <h1>News & tips</h1>
  <p class="lead">Published by the clocked marketing agent (IndexNow + site tips daily; optional X when configured).</p>
  ${items || '<p class="empty">Agent has not published yet — first cron run will seed tips.</p>'}
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** RSS 2.0 feed of recent posts — syndication + discovery for /news. */
export async function newsFeedResponse(env: Env): Promise<Response> {
  let posts: { title: string; body: string; created_at: string }[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT title, body, created_at FROM marketing_posts ORDER BY created_at DESC LIMIT 30`,
    ).all<{ title: string; body: string; created_at: string }>();
    posts = res.results ?? [];
  } catch {
    /* empty until migration */
  }

  const items = posts
    .map(
      (p) => `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${SITE}/news</link>
      <guid isPermaLink="false">${escapeHtml(p.created_at + "|" + p.title)}</guid>
      <pubDate>${new Date(p.created_at).toUTCString()}</pubDate>
      <description>${escapeHtml(p.body)}</description>
    </item>`,
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>clocked — news &amp; tips</title>
    <link>${SITE}/news</link>
    <description>Tips and updates for clocked, automatic Windows time tracking.</description>
    <language>en</language>
${items}
  </channel>
</rss>
`;
  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=900",
    },
  });
}

export { json as marketingJson };
