// Self-contained dashboard page (HTML + inline CSS/JS, no build step, no assets).
// Auth is better-auth (cookies, same-origin fetch); data comes from /api/hours
// and /api/settings. Served at GET /.
//
// NOTE: the inline <script> lives inside this template literal — it must not
// contain backticks or "${", so it sticks to string concatenation.
const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clocked</title>
<link rel="icon" type="image/png" href="/favicon.ico" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0b10; --panel:#151823; --panel2:#10121a; --border:#242938;
    --fg:#e9eaf0; --muted:#8b91a0; --faint:#5b6170;
    --amber:#f2a950; --amber2:#ff8a3d; --ok:#5bd6a2; --err:#ff7070;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; color:var(--fg);
    font:15px/1.5 "Space Grotesk",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:
      radial-gradient(1100px 520px at 75% -10%, rgba(242,169,80,.08), transparent 60%),
      radial-gradient(800px 480px at -10% 110%, rgba(90,120,255,.06), transparent 60%),
      var(--bg);
    background-attachment: fixed;
  }
  /* brand hairline across the very top */
  body::before {
    content:""; position:fixed; top:0; left:0; right:0; height:2px; z-index:10;
    background:linear-gradient(90deg, transparent, var(--amber) 30%, var(--amber2) 70%, transparent);
  }
  .wrap { max-width:760px; margin:0 auto; padding:28px 20px 72px; }

  /* ---------- header ---------- */
  .top { display:flex; align-items:center; gap:12px; margin-bottom:4px; }
  .top .spacer { flex:1; }
  .wordmark { font-size:21px; font-weight:700; letter-spacing:.04em; }
  .wordmark small { color:var(--amber); }
  #now {
    font-family:var(--mono); font-size:13px; color:var(--muted);
    padding:5px 10px; border:1px solid var(--border); border-radius:999px;
    background:rgba(255,255,255,.02); font-variant-numeric:tabular-nums;
  }
  #now b { color:var(--amber); font-weight:500; }

  /* animated clock-face logo */
  .logo {
    position:relative; width:34px; height:34px; border-radius:50%; flex:none;
    border:2px solid var(--amber);
    background:
      radial-gradient(circle, var(--amber) 0 1.6px, transparent 1.7px),
      repeating-conic-gradient(rgba(233,234,240,.28) 0 2deg, transparent 2deg 30deg);
    box-shadow:0 0 18px rgba(242,169,80,.25), inset 0 0 6px rgba(0,0,0,.5);
  }
  .logo::before { /* hour hand */
    content:""; position:absolute; left:calc(50% - 1px); bottom:50%; width:2px; height:8px;
    background:var(--fg); border-radius:2px; transform-origin:bottom center; transform:rotate(140deg);
  }
  .logo::after { /* sweeping second hand */
    content:""; position:absolute; left:calc(50% - .5px); bottom:50%; width:1px; height:12px;
    background:var(--amber2); transform-origin:bottom center; animation:sweep 60s linear infinite;
  }
  @keyframes sweep { from { transform:rotate(0turn); } to { transform:rotate(1turn); } }

  /* chronograph ruler under the header */
  .ruler {
    height:12px; margin:10px 0 26px;
    background-image:
      linear-gradient(90deg, rgba(233,234,240,.35) 0 1px, transparent 1px),
      linear-gradient(90deg, rgba(233,234,240,.14) 0 1px, transparent 1px);
    background-size:72px 12px, 12px 6px; /* major tick every 72px, minor every 12px */
    background-position:bottom left, bottom left;
    background-repeat:repeat-x;
    -webkit-mask-image:linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
    mask-image:linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  }

  /* ---------- cards ---------- */
  .card {
    background:linear-gradient(180deg, var(--panel), var(--panel2));
    border:1px solid var(--border); border-radius:16px; padding:20px; margin-bottom:16px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 8px 24px rgba(0,0,0,.35);
  }

  /* ---------- stat tiles ---------- */
  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px; }
  .tile {
    background:linear-gradient(180deg, var(--panel), var(--panel2));
    border:1px solid var(--border); border-radius:16px; padding:14px 16px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
  }
  .tile label { display:block; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-bottom:4px; }
  .tile b { font-family:var(--mono); font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; }
  .tile.big b { color:var(--amber); text-shadow:0 0 22px rgba(242,169,80,.45); }
  @media (max-width:480px) { .tile b { font-size:19px; } }

  /* ---------- forms ---------- */
  label { display:block; font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin-bottom:7px; }
  input {
    width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border);
    background:#0b0d13; color:var(--fg); font:inherit; transition:border-color .15s, box-shadow .15s;
  }
  input:focus { outline:none; border-color:var(--amber); box-shadow:0 0 0 3px rgba(242,169,80,.16); }
  input[type=month] { font-family:var(--mono); font-size:14px; }
  ::-webkit-calendar-picker-indicator { filter:invert(.75); cursor:pointer; }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > div { flex:1; }

  button {
    padding:10px 18px; border:0; border-radius:10px; font:inherit; font-weight:700; cursor:pointer;
    color:#221503; background:linear-gradient(180deg, var(--amber), var(--amber2));
    box-shadow:0 2px 10px rgba(242,169,80,.25);
    transition:transform .12s, box-shadow .12s, opacity .12s; white-space:nowrap;
  }
  button:hover { transform:translateY(-1px); box-shadow:0 4px 16px rgba(242,169,80,.35); }
  button:active { transform:translateY(0); }
  button:disabled { opacity:.5; cursor:default; transform:none; }
  button.ghost {
    background:transparent; border:1px solid var(--border); color:var(--muted);
    font-weight:500; box-shadow:none;
  }
  button.ghost:hover { color:var(--fg); border-color:var(--faint); box-shadow:none; }
  button.nav { width:42px; padding:10px 0; font-family:var(--mono); font-size:16px; line-height:1.2; }
  :focus-visible { outline:2px solid var(--amber); outline-offset:2px; }

  /* ---------- hours table ---------- */
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th,td { text-align:left; padding:9px 6px; border-bottom:1px solid var(--border); }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr { transition:background .12s; }
  tbody tr:hover { background:rgba(255,255,255,.025); }
  th { font-size:11px; color:var(--faint); font-weight:600; text-transform:uppercase; letter-spacing:.12em; }
  td.num, th.num { text-align:right; font-family:var(--mono); font-size:14px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.day { white-space:nowrap; width:1%; }
  td.day .dow { display:inline-block; width:3.2em; color:var(--muted); font-size:13px; }
  td.day .dow.wk { color:var(--amber); opacity:.85; }
  td.day b { font-family:var(--mono); font-weight:500; }
  td.barcell { width:99%; padding-right:14px; }
  .track { height:6px; border-radius:3px; background:rgba(255,255,255,.05); overflow:hidden; }
  .bar {
    height:100%; border-radius:3px; min-width:3px;
    background:linear-gradient(90deg, var(--amber), var(--amber2));
    box-shadow:0 0 10px rgba(242,169,80,.4);
    animation:grow .5s cubic-bezier(.2,.7,.2,1) backwards;
  }
  @keyframes grow { from { width:0; } }
  tr.empty td { color:var(--muted); padding:22px 6px; text-align:center; }

  .total { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .total b { font-family:var(--mono); font-size:26px; font-weight:600; color:var(--amber); text-shadow:0 0 22px rgba(242,169,80,.4); font-variant-numeric:tabular-nums; }

  /* ---------- login ---------- */
  .hero { text-align:center; margin:9vh auto 26px; }
  .hero .logo { width:58px; height:58px; margin:0 auto 18px; border-width:3px; }
  .hero .logo::before { height:14px; }
  .hero .logo::after { height:21px; }
  .hero h1 { font-size:30px; margin:0 0 6px; letter-spacing:.04em; }
  .hero h1 small { color:var(--amber); }
  .hero p { color:var(--muted); margin:0; font-size:14px; }
  #login { max-width:380px; margin:0 auto; }

  .top.bare .logo, .top.bare .wordmark { display:none; }

  .muted { color:var(--muted); }
  .msg { font-size:13px; margin-top:8px; min-height:18px; }
  .msg.err { color:var(--err); } .msg.ok { color:var(--ok); }
  .hidden { display:none; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top" id="topbar">
    <div class="logo" aria-hidden="true"></div>
    <div class="wordmark">clocked<small>.</small></div>
    <div class="spacer"></div>
    <div id="now" title="Current time" aria-label="Current time"></div>
    <button id="signout" class="ghost hidden">Sign out</button>
  </div>
  <div class="ruler" aria-hidden="true"></div>

  <!-- Login -->
  <div id="loginView" class="hidden">
    <div class="hero">
      <div class="logo" aria-hidden="true"></div>
      <h1>clocked<small>.</small></h1>
      <p>Your hours, on the record.</p>
    </div>
    <div id="login" class="card">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" />
      <div style="height:14px"></div>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" />
      <div style="height:16px"></div>
      <button id="loginBtn" style="width:100%">Sign in</button>
      <div id="loginMsg" class="msg" role="status"></div>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="app" class="hidden">
    <div class="stats">
      <div class="tile big"><label>Total</label><b id="total">–</b></div>
      <div class="tile"><label>Days</label><b id="statDays">–</b></div>
      <div class="tile"><label>Avg / day</label><b id="statAvg">–</b></div>
    </div>

    <div class="card">
      <div class="row">
        <button id="prev" class="ghost nav" aria-label="Previous month">&#8249;</button>
        <div>
          <label for="month">Month</label>
          <input id="month" type="month" />
        </div>
        <button id="next" class="ghost nav" aria-label="Next month">&#8250;</button>
      </div>
      <table>
        <thead><tr><th>Day</th><th></th><th class="num">Hours</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="total"><span class="muted">Total</span><b id="totalRow">0:00</b></div>
      <div id="hoursMsg" class="msg" role="status"></div>
    </div>

    <div class="card">
      <label for="mailTo">Send timesheet to</label>
      <div class="row">
        <div><input id="mailTo" type="email" placeholder="you@example.com" /></div>
        <button id="saveEmail">Save</button>
      </div>
      <div id="emailMsg" class="msg" role="status"></div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const api = (path, opts={}) => fetch(path, { credentials:"same-origin", headers:{"content-type":"application/json"}, ...opts });
const fmt = (min) => { const h = Math.floor(min/60), m = min%60; return h + ":" + String(m).padStart(2,"0"); };
const pad = (n) => String(n).padStart(2,"0");

function tick() {
  const n = new Date();
  $("now").innerHTML = pad(n.getHours()) + ":" + pad(n.getMinutes()) + "<b>:" + pad(n.getSeconds()) + "</b>";
}
setInterval(tick, 1000); tick();

function show(loggedIn) {
  $("topbar").classList.toggle("bare", !loggedIn);
  $("loginView").classList.toggle("hidden", loggedIn);
  $("app").classList.toggle("hidden", !loggedIn);
  $("signout").classList.toggle("hidden", !loggedIn);
}

async function init() {
  const r = await api("/api/auth/get-session");
  const data = r.ok ? await r.json() : null;
  if (data && data.user) { show(true); await afterLogin(); } else { show(false); $("email").focus(); }
}

async function afterLogin() {
  const now = new Date();
  $("month").value = now.getFullYear() + "-" + pad(now.getMonth()+1);
  await Promise.all([loadHours(), loadEmail()]);
}

function rowHtml(x, max, i) {
  const dt = new Date(x.date + "T00:00:00");
  const wk = dt.getDay() === 0 || dt.getDay() === 6;
  const dow = dt.toLocaleDateString(undefined, { weekday:"short" });
  const pct = Math.max(2, Math.round((x.minutes / max) * 100));
  return "<tr title='" + x.label + "'>" +
    "<td class='day'><span class='dow" + (wk ? " wk" : "") + "'>" + dow + "</span><b>" + Number(x.date.slice(8,10)) + "</b></td>" +
    "<td class='barcell'><div class='track'><div class='bar' style='width:" + pct + "%; animation-delay:" + (i*30) + "ms'></div></div></td>" +
    "<td class='num'>" + fmt(x.minutes) + "</td></tr>";
}

async function loadHours() {
  const period = $("month").value;
  if (!period) return;
  $("hoursMsg").textContent = ""; $("hoursMsg").className = "msg";
  $("rows").innerHTML = "<tr class='empty'><td colspan='3'>Loading&hellip;</td></tr>";
  const r = await api("/api/hours?period=" + period);
  if (!r.ok) {
    $("rows").innerHTML = "";
    $("hoursMsg").textContent = "Failed to load hours."; $("hoursMsg").className = "msg err";
    return;
  }
  const d = await r.json();
  const max = d.days.reduce((a,x) => Math.max(a, x.minutes), 0) || 1;
  $("rows").innerHTML = d.days.length
    ? d.days.map((x,i) => rowHtml(x, max, i)).join("")
    : "<tr class='empty'><td colspan='3'>No hours logged this month.</td></tr>";
  $("total").textContent = fmt(d.totalMinutes);
  $("totalRow").textContent = fmt(d.totalMinutes);
  $("statDays").textContent = String(d.days.length);
  $("statAvg").textContent = d.days.length ? fmt(Math.round(d.totalMinutes / d.days.length)) : "0:00";
}

function shiftMonth(delta) {
  const v = $("month").value;
  if (!v) return;
  const parts = v.split("-");
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
  $("month").value = dt.getFullYear() + "-" + pad(dt.getMonth()+1);
  loadHours();
}

async function loadEmail() {
  const r = await api("/api/settings");
  if (r.ok) { const d = await r.json(); $("mailTo").value = d.mailTo || ""; }
}

$("loginBtn").onclick = async () => {
  $("loginBtn").disabled = true; $("loginMsg").textContent = ""; $("loginMsg").className = "msg";
  const r = await api("/api/auth/sign-in/email", { method:"POST", body: JSON.stringify({ email:$("email").value.trim(), password:$("password").value }) });
  $("loginBtn").disabled = false;
  if (r.ok) { $("password").value = ""; show(true); await afterLogin(); }
  else { const e = await r.json().catch(()=>({})); $("loginMsg").textContent = e.message || "Sign in failed."; $("loginMsg").className = "msg err"; }
};

$("signout").onclick = async () => { await api("/api/auth/sign-out", { method:"POST" }); show(false); };
$("month").addEventListener("change", loadHours);
$("prev").onclick = () => shiftMonth(-1);
$("next").onclick = () => shiftMonth(1);

$("saveEmail").onclick = async () => {
  $("saveEmail").disabled = true; $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  const r = await api("/api/settings", { method:"POST", body: JSON.stringify({ mailTo:$("mailTo").value.trim() }) });
  $("saveEmail").disabled = false;
  if (r.ok) { $("emailMsg").textContent = "Saved."; $("emailMsg").className = "msg ok"; }
  else { $("emailMsg").textContent = "Save failed."; $("emailMsg").className = "msg err"; }
};

$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
init();
</script>
</body>
</html>`;

export function dashboardResponse(): Response {
  return new Response(HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
