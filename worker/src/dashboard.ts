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
    box-shadow:0 0 9px rgba(242,169,80,.14), inset 0 0 6px rgba(0,0,0,.5);
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
  .tile.big b { color:var(--amber); text-shadow:0 0 12px rgba(242,169,80,.22); }
  @media (max-width:480px) { .tile b { font-size:19px; } }

  /* ---------- forms ---------- */
  label { display:block; font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin-bottom:7px; }
  input, textarea {
    width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border);
    background:#0b0d13; color:var(--fg); font:inherit; transition:border-color .15s, box-shadow .15s;
  }
  textarea { resize:vertical; min-height:74px; }
  input:focus, textarea:focus { outline:none; border-color:var(--amber); box-shadow:0 0 0 3px rgba(242,169,80,.16); }
  input[type=month], input[type=date], input[type=time] { font-family:var(--mono); font-size:14px; }
  ::-webkit-calendar-picker-indicator { filter:invert(.75); cursor:pointer; }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > div { flex:1; }
  .recipients { display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
  .recipient { display:flex; gap:8px; align-items:center; }
  .recipient input { flex:1; }
  .recipient .del { width:42px; padding:10px 0; font-size:18px; line-height:1; }
  .mentries { margin-top:14px; display:flex; flex-direction:column; gap:8px; }
  .mentries:empty { margin-top:0; }
  .mentries-head { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); }
  .mentries-scroll { display:flex; flex-direction:column; gap:6px; max-height:196px; overflow-y:auto; overscroll-behavior:contain; padding-right:4px; }
  .mentries-scroll::-webkit-scrollbar { width:9px; }
  .mentries-scroll::-webkit-scrollbar-track { background:transparent; }
  .mentries-scroll::-webkit-scrollbar-thumb { background:var(--border); border-radius:9px; }
  .mentries-scroll { scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
  .mentry { display:flex; align-items:center; gap:10px; padding:7px 12px; border:1px solid var(--border); border-radius:9px; background:#0b0d13; }
  .mentry span { flex:1; min-width:0; font-family:var(--mono); font-size:13px; color:var(--fg); font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mentry .del { flex:none; width:34px; padding:6px 0; font-size:16px; line-height:1; }
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
    box-shadow:0 0 6px rgba(242,169,80,.22);
    animation:grow .5s cubic-bezier(.2,.7,.2,1) backwards;
  }
  @keyframes grow { from { width:0; } }
  tr.empty td { color:var(--muted); padding:22px 6px; text-align:center; }

  .total { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .total b { font-family:var(--mono); font-size:26px; font-weight:600; color:var(--amber); text-shadow:0 0 12px rgba(242,169,80,.2); font-variant-numeric:tabular-nums; }

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
  .or { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:12px; margin:14px 0; }
  .or::before, .or::after { content:""; flex:1; height:1px; background:var(--border); }

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

  /* landing header: brand stays, live clock hides, auth buttons appear right */
  .top.bare #now { display:none; }
  #topAuth { display:flex; gap:8px; }
  #topAuth.hidden { display:none; } /* id selector beats .hidden alone */
  #topAuth button { padding:8px 14px; font-size:14px; }

  /* ---------- auth modal ---------- */
  .modal { position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; padding:20px; }
  .modal.hidden { display:none; }
  .modal-backdrop { position:absolute; inset:0; background:rgba(4,5,9,.72); -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px); }
  .modal-card { position:relative; z-index:1; width:100%; max-width:400px; margin:0; padding-top:48px; animation:pop .18s cubic-bezier(.2,.7,.2,1); }
  @keyframes pop { from { opacity:0; transform:translateY(8px) scale(.98); } }
  .modal-close { position:absolute; top:12px; right:12px; width:32px; height:32px; padding:0; font-size:18px; line-height:1; }

  /* ---------- pricing ---------- */
  .price-head { text-align:center; margin:36px auto 18px; max-width:560px; }
  .price-head h2 { font-size:23px; margin:0 0 6px; letter-spacing:.02em; }
  .price-head p { color:var(--muted); font-size:15px; margin:0; }
  .pricing { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; max-width:680px; margin:0 auto 26px; }
  @media (max-width:560px) { .pricing { grid-template-columns:1fr; } }
  .price-card {
    position:relative; overflow:hidden; display:flex; flex-direction:column;
    background:linear-gradient(180deg, var(--panel), var(--panel2));
    border:1px solid var(--border); border-radius:16px; padding:22px 22px 24px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 10px 26px rgba(0,0,0,.3);
  }
  .price-card::before { content:""; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg, transparent, var(--amber) 30%, var(--amber2) 70%, transparent); }
  .price-card.enterprise { border-color:rgba(242,169,80,.35); }
  .plan-name { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); margin-bottom:10px; }
  .price-tag { display:flex; align-items:baseline; gap:6px; min-height:40px; }
  .price-num { font-family:var(--mono); font-size:40px; font-weight:600; color:var(--amber); text-shadow:0 0 12px rgba(242,169,80,.2); line-height:1; font-variant-numeric:tabular-nums; }
  .price-num.sm { font-size:26px; }
  .price-per { color:var(--muted); font-size:15px; }
  .plan-meta { color:var(--fg); font-size:14px; margin:9px 0 14px; }
  .price-list { list-style:none; margin:0 0 20px; padding:0; text-align:left; display:flex; flex-direction:column; gap:9px; flex:1; }
  .price-list li { position:relative; padding-left:24px; font-size:13.5px; color:var(--fg); }
  .price-list li::before { content:"✓"; position:absolute; left:0; top:0; color:var(--ok); font-weight:700; }
  .price-card button { margin-top:auto; }
  .price-card.selected { border-color:rgba(242,169,80,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 0 0 1px rgba(242,169,80,.25), 0 10px 26px rgba(0,0,0,.3); }
  #planGate { max-width:720px; margin:0 auto 40px; }
  #planGate .price-head { margin-top:12px; }
  #planGateWait { margin-bottom:18px; }
  #planGateOrgField { max-width:420px; margin:0 auto 18px; }
  #verifyGate { max-width:520px; margin:24px auto; }

  .muted { color:var(--muted); }
  .msg { font-size:13px; margin-top:10px; min-height:18px; }
  .msg.err { color:var(--err); } .msg.ok { color:var(--ok); }
  .hidden { display:none; }

  /* CSV preview panel */
  .preview { margin-top:14px; border:1px solid var(--border); border-radius:12px; background:var(--panel2); overflow:hidden; }
  .pv-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-bottom:1px solid var(--border); }
  .pv-head b { font-size:13px; letter-spacing:.02em; }
  .pv-head button { padding:5px 12px; font-size:13px; }
  .pv-scroll { max-height:340px; overflow:auto; }
  table.pv { border-collapse:collapse; width:100%; font-family:var(--mono); font-size:12px; }
  table.pv th, table.pv td { text-align:left; padding:6px 12px; border-bottom:1px solid var(--border); white-space:nowrap; }
  table.pv th { position:sticky; top:0; background:var(--panel); color:var(--faint); font-weight:600; text-transform:none; letter-spacing:0; }
  table.pv td { color:var(--fg); }
  table.pv tr.pv-total td { font-weight:700; color:var(--amber); border-bottom:0; }
  table.pv tr.pv-vac td { color:var(--muted); }
  .pv-empty { padding:16px; color:var(--muted); font-size:14px; }

  /* ---------- team / roster ---------- */
  .roster { display:flex; flex-direction:column; gap:8px; margin-top:14px; }
  .rosterrow { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--panel2); }
  .rosterrow .rname { font-weight:500; }
  .rosterrow .remail { font-size:12px; }
  .rosterrow .rspacer { flex:1; }
  .rosterrow button { padding:6px 10px; font-size:13px; }
  .badge { font-size:10px; letter-spacing:.1em; text-transform:uppercase; padding:3px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted); }
  .badge.mgr { color:var(--amber); border-color:rgba(242,169,80,.4); }
  .invitelink { display:flex; gap:8px; margin-top:10px; }
  .invitelink input { flex:1; font-family:var(--mono); font-size:12px; }
  #inviteRole, #orgPlan { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:#0b0d13; color:var(--fg); font:inherit; }

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
    <div id="topAuth" class="hidden">
      <button id="navSignin" class="ghost">Sign in</button>
      <button id="navSignup">Sign up</button>
    </div>
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

    <div class="price-head">
      <h2>Simple pricing</h2>
      <p>Just you or a whole team &mdash; pick a plan and start tracking.</p>
    </div>
    <div class="pricing">
      <div class="price-card">
        <div class="plan-name">Solo</div>
        <div class="price-tag"><span class="price-num">25&cent;</span><span class="price-per">/ day</span></div>
        <div class="plan-meta">Just you</div>
        <ul class="price-list">
          <li>Automatic clock in &amp; clock out</li>
          <li>Private account &amp; sync token</li>
          <li>Monthly timesheet by email</li>
        </ul>
        <button class="planCta" style="width:100%">Get started</button>
      </div>
      <div class="price-card">
        <div class="plan-name">Team</div>
        <div class="price-tag"><span class="price-num">50&cent;</span><span class="price-per">/ day</span></div>
        <div class="plan-meta">Up to 5 members</div>
        <ul class="price-list">
          <li>Everything in Solo</li>
          <li>Up to 5 members</li>
          <li>Shared timesheets</li>
        </ul>
        <button class="planCta" style="width:100%">Get started</button>
      </div>
      <div class="price-card">
        <div class="plan-name">Team+</div>
        <div class="price-tag"><span class="price-num">$1</span><span class="price-per">/ day</span></div>
        <div class="plan-meta">Up to 30 members</div>
        <ul class="price-list">
          <li>Everything in Team</li>
          <li>Up to 30 members</li>
          <li>Priority support</li>
        </ul>
        <button class="planCta" style="width:100%">Get started</button>
      </div>
      <div class="price-card enterprise">
        <div class="plan-name">Enterprise</div>
        <div class="price-tag"><span class="price-num sm">Let&rsquo;s talk</span></div>
        <div class="plan-meta">30+ members</div>
        <ul class="price-list">
          <li>Everything in Team+</li>
          <li>Unlimited members</li>
          <li>Custom invoicing &amp; SLA</li>
        </ul>
        <button id="salesCta" style="width:100%">Contact sales</button>
      </div>
    </div>

    <div id="authModal" class="modal hidden">
      <div class="modal-backdrop"></div>
      <div id="auth" class="card modal-card">
        <button id="authClose" class="ghost modal-close" aria-label="Close">&times;</button>
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
      <div class="or"><span>or</span></div>
      <button id="googleBtn" class="ghost" style="width:100%;gap:10px"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>Continue with Google</button>
      <div id="authMsg" class="msg" role="status"></div>
      </div>
    </div>

  </div>

  <!-- Dashboard (logged in) -->
  <div id="app" class="hidden">
    <div id="freshBanner" class="banner hidden">
      <b>Account created.</b> Verify your email, pick a plan, then copy your desktop sync token.
    </div>
    <div id="billingBanner" class="banner hidden">
      <b>Payment received.</b> Unlocking your dashboard&hellip;
    </div>

    <!-- Verify email first (blocking). -->
    <div id="verifyGate" class="card hidden">
      <h3>Verify your email</h3>
      <p class="hint">We sent a link to your inbox. Confirm it to choose a plan and open your dashboard.</p>
      <button id="resendVerifyGate" class="ghost">Resend verification email</button>
      <div id="verifyGateMsg" class="msg" role="status"></div>
    </div>

    <!-- Paid plan required (SaaS onboarding wall). -->
    <div id="planGate" class="hidden">
      <div class="price-head">
        <h2>Choose a plan to continue</h2>
        <p>Subscribe to unlock the dashboard, desktop sync token, and monthly timesheets.</p>
      </div>
      <div id="planGateWait" class="card hidden">
        <h3>Waiting on your team</h3>
        <p class="hint">You&rsquo;re on a team that isn&rsquo;t subscribed yet. Ask your manager to finish checkout, then refresh this page.</p>
        <button id="planGateRefresh" class="ghost">Refresh status</button>
      </div>
      <div id="planGateChooser">
        <div id="planGateOrgField" class="field">
          <label for="planGateOrgName">Team name <span class="muted" style="text-transform:none;letter-spacing:0">(for Team / Team+)</span></label>
          <input id="planGateOrgName" type="text" placeholder="Acme Inc." autocomplete="organization" />
        </div>
        <div class="pricing">
          <div class="price-card" data-plan="single">
            <div class="plan-name">Solo</div>
            <div class="price-tag"><span class="price-num">25&cent;</span><span class="price-per">/ day</span></div>
            <div class="plan-meta">Just you &middot; ~$7.50/mo</div>
            <ul class="price-list">
              <li>Desktop sync token</li>
              <li>Private hours dashboard</li>
              <li>Monthly timesheet email</li>
            </ul>
            <button type="button" class="gatePlanCta" data-plan="single" style="width:100%">Continue with Solo</button>
          </div>
          <div class="price-card" data-plan="team">
            <div class="plan-name">Team</div>
            <div class="price-tag"><span class="price-num">50&cent;</span><span class="price-per">/ day</span></div>
            <div class="plan-meta">Up to 5 members</div>
            <ul class="price-list">
              <li>Everything in Solo</li>
              <li>Invite workers</li>
              <li>Shared manager timesheets</li>
            </ul>
            <button type="button" class="gatePlanCta" data-plan="team" style="width:100%">Continue with Team</button>
          </div>
          <div class="price-card" data-plan="teamplus">
            <div class="plan-name">Team+</div>
            <div class="price-tag"><span class="price-num">$1</span><span class="price-per">/ day</span></div>
            <div class="plan-meta">Up to 30 members</div>
            <ul class="price-list">
              <li>Everything in Team</li>
              <li>Larger roster</li>
              <li>Priority support</li>
            </ul>
            <button type="button" class="gatePlanCta" data-plan="teamplus" style="width:100%">Continue with Team+</button>
          </div>
          <div class="price-card enterprise" data-plan="enterprise">
            <div class="plan-name">Enterprise</div>
            <div class="price-tag"><span class="price-num sm">Let&rsquo;s talk</span></div>
            <div class="plan-meta">30+ members</div>
            <ul class="price-list">
              <li>Everything in Team+</li>
              <li>Unlimited seats</li>
              <li>Custom invoicing &amp; SLA</li>
            </ul>
            <button type="button" id="gateSalesCta" style="width:100%">Contact sales</button>
          </div>
        </div>
      </div>
      <div id="planGateMsg" class="msg" role="status" style="text-align:center"></div>
    </div>

    <!-- Product UI — only after paid access. -->
    <div id="appMain" class="hidden">

    <!-- Team — shown to managers (org role owner/admin). Also hosts the personal
         "Single" plan view, in which the invite/roster UI is hidden. -->
    <div id="teamCard" class="card hidden">
      <h3 id="teamCardTitle">Team <span id="teamOrgName" class="muted"></span></h3>
      <p class="hint" id="teamCardHint">Invite members and open anyone&rsquo;s timesheet. Members only ever see their own hours.</p>
      <div id="teamPlanInfo" class="muted" style="font-size:13px;margin:-8px 0 12px"></div>
      <div id="billingRow" class="row" style="align-items:center;margin:-4px 0 12px">
        <span id="billingStatus" class="muted" style="font-size:13px"></span>
        <span class="rspacer" style="flex:1"></span>
        <button id="billingBtn" class="ghost">Manage billing</button>
      </div>
      <div id="billingMsg" class="msg" role="status"></div>
      <div id="inviteRow" class="row">
        <div>
          <label for="inviteEmail">Invite by email</label>
          <input id="inviteEmail" type="email" placeholder="teammate@example.com" />
        </div>
        <div style="flex:0 0 140px">
          <label for="inviteRole">Role</label>
          <select id="inviteRole">
            <option value="member">Worker</option>
            <option value="admin">Manager</option>
          </select>
        </div>
        <button id="inviteBtn">Invite</button>
      </div>
      <div id="inviteMsg" class="msg" role="status"></div>
      <div id="inviteLinkBox" class="invitelink hidden">
        <input id="inviteLink" type="text" readonly aria-label="Invite link" />
        <button id="copyInvite" class="ghost">Copy link</button>
      </div>
      <div id="roster" class="roster"></div>
      <div id="teamMemberPanel" class="preview hidden"></div>
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
      <h3>Add time manually</h3>
      <p class="hint">Log a clock-in and clock-out for a day the app missed.</p>
      <div class="row">
        <div>
          <label for="mDate">Date</label>
          <input id="mDate" type="date" />
        </div>
        <div>
          <label for="mStart">Clock in</label>
          <input id="mStart" type="time" />
        </div>
        <div>
          <label for="mEnd">Clock out</label>
          <input id="mEnd" type="time" />
        </div>
        <button id="mAdd">Add</button>
      </div>
      <div id="manualMsg" class="msg" role="status"></div>
      <div id="manualList" class="mentries"></div>
    </div>

    <div class="card">
      <h3>Desktop sync token</h3>
      <p class="hint">Your account's Bearer token. Shown in full only when created or regenerated — copy it into the desktop app immediately. Treat it like a password: anyone with it can sync sessions <b>and</b> open your dashboard from the tray app. Regenerate if it leaks.</p>
      <div id="verifyBanner" class="msg err hidden" role="status" style="margin-bottom:12px">
        Verify your email to use the dashboard, create a sync token, and send timesheets.
        <button id="resendVerify" class="ghost" style="margin-left:8px">Resend email</button>
      </div>
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
      <h3 id="emailTitle">Monthly timesheet</h3>
      <p class="hint" id="emailHint">Where your report is emailed. Add as many recipients as you like.</p>
      <div id="emailReadonly" class="hidden"></div>
      <div id="emailEdit">
        <div id="recipients" class="recipients"></div>
        <div class="schedule">
          <label class="check"><input type="checkbox" id="autoSend"> Email the timesheet automatically each month</label>
          <div id="sendDayWrap" class="sendday">
            <span>Send on the</span>
            <select id="sendDay"></select>
            <span>of each month.</span>
          </div>
        </div>
        <div class="row">
          <button id="addRecipient" class="ghost">+ Add recipient</button>
          <button id="previewBtn" class="ghost">Preview</button>
          <button id="saveEmail">Save</button>
          <button id="sendNow">Send now</button>
        </div>
      </div>
      <div id="emailMsg" class="msg" role="status"></div>
      <div id="previewPanel" class="preview hidden"></div>
    </div>
    </div><!-- /appMain -->
  </div><!-- /app -->

  <!-- Sales modal lives outside landing so plan-gate (logged-in) can open it. -->
  <div id="salesModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="card modal-card">
      <button id="salesClose" class="ghost modal-close" aria-label="Close">&times;</button>
      <h3>Contact sales</h3>
      <p class="hint">Tell us about your team and we&rsquo;ll be in touch.</p>
      <div class="field">
        <label for="sName">Name</label>
        <input id="sName" type="text" autocomplete="name" />
      </div>
      <div class="field">
        <label for="sEmail">Work email</label>
        <input id="sEmail" type="email" autocomplete="email" />
      </div>
      <div class="row">
        <div>
          <label for="sCompany">Company</label>
          <input id="sCompany" type="text" autocomplete="organization" />
        </div>
        <div>
          <label for="sTeam">Team size</label>
          <input id="sTeam" type="text" inputmode="numeric" placeholder="e.g. 45" />
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label for="sMsg">Message <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></label>
        <textarea id="sMsg" rows="3"></textarea>
      </div>
      <button id="sSubmit" style="width:100%">Send message</button>
      <div id="salesMsg" class="msg" role="status"></div>
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
  $("topAuth").classList.toggle("hidden", loggedIn);
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

// ---- auth modal (opened from the top-right nav + pricing CTA) ----
function openAuth(m) {
  setMode(m);
  $("authModal").classList.remove("hidden");
  const first = m === "signup" ? "name" : "email";
  setTimeout(() => $(first).focus(), 30);
}
function closeAuth() { $("authModal").classList.add("hidden"); }
$("navSignin").onclick = () => openAuth("signin");
$("navSignup").onclick = () => openAuth("signup");
// Remember which pricing tier the visitor clicked so post-login checkout prefers it.
let pendingPlan = "single";
document.querySelectorAll(".planCta").forEach((b) => {
  b.onclick = () => {
    const card = b.closest(".price-card");
    const nm = (card && card.querySelector(".plan-name") ? card.querySelector(".plan-name").textContent : "") || "";
    pendingPlan = /team\+/i.test(nm) ? "teamplus" : (/solo/i.test(nm) ? "single" : "team");
    try { sessionStorage.setItem("clocked_pending_plan", pendingPlan); } catch (e) {}
    openAuth("signup");
  };
});
try {
  const stored = sessionStorage.getItem("clocked_pending_plan");
  if (stored === "single" || stored === "team" || stored === "teamplus") pendingPlan = stored;
} catch (e) {}
$("authClose").onclick = closeAuth;
$("authModal").querySelector(".modal-backdrop").onclick = closeAuth;

// ---- contact sales (Enterprise tier) ----
function openSales() { $("salesModal").classList.remove("hidden"); setTimeout(() => $("sName").focus(), 30); }
function closeSales() { $("salesModal").classList.add("hidden"); }
$("salesCta").onclick = openSales;
const gateSales = $("gateSalesCta");
if (gateSales) gateSales.onclick = openSales;
$("salesClose").onclick = closeSales;
$("salesModal").querySelector(".modal-backdrop").onclick = closeSales;
$("sSubmit").onclick = async () => {
  const name = $("sName").value.trim();
  const email = $("sEmail").value.trim();
  const company = $("sCompany").value.trim();
  const teamSize = $("sTeam").value.trim();
  const message = $("sMsg").value.trim();
  $("salesMsg").textContent = ""; $("salesMsg").className = "msg";
  if (!name || !email) { $("salesMsg").textContent = "Name and work email are required."; $("salesMsg").className = "msg err"; return; }
  $("sSubmit").disabled = true; $("sSubmit").textContent = "Sending…";
  const r = await api("/api/contact-sales", { method:"POST", body: JSON.stringify({ name, email, company, teamSize, message }) });
  $("sSubmit").disabled = false; $("sSubmit").textContent = "Send message";
  const d = await r.json().catch(()=>({}));
  if (r.ok) {
    $("salesMsg").textContent = "Thanks — we'll be in touch shortly."; $("salesMsg").className = "msg ok";
    $("sName").value = $("sEmail").value = $("sCompany").value = $("sTeam").value = $("sMsg").value = "";
  } else {
    $("salesMsg").textContent = d.error || "Could not send. Please try again."; $("salesMsg").className = "msg err";
  }
};

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeAuth(); closeSales(); } });

async function submitAuth() {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authMsg").textContent = ""; $("authMsg").className = "msg";
  if (!email || !password) { $("authMsg").textContent = "Email and password required."; $("authMsg").className = "msg err"; return; }
  if (mode === "signup" && password.length < 12) { $("authMsg").textContent = "Password must be at least 12 characters."; $("authMsg").className = "msg err"; return; }

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
    closeAuth();
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

// Google OAuth: ask better-auth for the provider URL, then hand off the browser.
$("googleBtn").onclick = async () => {
  $("authMsg").textContent = ""; $("authMsg").className = "msg";
  $("googleBtn").disabled = true;
  const r = await api("/api/auth/sign-in/social", { method:"POST", body: JSON.stringify({ provider:"google", callbackURL:"/" }) });
  const data = await r.json().catch(()=>({}));
  if (r.ok && data.url) { window.location.href = data.url; return; }
  $("googleBtn").disabled = false;
  $("authMsg").textContent = data.message || "Google sign-in is unavailable.";
  $("authMsg").className = "msg err";
};

// ---- session bootstrap ----
async function init() {
  const r = await api("/api/auth/get-session");
  const data = r.ok ? await r.json() : null;
  if (data && data.user) { show(true); await afterLogin(false); }
  else { show(false); setMode("signup"); }
}

async function afterLogin(fresh) {
  $("freshBanner").classList.toggle("hidden", !fresh);
  const billingRet = new URLSearchParams(location.search).get("billing");
  if (billingRet) history.replaceState({}, "", location.pathname);
  $("billingBanner").classList.toggle("hidden", billingRet !== "success");
  const now = new Date();
  $("month").value = now.getFullYear() + "-" + pad(now.getMonth()+1);
  $("mDate").value = now.getFullYear() + "-" + pad(now.getMonth()+1) + "-" + pad(now.getDate());
  await acceptPendingInvite();

  // Entitlement gate (verify → plan → product), same shape as modern SaaS apps.
  const me = await fetchMe();
  if (!me || !me.user) {
    show(false);
    setMode("signin");
    return;
  }
  if (!me.user.emailVerified) {
    meEmail = me.user.email || "";
    setAccessStage("verify");
    return;
  }
  if (me.waitingOnTeam) {
    setAccessStage("wait");
    return;
  }
  if (!me.hasAccess) {
    setAccessStage("plan");
    highlightPendingPlan();
    if (billingRet === "success") pollForAccess();
    // Optional: auto-start checkout when they clicked a landing plan CTA.
    else if (pendingPlan === "single" || pendingPlan === "team" || pendingPlan === "teamplus") {
      // Don't auto-redirect; show the chooser with selection highlighted.
    }
    return;
  }

  setAccessStage("app");
  await applyTeamFromMe(me);
  await Promise.all([loadToken(), loadHours(), loadEmailSettings()]);
  if (billingRet === "success") {
    $("billingBanner").classList.remove("hidden");
    setTimeout(() => $("billingBanner").classList.add("hidden"), 6000);
  }
}

/** Which post-login shell is visible. */
function setAccessStage(stage) {
  const verify = stage === "verify";
  const plan = stage === "plan";
  const wait = stage === "wait";
  const app = stage === "app";
  $("verifyGate").classList.toggle("hidden", !verify);
  $("planGate").classList.toggle("hidden", !(plan || wait));
  $("planGateChooser").classList.toggle("hidden", !plan);
  $("planGateWait").classList.toggle("hidden", !wait);
  $("appMain").classList.toggle("hidden", !app);
  if (plan || wait) {
    $("teamCard").classList.add("hidden");
  }
}

async function fetchMe() {
  const r = await api("/api/me");
  if (!r.ok) return null;
  return r.json();
}

function highlightPendingPlan() {
  document.querySelectorAll("#planGate .price-card").forEach((c) => {
    c.classList.toggle("selected", c.getAttribute("data-plan") === pendingPlan);
  });
}

async function pollForAccess() {
  $("planGateMsg").textContent = "Confirming payment…";
  $("planGateMsg").className = "msg ok";
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const me = await fetchMe();
    if (me && me.hasAccess) {
      $("planGateMsg").textContent = "";
      try { sessionStorage.removeItem("clocked_pending_plan"); } catch (e) {}
      await afterLogin(false);
      return;
    }
  }
  $("planGateMsg").textContent = "Payment is processing — click refresh in a moment, or re-open this page.";
  $("planGateMsg").className = "msg";
}

async function startCheckout(plan) {
  $("planGateMsg").textContent = "";
  $("planGateMsg").className = "msg";
  if (plan === "enterprise") { openSales(); return; }
  if (plan !== "single" && plan !== "team" && plan !== "teamplus") return;
  pendingPlan = plan;
  try { sessionStorage.setItem("clocked_pending_plan", plan); } catch (e) {}
  highlightPendingPlan();

  const body = { plan };
  if (plan === "team" || plan === "teamplus") {
    const name = ($("planGateOrgName").value || "").trim();
    if (name) body.organizationName = name;
    if (orgId && isManagerRoleC(orgRole)) body.organizationId = orgId;
  }
  document.querySelectorAll(".gatePlanCta").forEach((b) => { b.disabled = true; });
  $("planGateMsg").textContent = "Redirecting to secure checkout…";
  $("planGateMsg").className = "msg";
  const r = await api("/api/billing/checkout", { method: "POST", body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  document.querySelectorAll(".gatePlanCta").forEach((b) => { b.disabled = false; });
  if (r.ok && d.url) { window.location.href = d.url; return; }
  $("planGateMsg").textContent = d.error || "Could not start checkout. Try again.";
  $("planGateMsg").className = "msg err";
}

document.querySelectorAll(".gatePlanCta").forEach((b) => {
  b.onclick = () => startCheckout(b.getAttribute("data-plan") || "");
});
if ($("planGateRefresh")) $("planGateRefresh").onclick = () => afterLogin(false);
if ($("resendVerifyGate")) {
  $("resendVerifyGate").onclick = async () => {
    const email = meEmail || ($("email") && $("email").value) || "";
    if (!email) {
      $("verifyGateMsg").textContent = "Missing account email — sign out and sign in again.";
      $("verifyGateMsg").className = "msg err";
      return;
    }
    // better-auth requires `email` in the body (optional callbackURL).
    const r = await api("/api/auth/send-verification-email", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
    const d = await r.json().catch(() => ({}));
    $("verifyGateMsg").textContent = r.ok
      ? "Verification email sent — check your inbox."
      : (d.message || d.error || "Could not send verification email.");
    $("verifyGateMsg").className = r.ok ? "msg ok" : "msg err";
  };
}

// ---- teams / organizations ----------------------------------------------
// A manager (org role owner/admin) sees the Team card: invite members and open
// any member's timesheet. Membership actions hit better-auth's own
// /api/auth/organization/* endpoints; hours reads hit our guarded /api/team/*.
let orgId = "", orgName = "", orgRole = "", meEmail = "", openMemberId = "", openMemberName = "";
let orgCap = 0, orgPlanLabel = "", orgPlanKey = "", billingStatus = "";
let emailMode = "solo"; // "solo" | "manager" | "member" — who controls timesheet delivery

function isManagerRoleC(role) {
  return String(role || "").split(",").some((r) => { const t = r.trim(); return t === "owner" || t === "admin"; });
}
function roleLabel(role) { return isManagerRoleC(role) ? "Manager" : "Worker"; }

// If arriving from an invite link (/?invitation=ID) while signed in, accept it.
async function acceptPendingInvite() {
  const inv = new URLSearchParams(location.search).get("invitation");
  if (!inv) return;
  await api("/api/auth/organization/accept-invitation", { method:"POST", body: JSON.stringify({ invitationId: inv }) });
  history.replaceState({}, "", location.pathname);
}

async function applyTeam() {
  const me = await fetchMe();
  if (!me) { configureEmailCard(); return; }
  await applyTeamFromMe(me);
}

async function applyTeamFromMe(me) {
  orgId = ""; orgName = ""; orgRole = ""; openMemberId = ""; emailMode = "solo";
  orgPlanKey = ""; billingStatus = "";
  $("teamCard").classList.add("hidden");
  $("teamMemberPanel").classList.add("hidden");
  $("inviteLinkBox").classList.add("hidden");
  meEmail = (me.user && me.user.email) || "";
  const mgr = (me.orgs || []).find((o) => isManagerRoleC(o.role));
  if (mgr) {
    emailMode = "manager";
    orgId = mgr.organizationId; orgName = mgr.name || ""; orgRole = mgr.role || "";
    orgCap = mgr.cap || 0; orgPlanLabel = mgr.planLabel || "Team";
    orgPlanKey = mgr.plan || ""; billingStatus = mgr.billingStatus || "";
    $("teamOrgName").textContent = orgName ? "· " + orgName : "";
    $("teamCard").classList.remove("hidden");
    configureBillingUI();
    updateTeamUsage(mgr.memberCount || 0);
    if (orgPlanKey !== "single") await loadRoster();
  } else if (me.orgs && me.orgs.length) {
    emailMode = "member";
    const mem = me.orgs[0];
    orgId = mem.organizationId || "";
    orgRole = mem.role || "";
    billingStatus = mem.billingStatus || "";
    orgPlanKey = mem.plan || "";
  }
  configureEmailCard();
}

// A "single"-plan org is a personal account: hide the team invite/roster UI and
// relabel the card. Any org shows its subscription state + a subscribe/manage CTA.
function configureBillingUI() {
  const single = orgPlanKey === "single";
  const active = billingStatus === "active" || billingStatus === "trialing" || billingStatus === "past_due";
  $("inviteRow").classList.toggle("hidden", single);
  $("roster").classList.toggle("hidden", single);
  $("teamOrgName").classList.toggle("hidden", single);
  $("teamCardTitle").firstChild.textContent = single ? "Your plan " : "Team ";
  $("teamCardHint").textContent = single
    ? "Your personal subscription."
    : "Invite members and open anyone's timesheet — adjust their entries before it sends. Members only ever see their own hours.";
  $("billingStatus").textContent = active
    ? ("Subscribed · " + billingStatus)
    : "No active subscription";
  $("billingBtn").textContent = active ? "Manage billing" : "Subscribe";
}

$("billingBtn").onclick = async () => {
  const active = billingStatus === "active" || billingStatus === "trialing" || billingStatus === "past_due";
  $("billingMsg").textContent = ""; $("billingMsg").className = "msg";
  $("billingBtn").disabled = true;
  const path = active ? "/api/billing/portal" : "/api/billing/checkout";
  // Unpaid single/personal: upgrade via single plan. Team orgs use team tier.
  const plan = orgPlanKey === "single" || !orgPlanKey ? "single" : (orgPlanKey === "teamplus" ? "teamplus" : "team");
  const payload = active ? { organizationId: orgId } : { plan, organizationId: orgId };
  const r = await api(path, { method:"POST", body: JSON.stringify(payload) });
  const d = await r.json().catch(()=>({}));
  $("billingBtn").disabled = false;
  if (r.ok && d.url) { window.location.href = d.url; return; }
  $("billingMsg").textContent = d.error || "Could not open billing."; $("billingMsg").className = "msg err";
};

// Point the timesheet-email card at the right owner: managers edit the team's
// destination, members see it read-only, solo users edit their own.
function configureEmailCard() {
  if (emailMode === "manager") {
    $("emailTitle").textContent = "Team timesheets";
    $("emailHint").textContent = "Where every member's timesheet is emailed. This applies to the whole team.";
    $("emailEdit").classList.remove("hidden");
    $("emailReadonly").classList.add("hidden");
  } else if (emailMode === "member") {
    $("emailTitle").textContent = "Your timesheet";
    $("emailHint").textContent = "Your team manager sets where your timesheet is emailed.";
    $("emailEdit").classList.add("hidden");
    $("emailReadonly").classList.remove("hidden");
  } else {
    $("emailTitle").textContent = "Monthly timesheet";
    $("emailHint").textContent = "Where your report is emailed. Add as many recipients as you like.";
    $("emailEdit").classList.remove("hidden");
    $("emailReadonly").classList.add("hidden");
  }
}

// Reflect the pricing tier: "Team plan · 3 / 5 members" and gate invites at cap.
function updateTeamUsage(count) {
  if (orgPlanKey === "single") { $("teamPlanInfo").textContent = "Single plan · personal account"; return; }
  const unlimited = orgCap >= 1000000;
  const capTxt = unlimited ? "unlimited" : String(orgCap);
  const full = !unlimited && count >= orgCap;
  $("teamPlanInfo").textContent = orgPlanLabel + " plan · " + count + " / " + capTxt + " member" + (count === 1 ? "" : "s") + (full ? " · seat limit reached" : "");
  $("inviteBtn").disabled = full;
  $("inviteBtn").title = full ? "Upgrade your plan to invite more members" : "";
}

async function loadRoster() {
  const box = $("roster");
  box.innerHTML = "<div class='muted' style='font-size:13px'>Loading members…</div>";
  const r = await api("/api/team/members?organizationId=" + encodeURIComponent(orgId));
  if (!r.ok) { box.innerHTML = "<div class='msg err'>Could not load members.</div>"; return; }
  const d = await r.json();
  renderRoster(d.members || []);
  updateTeamUsage((d.members || []).length);
}

function renderRoster(members) {
  const box = $("roster");
  box.innerHTML = "";
  members.forEach((m) => {
    const row = document.createElement("div");
    row.className = "rosterrow";
    const name = document.createElement("span"); name.className = "rname"; name.textContent = m.name || m.email;
    const email = document.createElement("span"); email.className = "remail muted"; email.textContent = m.email;
    const spacer = document.createElement("span"); spacer.className = "rspacer";
    const badge = document.createElement("span");
    badge.className = "badge" + (isManagerRoleC(m.role) ? " mgr" : ""); badge.textContent = roleLabel(m.role);
    const view = document.createElement("button");
    view.type = "button"; view.className = "ghost"; view.textContent = "View hours";
    view.onclick = () => openMember(m.id, m.name || m.email);
    row.appendChild(name); row.appendChild(email); row.appendChild(spacer); row.appendChild(badge); row.appendChild(view);
    if (m.email && m.email !== meEmail) {
      const del = document.createElement("button");
      del.type = "button"; del.className = "ghost del"; del.textContent = "×"; del.title = "Remove from team";
      del.onclick = () => removeMember(m.email);
      row.appendChild(del);
    }
    box.appendChild(row);
  });
}

async function removeMember(email) {
  $("inviteMsg").textContent = ""; $("inviteMsg").className = "msg";
  const r = await api("/api/auth/organization/remove-member", { method:"POST", body: JSON.stringify({ memberIdOrEmail: email, organizationId: orgId }) });
  if (r.ok) { loadRoster(); }
  else { const d = await r.json().catch(()=>({})); $("inviteMsg").textContent = d.message || d.error || "Could not remove member."; $("inviteMsg").className = "msg err"; }
}

function openMember(id, name) {
  openMemberId = id; openMemberName = name;
  loadTeamMemberHours();
}
function closeMember() {
  openMemberId = "";
  const p = $("teamMemberPanel"); p.classList.add("hidden"); p.innerHTML = "";
}

async function loadTeamMemberHours() {
  if (!openMemberId) return;
  const period = $("month").value || currentPeriod();
  const panel = $("teamMemberPanel");
  panel.classList.remove("hidden");
  panel.innerHTML = "<div class='pv-head'><b>" + pvEsc(openMemberName) + " — " + pvEsc(period) + "</b><button id='tmClose' class='ghost'>Close</button></div><div class='pv-empty'>Loading…</div>";
  $("tmClose").onclick = closeMember;
  const r = await api("/api/team/hours?organizationId=" + encodeURIComponent(orgId) + "&userId=" + encodeURIComponent(openMemberId) + "&period=" + period);
  if (!r.ok) {
    panel.innerHTML = "<div class='pv-head'><b>" + pvEsc(openMemberName) + "</b><button id='tmClose' class='ghost'>Close</button></div><div class='pv-empty'>Could not load hours.</div>";
    $("tmClose").onclick = closeMember;
    return;
  }
  renderTeamMember(await r.json(), period);
}

function renderTeamMember(d, period) {
  const panel = $("teamMemberPanel");
  const head = "<div class='pv-head'><b>" + pvEsc(openMemberName) + " — " + pvEsc(period) + "</b><button id='tmClose' class='ghost'>Close</button></div>";
  const max = d.days.reduce((a,x) => Math.max(a, x.minutes), 0) || 1;
  const rows = d.days.length
    ? d.days.map((x,i) => rowHtml(x, max, i)).join("")
    : "<tr class='empty'><td colspan='3'>No days to show for this month.</td></tr>";
  const activeDays = d.activeDays ?? d.days.filter((x) => x.minutes > 0).length;
  const summary = "<div class='muted' style='padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px'>Total <b style='color:var(--amber)'>" + fmt(d.totalMinutes) + "</b> &middot; " + activeDays + " day(s)</div>";
  panel.innerHTML = head + summary + "<div class='tablewrap'><table><thead><tr><th>Day</th><th></th><th class='num'>Hours</th></tr></thead><tbody>" + rows + "</tbody></table></div>" + tmEditHtml();
  $("tmClose").onclick = closeMember;
  wireTeamEdit(period);
  loadTeamManual(period);
}

// ---- manager adjustments to a member's timesheet -------------------------
function teamManualUrl(period) {
  let u = "/api/team/manual-session?organizationId=" + encodeURIComponent(orgId) + "&userId=" + encodeURIComponent(openMemberId);
  if (period) u += "&period=" + period;
  return u;
}
function tmEditHtml() {
  return "<div style='padding:14px 12px 4px;border-top:1px solid var(--border)'>" +
    "<div class='mentries-head' style='margin-bottom:8px'>Adjust timesheet</div>" +
    "<div class='row'>" +
      "<div><label for='tmDate'>Date</label><input id='tmDate' type='date'></div>" +
      "<div><label for='tmStart'>Clock in</label><input id='tmStart' type='time'></div>" +
      "<div><label for='tmEnd'>Clock out</label><input id='tmEnd' type='time'></div>" +
      "<button id='tmAdd'>Add</button>" +
    "</div>" +
    "<div id='tmManualMsg' class='msg' role='status'></div>" +
    "<div id='tmManualList' class='mentries'></div>" +
  "</div>";
}
function wireTeamEdit(period) {
  const now = new Date();
  const cur = now.getFullYear() + "-" + pad(now.getMonth()+1);
  $("tmDate").value = period === cur ? period + "-" + pad(now.getDate()) : period + "-01";
  $("tmAdd").onclick = addTeamManual;
}
async function addTeamManual() {
  const date = $("tmDate").value, start = $("tmStart").value, end = $("tmEnd").value;
  $("tmManualMsg").textContent = ""; $("tmManualMsg").className = "msg";
  if (!date || !start || !end) { $("tmManualMsg").textContent = "Date, clock in, and clock out are all required."; $("tmManualMsg").className = "msg err"; return; }
  if (end <= start) { $("tmManualMsg").textContent = "Clock out must be after clock in."; $("tmManualMsg").className = "msg err"; return; }
  $("tmAdd").disabled = true;
  const r = await api(teamManualUrl(), { method:"POST", body: JSON.stringify({ date, start, end }) });
  $("tmAdd").disabled = false;
  if (r.ok) { loadTeamMemberHours(); } // rebuilds the panel with new totals + entries
  else { const d = await r.json().catch(()=>({})); $("tmManualMsg").textContent = d.error || "Could not add entry."; $("tmManualMsg").className = "msg err"; }
}
async function loadTeamManual(period) {
  const r = await api(teamManualUrl(period));
  if (!r.ok) { $("tmManualList").innerHTML = ""; return; }
  const d = await r.json();
  renderTeamManual(d.entries || []);
}
function renderTeamManual(list) {
  const box = $("tmManualList");
  box.innerHTML = "";
  if (!list.length) return;
  const head = document.createElement("div");
  head.className = "mentries-head";
  head.textContent = "Manual entries this month (" + list.length + ")";
  box.appendChild(head);
  list.forEach((e) => {
    const row = document.createElement("div");
    row.className = "mentry";
    const label = document.createElement("span");
    label.textContent = e.date + "  ·  " + e.start + "–" + e.end;
    const del = document.createElement("button");
    del.type = "button"; del.className = "ghost del"; del.textContent = "×"; del.title = "Delete this entry";
    del.onclick = () => deleteTeamManual(e.id);
    row.appendChild(label); row.appendChild(del);
    box.appendChild(row);
  });
}
async function deleteTeamManual(id) {
  const r = await api(teamManualUrl(), { method:"DELETE", body: JSON.stringify({ id }) });
  if (r.ok) { loadTeamMemberHours(); }
  else { const d = await r.json().catch(()=>({})); $("tmManualMsg").textContent = d.error || "Could not delete."; $("tmManualMsg").className = "msg err"; }
}

$("inviteBtn").onclick = async () => {
  const email = $("inviteEmail").value.trim();
  const role = $("inviteRole").value;
  $("inviteMsg").textContent = ""; $("inviteMsg").className = "msg";
  $("inviteLinkBox").classList.add("hidden");
  if (!email) { $("inviteMsg").textContent = "Enter an email to invite."; $("inviteMsg").className = "msg err"; return; }
  $("inviteBtn").disabled = true;
  const r = await api("/api/auth/organization/invite-member", { method:"POST", body: JSON.stringify({ email, role, organizationId: orgId }) });
  $("inviteBtn").disabled = false;
  const d = await r.json().catch(()=>({}));
  if (!r.ok) { $("inviteMsg").textContent = d.message || d.error || "Could not create invite."; $("inviteMsg").className = "msg err"; return; }
  const invId = d.id || (d.invitation && d.invitation.id) || "";
  if (invId) {
    $("inviteLink").value = location.origin + "/?invitation=" + invId;
    $("inviteLinkBox").classList.remove("hidden");
    $("inviteMsg").textContent = "Invite created — send this link to " + email + "."; $("inviteMsg").className = "msg ok";
  } else {
    $("inviteMsg").textContent = "Invite sent to " + email + "."; $("inviteMsg").className = "msg ok";
  }
  $("inviteEmail").value = "";
  loadRoster();
};

$("copyInvite").onclick = async () => {
  try { await navigator.clipboard.writeText($("inviteLink").value); $("inviteMsg").textContent = "Link copied."; $("inviteMsg").className = "msg ok"; }
  catch { $("inviteLink").select(); }
};

// ---- token (full secret only on create/rotate; otherwise prefix only) ----
let fullToken = "";
function setTokenView(d) {
  fullToken = d.token || "";
  if (fullToken) {
    $("token").textContent = fullToken;
    $("token").classList.add("reveal");
    $("tokenMsg").textContent = "Copy this token now - it will not be shown again.";
    $("tokenMsg").className = "msg ok";
  } else if (d.prefix) {
    $("token").textContent = d.prefix + " (hidden)";
    $("token").classList.add("reveal");
  } else {
    $("token").textContent = "........";
    $("token").classList.remove("reveal");
  }
}
async function loadToken() {
  const r = await api("/api/token");
  if (r.status === 403) {
    $("verifyBanner").classList.remove("hidden");
    return;
  }
  if (r.status === 402) {
    // Shouldn't reach appMain without paid access; re-run gate.
    setAccessStage("plan");
    return;
  }
  $("verifyBanner").classList.add("hidden");
  if (r.ok) { const d = await r.json(); setTokenView(d); }
}
const resendBtn = $("resendVerify");
if (resendBtn) resendBtn.onclick = async () => {
  const email = meEmail || "";
  if (!email) {
    $("tokenMsg").textContent = "Missing account email — sign out and sign in again.";
    $("tokenMsg").className = "msg err";
    return;
  }
  const r = await api("/api/auth/send-verification-email", {
    method: "POST",
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  const d = await r.json().catch(() => ({}));
  $("tokenMsg").textContent = r.ok
    ? "Verification email sent — check your inbox."
    : (d.message || d.error || "Could not send verification email.");
  $("tokenMsg").className = r.ok ? "msg ok" : "msg err";
};
$("copyToken").onclick = async () => {
  if (!fullToken) {
    $("tokenMsg").textContent = "Full token is hidden. Click Regenerate to mint a new one you can copy.";
    $("tokenMsg").className = "msg";
    return;
  }
  try { await navigator.clipboard.writeText(fullToken); $("tokenMsg").textContent = "Copied to clipboard."; $("tokenMsg").className = "msg ok"; }
  catch { $("tokenMsg").textContent = "Select the token and copy manually."; $("tokenMsg").className = "msg err"; }
};
let regenArmed = false;
$("regenToken").onclick = async () => {
  if (!regenArmed) {
    regenArmed = true;
    $("regenToken").textContent = "Confirm?";
    $("tokenMsg").textContent = "This revokes your current token - the app will need the new one."; $("tokenMsg").className = "msg";
    setTimeout(() => { regenArmed = false; $("regenToken").textContent = "Regenerate"; }, 4000);
    return;
  }
  regenArmed = false; $("regenToken").textContent = "Regenerate"; $("regenToken").disabled = true;
  const r = await api("/api/token/regenerate", { method:"POST" });
  $("regenToken").disabled = false;
  if (r.ok) { const d = await r.json(); setTokenView(d); $("tokenMsg").textContent = "New token issued - paste it into the app's Settings now."; $("tokenMsg").className = "msg ok"; }
  else { const e = await r.json().catch(()=>({})); $("tokenMsg").textContent = e.error || "Could not regenerate."; $("tokenMsg").className = "msg err"; }
};

// ---- hours ----
function rowHtml(x, max, i) {
  const dt = new Date(x.date + "T00:00:00");
  const wk = dt.getDay() === 0 || dt.getDay() === 6;
  const dow = dt.toLocaleDateString(undefined, { weekday:"short" });
  const pct = x.minutes > 0 ? Math.max(2, Math.round((x.minutes / max) * 100)) : 0;
  const bar = x.minutes > 0 ? "<div class='bar' style='width:" + pct + "%; animation-delay:" + (i*30) + "ms'></div>" : "";
  return "<tr title='" + pvEsc(String(x.label || "")).replace(/'/g, "&#39;") + "'>" +
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
  loadManualEntries();
  if (openMemberId) loadTeamMemberHours(); // keep an open team member in sync with the month
}

function shiftMonth(delta) {
  const v = $("month").value;
  if (!v) return;
  const parts = v.split("-");
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
  $("month").value = dt.getFullYear() + "-" + pad(dt.getMonth()+1);
  loadHours();
}

// ---- manual time entry ----
$("mAdd").onclick = async () => {
  const date = $("mDate").value, start = $("mStart").value, end = $("mEnd").value;
  $("manualMsg").textContent = ""; $("manualMsg").className = "msg";
  if (!date || !start || !end) { $("manualMsg").textContent = "Date, clock in, and clock out are all required."; $("manualMsg").className = "msg err"; return; }
  if (end <= start) { $("manualMsg").textContent = "Clock out must be after clock in."; $("manualMsg").className = "msg err"; return; }
  $("mAdd").disabled = true;
  const r = await api("/api/manual-session", { method:"POST", body: JSON.stringify({ date, start, end }) });
  $("mAdd").disabled = false;
  const d = await r.json().catch(()=>({}));
  if (r.ok) {
    $("manualMsg").textContent = "Added " + date + ", " + start + "–" + end + "."; $("manualMsg").className = "msg ok";
    $("mStart").value = ""; $("mEnd").value = "";
    if (date.slice(0,7) === $("month").value) loadHours();
    else loadManualEntries();
  } else {
    $("manualMsg").textContent = d.error || "Could not add entry."; $("manualMsg").className = "msg err";
  }
};

function renderManualEntries(list) {
  const box = $("manualList");
  box.innerHTML = "";
  if (!list.length) return;
  const head = document.createElement("div");
  head.className = "mentries-head";
  head.textContent = "Manual entries this month (" + list.length + ")";
  box.appendChild(head);
  const scroll = document.createElement("div");
  scroll.className = "mentries-scroll";
  list.forEach((e) => {
    const row = document.createElement("div");
    row.className = "mentry";
    const label = document.createElement("span");
    label.textContent = e.date + "  ·  " + e.start + "–" + e.end;
    const del = document.createElement("button");
    del.type = "button"; del.className = "ghost del"; del.textContent = "×"; del.title = "Delete this entry";
    del.onclick = () => deleteManualEntry(e.id);
    row.appendChild(label); row.appendChild(del);
    scroll.appendChild(row);
  });
  box.appendChild(scroll);
}

async function loadManualEntries() {
  const period = $("month").value;
  if (!period) return;
  const r = await api("/api/manual-session?period=" + period);
  if (!r.ok) { $("manualList").innerHTML = ""; return; }
  const d = await r.json();
  renderManualEntries(d.entries || []);
}

async function deleteManualEntry(id) {
  $("manualMsg").textContent = ""; $("manualMsg").className = "msg";
  const r = await api("/api/manual-session", { method:"DELETE", body: JSON.stringify({ id }) });
  if (r.ok) {
    $("manualMsg").textContent = "Deleted."; $("manualMsg").className = "msg ok";
    loadHours();
  } else {
    const d = await r.json().catch(()=>({}));
    $("manualMsg").textContent = d.error || "Could not delete."; $("manualMsg").className = "msg err";
  }
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

async function loadEmailSettings() {
  fillSendDays();
  if (emailMode === "manager") {
    const r = await api("/api/team/settings?organizationId=" + encodeURIComponent(orgId));
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1, defaultRecipients: [] };
    // Prefill with the managers' emails until an explicit destination is saved.
    renderRecipients((d.recipients && d.recipients.length) ? d.recipients : (d.defaultRecipients || []));
    setSchedule(d.sendDay);
  } else if (emailMode === "member") {
    const r = await api("/api/settings");
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1 };
    renderEmailReadonly(d.recipients || [], d.sendDay);
  } else {
    const r = await api("/api/settings");
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1 };
    renderRecipients(d.recipients);
    setSchedule(d.sendDay);
  }
}

function setSchedule(day) {
  day = Number(day);
  $("autoSend").checked = day !== 0;
  $("sendDay").value = String(day === 0 ? 1 : day);
  syncSendDayState();
}

function renderEmailReadonly(recipients, sendDay) {
  const day = Number(sendDay);
  const when = day === 0
    ? "not emailed automatically"
    : (day === 99 ? "emailed on the last day of each month" : "emailed on the " + ordinal(day) + " of each month");
  const who = (recipients && recipients.length) ? recipients.map(pvEsc).join(", ") : "your manager";
  $("emailReadonly").innerHTML = "<p class='muted' style='font-size:13.5px;margin:0;line-height:1.6'>Your monthly timesheet is " + when + " to <b style='color:var(--fg)'>" + who + "</b> — set by your team manager.</p>";
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
  const path = emailMode === "manager"
    ? "/api/team/settings?organizationId=" + encodeURIComponent(orgId)
    : "/api/settings";
  $("saveEmail").disabled = true;
  const r = await api(path, { method:"POST", body: JSON.stringify({ recipients, sendDay }) });
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

// ---- CSV preview ----
function pvParseLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function pvEsc(s) { return String(s).replace(/[&<>]/g, (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"); }
function pvClose() { const p = $("previewPanel"); p.classList.add("hidden"); p.innerHTML = ""; }
function renderPreview(csv, period) {
  const panel = $("previewPanel");
  const header = "<div class='pv-head'><b>Preview — " + pvEsc(period) + "</b><button id='pvCloseBtn' class='ghost'>Close</button></div>";
  const text = csv.trim();
  if (!text) {
    panel.innerHTML = header + "<div class='pv-empty'>No sessions recorded for this month.</div>";
  } else {
    const rows = text.split(String.fromCharCode(10)).map(pvParseLine);
    const head = rows[0];
    let html = header + "<div class='pv-scroll'><table class='pv'><thead><tr>";
    for (let i = 0; i < head.length; i++) html += "<th>" + pvEsc(head[i]) + "</th>";
    html += "</tr></thead><tbody>";
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.join("") === "") continue; // skip the blank spacer row
      const cls = cells.indexOf("Total") !== -1 ? " class='pv-total'" : (cells.indexOf("Vacation") !== -1 ? " class='pv-vac'" : "");
      html += "<tr" + cls + ">";
      for (let c = 0; c < head.length; c++) html += "<td>" + pvEsc(cells[c] || "") + "</td>";
      html += "</tr>";
    }
    panel.innerHTML = html + "</tbody></table></div>";
  }
  panel.classList.remove("hidden");
  $("pvCloseBtn").onclick = pvClose;
}
$("previewBtn").onclick = async () => {
  const period = $("month").value;
  $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  $("previewBtn").disabled = true; $("previewBtn").textContent = "Loading…";
  const r = await api("/preview?period=" + period);
  $("previewBtn").disabled = false; $("previewBtn").textContent = "Preview";
  if (!r.ok) { $("emailMsg").textContent = "Preview failed."; $("emailMsg").className = "msg err"; return; }
  renderPreview(await r.text(), period);
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
