// Self-contained landing page + dashboard (HTML + inline CSS/JS, no build step,
// no assets). Auth is better-auth (cookies, same-origin fetch); data comes from
// /api/hours, /api/settings, and /api/token. Served at GET /.
//
// Logged-out visitors see a marketing landing page with sign-up / sign-in.
// On sign-up the account is created and its per-account Bearer token is shown so
// the desktop app can be pointed at this Worker.
//
// NOTE: the inline <script> lives inside this template literal — it must not
// contain backticks or "${", so it sticks to string concatenation.
const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clocked — your hours, on the record</title>
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
  .card h3 { margin:0 0 4px; font-size:15px; letter-spacing:.02em; }
  .card .hint { color:var(--muted); font-size:13px; margin:0 0 14px; }

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
  .recipients { display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
  .recipient { display:flex; gap:8px; align-items:center; }
  .recipient input { flex:1; }
  .recipient .del { width:42px; padding:10px 0; font-size:18px; line-height:1; }
  .schedule { display:flex; flex-direction:column; gap:9px; margin:2px 0 12px; }
  .check { display:flex; align-items:center; gap:9px; margin:0; text-transform:none; letter-spacing:0; font-size:14px; color:var(--fg); cursor:pointer; }
  .check input { width:auto; margin:0; accent-color:var(--amber); }
  .sendday { display:flex; align-items:center; gap:9px; padding-left:26px; color:var(--faint); font-size:14px; }
  .sendday.off { opacity:.4; }
  .sendday select {
    width:auto; padding:8px 10px; border-radius:9px; border:1px solid var(--border);
    background:#0b0d13; color:var(--fg); font:inherit; font-family:var(--mono); cursor:pointer;
  }
  .sendday select:disabled { cursor:default; }

  button, a.btn {
    display:inline-flex; align-items:center; justify-content:center; text-decoration:none;
    padding:10px 18px; border:0; border-radius:10px; font:inherit; font-weight:700; cursor:pointer;
    color:#221503; background:linear-gradient(180deg, var(--amber), var(--amber2));
    box-shadow:0 2px 10px rgba(242,169,80,.25);
    transition:transform .12s, box-shadow .12s, opacity .12s; white-space:nowrap;
  }
  button:hover, a.btn:hover { transform:translateY(-1px); box-shadow:0 4px 16px rgba(242,169,80,.35); }
  button:active, a.btn:active { transform:translateY(0); }
  button:disabled { opacity:.5; cursor:default; transform:none; }
  button.ghost, a.btn.ghost {
    background:transparent; border:1px solid var(--border); color:var(--muted);
    font-weight:500; box-shadow:none;
  }
  button.ghost:hover, a.btn.ghost:hover { color:var(--fg); border-color:var(--faint); box-shadow:none; }
  button.nav { width:42px; padding:10px 0; font-family:var(--mono); font-size:16px; line-height:1.2; }
  .downloadCta { margin-top:18px; gap:10px; flex-wrap:wrap; justify-content:center; }
  .downloadCta .hintline { flex-basis:100%; color:var(--muted); font-size:12px; }
  :focus-visible { outline:2px solid var(--amber); outline-offset:2px; }

  /* ---------- hours table ---------- */
  /* Show seven calendar days at a time. Current month auto-scrolls to today,
     leaving the previous week visible and older days available by scrolling up. */
  .tablewrap { margin-top:16px; max-height:318px; overflow-y:auto; overscroll-behavior:contain; }
  .tablewrap::-webkit-scrollbar { width:9px; }
  .tablewrap::-webkit-scrollbar-track { background:transparent; }
  .tablewrap::-webkit-scrollbar-thumb { background:var(--border); border-radius:9px; }
  .tablewrap { scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
  table { width:100%; border-collapse:collapse; }
  thead th { position:sticky; top:0; z-index:1; background:var(--panel2); }
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

  /* ---------- landing / auth ---------- */
  .hero { text-align:center; margin:7vh auto 24px; max-width:560px; }
  .hero .logo { width:58px; height:58px; margin:0 auto 18px; border-width:3px; }
  .hero .logo::before { height:14px; }
  .hero .logo::after { height:21px; }
  .hero h1 { font-size:34px; line-height:1.15; margin:0 0 10px; letter-spacing:.02em; }
  .hero h1 small { color:var(--amber); }
  .hero p { color:var(--muted); margin:0; font-size:16px; }

  .features { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; max-width:640px; margin:0 auto 26px; }
  .feature { background:linear-gradient(180deg, var(--panel), var(--panel2)); border:1px solid var(--border); border-radius:14px; padding:14px 15px; box-shadow:inset 0 1px 0 rgba(255,255,255,.04); }
  .feature .k { font-family:var(--mono); font-size:12px; color:var(--amber); letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px; }
  .feature .v { font-size:13px; color:var(--muted); line-height:1.45; }
  @media (max-width:560px) { .features { grid-template-columns:1fr; } }

  #auth { max-width:400px; margin:0 auto; }
  .tabs { display:flex; gap:6px; margin-bottom:18px; background:#0b0d13; border:1px solid var(--border); border-radius:12px; padding:4px; }
  .tabs button { flex:1; background:transparent; color:var(--muted); box-shadow:none; font-weight:500; padding:9px 0; border-radius:9px; }
  .tabs button.active { background:linear-gradient(180deg, var(--amber), var(--amber2)); color:#221503; font-weight:700; box-shadow:0 2px 10px rgba(242,169,80,.25); }
  .field { margin-bottom:14px; }

  /* ---------- token card ---------- */
  .tokenbox { display:flex; gap:10px; align-items:stretch; }
  .token {
    flex:1; min-width:0; font-family:var(--mono); font-size:14px; color:var(--amber);
    background:#0b0d13; border:1px solid var(--border); border-radius:10px;
    padding:11px 12px; overflow-x:auto; white-space:nowrap; user-select:all;
    font-variant-ligatures:none;
  }
  .token.reveal { color:var(--amber); }
  .banner {
    border:1px solid rgba(91,214,162,.4); background:rgba(91,214,162,.08);
    border-radius:12px; padding:12px 14px; margin-bottom:16px; font-size:14px; color:var(--fg);
  }
  .banner b { color:var(--ok); }
  code.inline { font-family:var(--mono); font-size:13px; color:var(--fg); background:#0b0d13; border:1px solid var(--border); border-radius:6px; padding:1px 6px; }
  .steps { margin:12px 0 0; padding-left:18px; color:var(--muted); font-size:13px; line-height:1.6; }
  .steps code { color:var(--fg); }
  .setupbox { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  .setupbox .muted { font-size:13px; flex:1; min-width:220px; }

  .top.bare .logo, .top.bare .wordmark { display:none; }

  .muted { color:var(--muted); }
  .msg { font-size:13px; margin-top:10px; min-height:18px; }
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

  <!-- Landing (logged out) -->
  <div id="landingView" class="hidden">
    <div class="hero">
      <div class="logo" aria-hidden="true"></div>
      <h1>Your hours,<br /><small>on the record.</small></h1>
      <p>A tiny Windows tray app clocks you in and out from real machine
        activity, then syncs to your account here. Sign up and you get a token —
        paste it into the app and your timesheet builds itself.</p>
      <div class="downloadCta row">
        <a class="btn" href="/download">Download for Windows</a>
        <a class="btn ghost" href="https://github.com/DaveDushi/clocked" target="_blank" rel="noopener">View source</a>
        <div class="hintline">Installer: clocked-setup.exe</div>
      </div>
    </div>

    <div class="features">
      <div class="feature"><div class="k">Automatic</div><div class="v">Wake, unlock, and activity clock you in; sleep, lock, and idle clock you out.</div></div>
      <div class="feature"><div class="k">Private</div><div class="v">Your own account, your own sync token, your own hours — nobody else's.</div></div>
      <div class="feature"><div class="k">Monthly report</div><div class="v">A tidy timesheet emailed to you on the 1st, awake or not.</div></div>
    </div>

    <div id="auth" class="card">
      <div class="tabs">
        <button id="tabSignup" class="active">Create account</button>
        <button id="tabSignin">Sign in</button>
      </div>

      <div id="nameField" class="field">
        <label for="name">Name <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></label>
        <input id="name" type="text" autocomplete="name" />
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="new-password" />
      </div>
      <button id="authBtn" style="width:100%">Create account</button>
      <div id="authMsg" class="msg" role="status"></div>
    </div>
  </div>

  <!-- Dashboard (logged in) -->
  <div id="app" class="hidden">
    <div id="freshBanner" class="banner hidden">
      <b>Account created.</b> Your desktop sync token is below — copy it now and
      paste it into the app. You can always find it again here.
    </div>

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
      <div id="tablewrap" class="tablewrap">
        <table>
          <thead><tr><th>Day</th><th></th><th class="num">Hours</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="total"><span class="muted">Total</span><b id="totalRow">0:00</b></div>
      <div id="hoursMsg" class="msg" role="status"></div>
    </div>

    <div class="card">
      <h3>Desktop sync token</h3>
      <p class="hint">Your account's Bearer token. The desktop app sends it with every sync.</p>
      <div class="setupbox">
        <a class="btn" href="/download">Download for Windows</a>
        <span class="muted">Install Clocked, then paste this token into the tray app Settings.</span>
      </div>
      <div class="tokenbox">
        <div id="token" class="token" title="Your Bearer token">&middot;&middot;&middot;&middot;&middot;&middot;&middot;&middot;</div>
        <button id="copyToken" class="ghost">Copy</button>
        <button id="regenToken" class="ghost" title="Revoke this token and issue a new one">Regenerate</button>
      </div>
      <ol class="steps">
        <li>Right-click the clocked tray icon &rarr; <b>Settings&hellip;</b></li>
        <li>Paste the token above into <b>Bearer token</b>.</li>
        <li>Click <b>Save</b> &mdash; syncing starts automatically.</li>
      </ol>
      <div id="tokenMsg" class="msg" role="status"></div>
    </div>

    <div class="card">
      <h3>Monthly timesheet</h3>
      <p class="hint">Where your report is emailed. Add as many recipients as you like.</p>
      <div id="recipients" class="recipients"></div>
      <div class="schedule">
        <label class="check"><input type="checkbox" id="autoSend"> Email my timesheet automatically each month</label>
        <div id="sendDayWrap" class="sendday">
          <span>Send on the</span>
          <select id="sendDay"></select>
          <span>of each month.</span>
        </div>
      </div>
      <div class="row">
        <button id="addRecipient" class="ghost">+ Add recipient</button>
        <button id="saveEmail">Save</button>
        <button id="sendNow">Send now</button>
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
  $("landingView").classList.toggle("hidden", loggedIn);
  $("app").classList.toggle("hidden", !loggedIn);
  $("signout").classList.toggle("hidden", !loggedIn);
}

// ---- auth mode (sign up / sign in) ----
let mode = "signup";
function setMode(m) {
  mode = m;
  const up = m === "signup";
  $("tabSignup").classList.toggle("active", up);
  $("tabSignin").classList.toggle("active", !up);
  $("nameField").classList.toggle("hidden", !up);
  $("password").setAttribute("autocomplete", up ? "new-password" : "current-password");
  $("authBtn").textContent = up ? "Create account" : "Sign in";
  $("authMsg").textContent = ""; $("authMsg").className = "msg";
}
$("tabSignup").onclick = () => setMode("signup");
$("tabSignin").onclick = () => setMode("signin");

async function submitAuth() {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authMsg").textContent = ""; $("authMsg").className = "msg";
  if (!email || !password) { $("authMsg").textContent = "Email and password required."; $("authMsg").className = "msg err"; return; }
  if (mode === "signup" && password.length < 8) { $("authMsg").textContent = "Password must be at least 8 characters."; $("authMsg").className = "msg err"; return; }

  $("authBtn").disabled = true;
  let r, body;
  if (mode === "signup") {
    body = { email, password, name: ($("name").value.trim() || email) };
    r = await api("/api/auth/sign-up/email", { method:"POST", body: JSON.stringify(body) });
  } else {
    r = await api("/api/auth/sign-in/email", { method:"POST", body: JSON.stringify({ email, password }) });
  }
  $("authBtn").disabled = false;

  if (r.ok) {
    $("password").value = "";
    const fresh = mode === "signup";
    show(true);
    await afterLogin(fresh);
  } else {
    const e = await r.json().catch(()=>({}));
    $("authMsg").textContent = e.message || (mode === "signup" ? "Sign up failed." : "Sign in failed.");
    $("authMsg").className = "msg err";
  }
}
$("authBtn").onclick = submitAuth;
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });

// ---- session bootstrap ----
async function init() {
  const r = await api("/api/auth/get-session");
  const data = r.ok ? await r.json() : null;
  if (data && data.user) { show(true); await afterLogin(false); }
  else { show(false); setMode("signup"); $("email").focus(); }
}

async function afterLogin(fresh) {
  $("freshBanner").classList.toggle("hidden", !fresh);
  const now = new Date();
  $("month").value = now.getFullYear() + "-" + pad(now.getMonth()+1);
  await Promise.all([loadHours(), loadSettings(), loadToken()]);
}

// ---- token ----
function setToken(t) {
  $("token").textContent = t;
  $("token").classList.add("reveal");
}
async function loadToken() {
  const r = await api("/api/token");
  if (r.ok) { const d = await r.json(); setToken(d.token); }
}
$("copyToken").onclick = async () => {
  const t = $("token").textContent;
  try { await navigator.clipboard.writeText(t); $("tokenMsg").textContent = "Copied to clipboard."; $("tokenMsg").className = "msg ok"; }
  catch { $("tokenMsg").textContent = "Select the token and copy manually."; $("tokenMsg").className = "msg err"; }
};
let regenArmed = false;
$("regenToken").onclick = async () => {
  if (!regenArmed) {
    regenArmed = true;
    $("regenToken").textContent = "Confirm?";
    $("tokenMsg").textContent = "This revokes your current token — the app will need the new one."; $("tokenMsg").className = "msg";
    setTimeout(() => { regenArmed = false; $("regenToken").textContent = "Regenerate"; }, 4000);
    return;
  }
  regenArmed = false; $("regenToken").textContent = "Regenerate"; $("regenToken").disabled = true;
  const r = await api("/api/token/regenerate", { method:"POST" });
  $("regenToken").disabled = false;
  if (r.ok) { const d = await r.json(); setToken(d.token); $("tokenMsg").textContent = "New token issued — paste it into the app's Settings."; $("tokenMsg").className = "msg ok"; }
  else { $("tokenMsg").textContent = "Could not regenerate."; $("tokenMsg").className = "msg err"; }
};

// ---- hours ----
function rowHtml(x, max, i) {
  const dt = new Date(x.date + "T00:00:00");
  const wk = dt.getDay() === 0 || dt.getDay() === 6;
  const dow = dt.toLocaleDateString(undefined, { weekday:"short" });
  const pct = x.minutes > 0 ? Math.max(2, Math.round((x.minutes / max) * 100)) : 0;
  const bar = x.minutes > 0 ? "<div class='bar' style='width:" + pct + "%; animation-delay:" + (i*30) + "ms'></div>" : "";
  return "<tr title='" + x.label + "'>" +
    "<td class='day'><span class='dow" + (wk ? " wk" : "") + "'>" + dow + "</span><b>" + Number(x.date.slice(8,10)) + "</b></td>" +
    "<td class='barcell'><div class='track'>" + bar + "</div></td>" +
    "<td class='num'>" + fmt(x.minutes) + "</td></tr>";
}

function currentPeriod() {
  const now = new Date();
  return now.getFullYear() + "-" + pad(now.getMonth()+1);
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
    : "<tr class='empty'><td colspan='3'>No days to show for this month.</td></tr>";
  const tablewrap = $("tablewrap");
  tablewrap.scrollTop = period === currentPeriod() ? tablewrap.scrollHeight : 0;
  $("total").textContent = fmt(d.totalMinutes);
  $("totalRow").textContent = fmt(d.totalMinutes);
  const activeDays = d.activeDays ?? d.days.filter((x) => x.minutes > 0).length;
  $("statDays").textContent = String(activeDays);
  $("statAvg").textContent = activeDays ? fmt(Math.round(d.totalMinutes / activeDays)) : "0:00";
}

function shiftMonth(delta) {
  const v = $("month").value;
  if (!v) return;
  const parts = v.split("-");
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
  $("month").value = dt.getFullYear() + "-" + pad(dt.getMonth()+1);
  loadHours();
}

// ---- recipients ----
function addRecipientRow(value) {
  const row = document.createElement("div");
  row.className = "recipient";
  const input = document.createElement("input");
  input.type = "email"; input.placeholder = "you@example.com"; input.value = value || "";
  const del = document.createElement("button");
  del.type = "button"; del.className = "ghost del"; del.textContent = "×"; del.title = "Remove";
  del.onclick = () => { row.remove(); if (!$("recipients").children.length) addRecipientRow(""); };
  row.appendChild(input); row.appendChild(del);
  $("recipients").appendChild(row);
}
function renderRecipients(list) {
  $("recipients").innerHTML = "";
  const arr = (list && list.length) ? list : [""];
  arr.forEach(addRecipientRow);
}
function recipientValues() {
  return [...$("recipients").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
}
// ---- auto-send schedule ----
function ordinal(n) { const v = n % 100; return n + (["th","st","nd","rd"][(v > 3 && v < 21) ? 0 : (n % 10 < 4 ? n % 10 : 0)]); }
function fillSendDays() {
  const sel = $("sendDay");
  if (sel.options.length) return;
  for (let d = 1; d <= 28; d++) sel.add(new Option(ordinal(d), String(d)));
  sel.add(new Option("last day", "99")); // 99 = last day of the month
}
function syncSendDayState() {
  const on = $("autoSend").checked;
  $("sendDay").disabled = !on;
  $("sendDayWrap").classList.toggle("off", !on);
}
$("autoSend").onchange = syncSendDayState;

async function loadSettings() {
  fillSendDays();
  const r = await api("/api/settings");
  const d = r.ok ? await r.json() : { recipients: [], sendDay: 1 };
  renderRecipients(d.recipients);
  const day = Number(d.sendDay);
  $("autoSend").checked = day !== 0;
  $("sendDay").value = String(day === 0 ? 1 : day);
  syncSendDayState();
}

$("signout").onclick = async () => { await api("/api/auth/sign-out", { method:"POST" }); show(false); setMode("signin"); };
$("month").addEventListener("change", loadHours);
$("prev").onclick = () => shiftMonth(-1);
$("next").onclick = () => shiftMonth(1);

$("addRecipient").onclick = () => addRecipientRow("");

$("saveEmail").onclick = async () => {
  const recipients = recipientValues();
  $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  if (!recipients.length) { $("emailMsg").textContent = "Add at least one recipient."; $("emailMsg").className = "msg err"; return; }
  const sendDay = $("autoSend").checked ? Number($("sendDay").value) : 0;
  $("saveEmail").disabled = true;
  const r = await api("/api/settings", { method:"POST", body: JSON.stringify({ recipients, sendDay }) });
  $("saveEmail").disabled = false;
  if (r.ok) { $("emailMsg").textContent = "Saved."; $("emailMsg").className = "msg ok"; }
  else { const e = await r.json().catch(()=>({})); $("emailMsg").textContent = e.error || "Save failed."; $("emailMsg").className = "msg err"; }
};

$("sendNow").onclick = async () => {
  $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  $("sendNow").disabled = true; $("sendNow").textContent = "Sending…";
  const r = await api("/api/send?period=" + $("month").value, { method:"POST" });
  $("sendNow").disabled = false; $("sendNow").textContent = "Send now";
  const d = await r.json().catch(()=>({}));
  if (r.ok) { $("emailMsg").textContent = "Sent " + d.rows + " row(s) to " + d.recipients + " recipient(s)."; $("emailMsg").className = "msg ok"; }
  else { $("emailMsg").textContent = d.error || "Send failed."; $("emailMsg").className = "msg err"; }
};

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
