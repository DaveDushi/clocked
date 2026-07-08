/** Public marketing / SEO endpoints (robots, sitemap, press kit, llms.txt). */

const SITE = "https://clocked.daviddusi.com";

export function robotsTxtResponse(): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Allow: /download",
    "Allow: /og.jpg",
    "Allow: /press",
    "Allow: /news",
    "Allow: /llms.txt",
    "Disallow: /api/",
    "Disallow: /sessions",
    "Disallow: /preview",
    "",
    `Sitemap: ${SITE}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function sitemapXmlResponse(): Response {
  const urls = ["/", "/download", "/press", "/news", "/llms.txt"];
  const today = new Date().toISOString().slice(0, 10);
  const entries = urls
    .map(
      (path) => `  <url>
    <loc>${SITE}${path === "/" ? "/" : path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${path === "/" ? "weekly" : "monthly"}</changefreq>
    <priority>${path === "/" ? "1.0" : "0.7"}</priority>
  </url>`,
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

/** Concise product brief for AI crawlers / research tools. */
export function llmsTxtResponse(): Response {
  const body = `# clocked

> Automatic Windows time tracking from real machine activity — no timers, no screenshots.

## Product
- Desktop: open-source Windows tray app (Rust). Clocks in/out on unlock, lock, sleep, idle, quit.
- Cloud: Cloudflare Worker + D1. Sync sessions, dashboard, team plans, monthly timesheet email (Resend).
- Model: free/open desktop; paid hosted sync + email. Self-host Worker supported.

## Links
- Home: ${SITE}/
- Download: ${SITE}/download
- Source: https://github.com/DaveDushi/clocked
- Press kit: ${SITE}/press
- Health: ${SITE}/health

## Pricing (hosted)
- Solo: personal plan (~25¢/day framing on site)
- Team: up to 5 members
- Team+: up to 30 members
- Enterprise: contact sales

## Not
- Not employee surveillance / keylogging / screenshot spyware
- Not a browser extension
- Not multi-OS desktop yet (Windows only)

## Contact
- Enterprise: contact sales form on the marketing site
- Issues: https://github.com/DaveDushi/clocked/issues
`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function pressPageResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Press kit — clocked</title>
<meta name="description" content="Press kit for clocked: automatic Windows time tracking. Boilerplate, facts, links, and brand notes." />
<link rel="canonical" href="${SITE}/press" />
<meta property="og:title" content="Press kit — clocked" />
<meta property="og:description" content="Automatic Windows time tracking. No timers. Open-source desktop, paid cloud." />
<meta property="og:image" content="${SITE}/og.jpg" />
<meta property="og:url" content="${SITE}/press" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" type="image/png" href="/favicon.ico" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; --bg:#0a0b10; --panel:#151823; --border:#242938; --fg:#e9eaf0; --muted:#8b91a0; --amber:#f2a950; --mono:"IBM Plex Mono",ui-monospace,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.55 "Space Grotesk",system-ui,sans-serif; color:var(--fg); background:var(--bg); }
  body::before { content:""; position:fixed; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg, transparent, var(--amber) 30%, #ff8a3d 70%, transparent); }
  .wrap { max-width:680px; margin:0 auto; padding:36px 20px 72px; }
  a { color:var(--amber); }
  h1 { font-size:28px; margin:0 0 8px; letter-spacing:.02em; }
  h2 { font-size:18px; margin:28px 0 10px; color:var(--amber); letter-spacing:.04em; text-transform:uppercase; font-size:13px; font-family:var(--mono); }
  p, li { color:var(--muted); }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:18px 20px; margin:14px 0; }
  .card p { margin:0 0 10px; }
  .card p:last-child { margin:0; }
  code { font-family:var(--mono); font-size:13px; color:var(--fg); background:#0b0d13; padding:2px 6px; border-radius:6px; border:1px solid var(--border); }
  ul { padding-left:1.2em; }
  .nav { margin-bottom:24px; font-size:14px; }
  .nav a { margin-right:14px; text-decoration:none; color:var(--muted); }
  .nav a:hover { color:var(--fg); }
  .quote { border-left:3px solid var(--amber); padding:4px 0 4px 14px; margin:12px 0; color:var(--fg); }
</style>
</head>
<body>
<div class="wrap">
  <div class="nav">
    <a href="/">Home</a>
    <a href="/download">Download</a>
    <a href="https://github.com/DaveDushi/clocked">GitHub</a>
    <a href="/og.jpg">Brand image</a>
  </div>
  <h1>Press kit</h1>
  <p>Automatic Windows time tracking. No timers. Monthly timesheet by email.</p>

  <h2>Boilerplate</h2>
  <div class="card">
    <p><strong>clocked</strong> is automatic time tracking for Windows. A lightweight tray app clocks you in and out from real machine events — unlock, lock, sleep, and idle — so freelancers and small teams get honest hours without babysitting a timer. Sessions store locally, sync to the cloud, and produce a monthly timesheet by email even if the laptop was asleep at month-end. The desktop app is open source; hosted cloud sync and reporting is a simple paid service (self-hosting is supported).</p>
  </div>

  <h2>One-liner</h2>
  <div class="card quote">Automatic Windows time tracking. No timers. Monthly timesheet by email.</div>

  <h2>Facts</h2>
  <div class="card">
    <ul>
      <li><strong>Platform:</strong> Windows desktop (tray) + web dashboard</li>
      <li><strong>Desktop stack:</strong> Rust, local SQLite</li>
      <li><strong>Cloud stack:</strong> Cloudflare Workers, D1, better-auth, Stripe, Resend</li>
      <li><strong>License:</strong> MIT (desktop / repo)</li>
      <li><strong>Site:</strong> <a href="${SITE}/">${SITE}/</a></li>
      <li><strong>Download:</strong> <a href="${SITE}/download">${SITE}/download</a></li>
      <li><strong>Source:</strong> <a href="https://github.com/DaveDushi/clocked">github.com/DaveDushi/clocked</a></li>
    </ul>
  </div>

  <h2>What it is not</h2>
  <div class="card">
    <p>Not employee surveillance, keylogging, or screenshot spyware. It tracks presence from OS power and input events on the machine you install — for people who bill time, not for watching keystrokes.</p>
  </div>

  <h2>Assets</h2>
  <div class="card">
    <ul>
      <li>Open Graph / social image: <a href="${SITE}/og.jpg">${SITE}/og.jpg</a></li>
      <li>Favicon: <a href="${SITE}/favicon.ico">${SITE}/favicon.ico</a></li>
      <li>Launch copy kit (repo): <code>marketing/LAUNCH_KIT.md</code></li>
    </ul>
  </div>

  <h2>Contact</h2>
  <div class="card">
    <p>Product issues: GitHub Issues on the public repo.</p>
    <p>Enterprise / sales: use <strong>Contact sales</strong> on the homepage pricing section.</p>
  </div>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}
