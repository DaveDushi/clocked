import { createTimesheetView } from "./timesheet-view.js";
import { WORKSPACE_MARKUP } from "./workspace-markup.js";
import { WORKSPACE_SCRIPT } from "./workspace-script.js";
import { WORKSPACE_STYLE } from "./workspace-style.js";

// Self-contained landing page + dashboard (HTML + inline CSS/JS, no build step,
// no assets). Auth is better-auth (cookies, same-origin fetch); data comes from
// /api/hours, /api/settings, and /api/token. Served at GET /.
//
// New accounts require an invitation. Verified invitees join their team before
// the dashboard exposes desktop sync and timesheets.
//
// The lifecycle function is serialized below. Handwritten inline JS uses string concatenation.
const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clocked — automatic Windows time tracking</title>
<meta name="description" content="Automatic time tracking for Windows and macOS. Clock in from unlock and activity, clock out from lock and idle. Optional project labels, cloud sync, teams, and monthly timesheet email." />
<meta name="theme-color" content="#0a0b10" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="https://clocked.daviddusi.com/" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://clocked.daviddusi.com/" />
<meta property="og:title" content="clocked — automatic Windows time tracking" />
<meta property="og:description" content="Automatic time tracking with an open-source desktop app. Request hosted access for yourself or your team, with cloud sync and monthly timesheet email." />
<meta property="og:image" content="https://clocked.daviddusi.com/og.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="675" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="clocked — automatic Windows time tracking" />
<meta name="twitter:description" content="Automatic time tracking for Windows. No timers. No spyware. Monthly timesheet by email." />
<meta name="twitter:image" content="https://clocked.daviddusi.com/og.jpg" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"clocked","applicationCategory":"BusinessApplication","operatingSystem":"Windows, macOS","description":"Automatic time tracking from power and session events. Local SQLite, optional project attribution, cloud sync, teams, and monthly timesheet email.","url":"https://clocked.daviddusi.com/","downloadUrl":"https://clocked.daviddusi.com/download","softwareVersion":"0.1.14","license":"https://opensource.org/licenses/MIT","codeRepository":"https://github.com/DaveDushi/clocked"}
</script>
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
  .wrap { max-width:800px; margin:0 auto; padding:22px 20px 64px; }
  #appMain { animation:fadein .2s ease; }
  @keyframes fadein { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

  /* ---------- dashboard nav ---------- */
  .dash-nav {
    display:flex; gap:4px; margin:0 0 18px; padding:4px;
    background:#0b0d13; border:1px solid var(--border); border-radius:14px;
    overflow-x:auto; -webkit-overflow-scrolling:touch;
  }
  .dash-nav button {
    flex:1; min-width:0; padding:10px 12px; border-radius:10px; font-weight:500;
    background:transparent; color:var(--muted); box-shadow:none; font-size:13.5px;
  }
  .dash-nav button:hover { color:var(--fg); transform:none; box-shadow:none; }
  .dash-nav button.active {
    background:linear-gradient(180deg, var(--amber), var(--amber2)); color:#221503; font-weight:700;
    box-shadow:0 2px 10px rgba(242,169,80,.25);
  }
  .dash-panel { display:none; }
  .dash-panel.active { display:block; animation:fadein .18s ease; }

  .section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:12px; }
  .section-head h3 { margin:0; font-size:16px; }
  .section-head .hint { margin:0; color:var(--muted); font-size:13px; }
  details.soft {
    border:1px solid var(--border); border-radius:12px; background:#0b0d13; padding:0 14px; margin-top:14px;
  }
  details.soft > summary {
    cursor:pointer; list-style:none; padding:12px 0; font-size:13.5px; font-weight:600; color:var(--fg);
    display:flex; align-items:center; justify-content:space-between; gap:8px;
  }
  details.soft > summary::-webkit-details-marker { display:none; }
  details.soft > summary::after { content:"+"; color:var(--muted); font-family:var(--mono); font-weight:500; }
  details.soft[open] > summary::after { content:"–"; }
  details.soft .soft-body { padding:0 0 14px; }
  .hours-toolbar { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; }
  .hours-toolbar .month-field { flex:1; min-width:160px; }
  .inline-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .token-help { font-size:12.5px; color:var(--muted); margin:10px 0 0; line-height:1.5; }

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
  .sendday { display:flex; align-items:center; gap:9px; padding-left:26px; color:var(--faint); font-size:14px; flex-wrap:wrap; }
  .sendday.off { opacity:.4; }
  .sendday select, .sendday input {
    width:auto; padding:8px 10px; border-radius:9px; border:1px solid var(--border);
    background:#0b0d13; color:var(--fg); font:inherit; font-family:var(--mono); cursor:pointer;
  }
  .sendday input[type=time] { width:126px; }
  .sendday input[list] { width:min(240px, 100%); }
  .sendday select:disabled, .sendday input:disabled { cursor:default; }

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
  tbody tr.day-row { cursor:pointer; }
  tbody tr.day-row:hover { background:rgba(242,169,80,.06); }
  tbody tr.day-row.selected { background:rgba(242,169,80,.1); }
  tbody tr.day-row.selected td { border-bottom-color:rgba(242,169,80,.25); }

  /* ---------- day timeline ---------- */
  .timeline-panel {
    margin-top:16px; border:1px solid var(--border); border-radius:12px;
    background:#0b0d13; overflow:hidden;
  }
  .timeline-panel.hidden { display:none; }
  .timeline-head {
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:12px 14px; border-bottom:1px solid var(--border);
  }
  .timeline-head b { font-size:13.5px; letter-spacing:.02em; }
  .timeline-head .sub { font-size:12.5px; color:var(--muted); font-weight:400; margin-left:8px; }
  /* 24h clock face: one full turn = midnight→midnight */
  .timeline-body {
    display:grid; grid-template-columns:minmax(200px, 240px) 1fr; gap:0; align-items:stretch;
  }
  @media (max-width:560px) {
    .timeline-body { grid-template-columns:1fr; }
  }
  .timeline-clock-wrap {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:18px 14px 16px; border-right:1px solid var(--border); gap:10px;
  }
  @media (max-width:560px) {
    .timeline-clock-wrap { border-right:0; border-bottom:1px solid var(--border); padding-bottom:14px; }
  }
  .timeline-clock {
    width:200px; height:200px; display:block;
    filter:drop-shadow(0 0 18px rgba(242,169,80,.12));
  }
  .timeline-clock .face-ring { fill:none; stroke:rgba(255,255,255,.06); stroke-width:14; }
  .timeline-clock .face-rim { fill:none; stroke:var(--border); stroke-width:1.5; }
  .timeline-clock .face-hub {
    fill:var(--bg); stroke:var(--amber); stroke-width:2;
  }
  .timeline-clock .tick { stroke:rgba(233,234,240,.22); stroke-width:1.5; stroke-linecap:round; }
  .timeline-clock .tick.major { stroke:rgba(233,234,240,.45); stroke-width:2; }
  .timeline-clock .hour-label {
    fill:var(--faint); font-family:var(--mono); font-size:9px; text-anchor:middle; dominant-baseline:central;
    letter-spacing:.04em;
  }
  .timeline-clock .arc {
    fill:none; stroke:url(#clockArcGrad); stroke-width:14; stroke-linecap:butt;
  }
  .timeline-clock .arc.manual { stroke:#5aa8e8; }
  .timeline-clock .center-total {
    fill:var(--amber); font-family:var(--mono); font-size:18px; font-weight:600;
    text-anchor:middle; dominant-baseline:central;
  }
  .timeline-clock .center-label {
    fill:var(--faint); font-family:var(--mono); font-size:8px; letter-spacing:.14em;
    text-anchor:middle; dominant-baseline:central; text-transform:uppercase;
  }
  .timeline-clock-legend {
    display:flex; gap:12px; font-size:11px; color:var(--muted); font-family:var(--mono);
  }
  .timeline-clock-legend span { display:inline-flex; align-items:center; gap:5px; }
  .timeline-clock-legend i {
    display:inline-block; width:10px; height:10px; border-radius:50%;
    background:linear-gradient(180deg, var(--amber), var(--amber2));
  }
  .timeline-clock-legend i.manual { background:#5aa8e8; }
  .timeline-list {
    display:flex; flex-direction:column; gap:0; max-height:280px; overflow-y:auto;
    min-height:0;
  }
  .timeline-item {
    display:grid; grid-template-columns:88px 1fr auto; gap:10px; align-items:center;
    padding:10px 14px; border-top:1px solid var(--border); font-size:13px;
  }
  .timeline-item:first-child { border-top:0; }
  .timeline-item .t {
    font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--fg); font-size:12.5px;
  }
  .timeline-item .reasons { display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-width:0; }
  .reason-pill {
    font-family:var(--mono); font-size:11px; letter-spacing:.04em;
    padding:2px 8px; border-radius:999px; border:1px solid var(--border);
    color:var(--muted); background:rgba(255,255,255,.02); white-space:nowrap;
  }
  .reason-pill.in { color:var(--ok); border-color:rgba(91,214,162,.35); background:rgba(91,214,162,.08); }
  .reason-pill.out { color:var(--amber); border-color:rgba(242,169,80,.35); background:rgba(242,169,80,.08); }
  .timeline-item .dur {
    font-family:var(--mono); font-size:12.5px; color:var(--muted); font-variant-numeric:tabular-nums;
  }
  .timeline-empty { padding:18px 14px; color:var(--muted); font-size:13.5px; text-align:center; }
  .timeline-hint { margin:10px 0 0; font-size:12.5px; color:var(--faint); }

  /* ---------- compare (hosted vs self-host) ---------- */
  .compare { max-width:720px; margin:0 auto 36px; }
  .compare h2 { text-align:center; font-size:22px; margin:0 0 6px; letter-spacing:.02em; }
  .compare > p { text-align:center; color:var(--muted); font-size:14.5px; margin:0 0 16px; line-height:1.5; }
  .compare-wrap {
    overflow-x:auto; border:1px solid var(--border); border-radius:14px;
    background:linear-gradient(180deg, var(--panel), var(--panel2));
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
  }
  table.compare-table { width:100%; border-collapse:collapse; min-width:520px; }
  table.compare-table th, table.compare-table td {
    text-align:left; padding:12px 14px; border-bottom:1px solid var(--border);
    font-size:13.5px; vertical-align:top;
  }
  table.compare-table tr:last-child th, table.compare-table tr:last-child td { border-bottom:0; }
  table.compare-table thead th {
    font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint);
    background:rgba(0,0,0,.2); position:sticky; top:0;
  }
  table.compare-table tbody th {
    font-weight:600; color:var(--fg); width:34%;
  }
  table.compare-table td { color:var(--muted); line-height:1.45; }
  table.compare-table .yes { color:var(--ok); }
  table.compare-table .no { color:var(--faint); }
  table.compare-table .hosted-col { color:var(--fg); }
  .compare-note { text-align:center; font-size:12.5px; color:var(--faint); margin:12px 0 0; line-height:1.5; }

  .total { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .total b { font-family:var(--mono); font-size:26px; font-weight:600; color:var(--amber); text-shadow:0 0 12px rgba(242,169,80,.2); font-variant-numeric:tabular-nums; }

  /* ---------- landing / auth ---------- */
  .hero { text-align:center; margin:5vh auto 28px; max-width:620px; }
  .hero .logo { width:58px; height:58px; margin:0 auto 18px; border-width:3px; }
  .hero .logo::before { height:14px; }
  .hero .logo::after { height:21px; }
  .hero .eyebrow {
    display:inline-block; font-family:var(--mono); font-size:12px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--amber); margin:0 0 14px; padding:5px 10px; border:1px solid rgba(242,169,80,.3); border-radius:999px;
    background:rgba(242,169,80,.06);
  }
  .hero h1 { font-size:36px; line-height:1.12; margin:0 0 12px; letter-spacing:.02em; }
  .hero h1 small { color:var(--amber); }
  .hero p { color:var(--muted); margin:0 auto; font-size:16.5px; max-width:520px; line-height:1.55; }
  .hero .trust { margin:14px 0 0; font-size:12.5px; color:var(--faint); }

  .features { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; max-width:720px; margin:0 auto 28px; }
  .feature { background:linear-gradient(180deg, var(--panel), var(--panel2)); border:1px solid var(--border); border-radius:14px; padding:16px 15px; box-shadow:inset 0 1px 0 rgba(255,255,255,.04); text-align:left; }
  .feature .k { font-family:var(--mono); font-size:12px; color:var(--amber); letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px; }
  .feature .v { font-size:13.5px; color:var(--muted); line-height:1.5; }
  @media (max-width:720px) { .features { grid-template-columns:repeat(2,1fr); } }
  @media (max-width:560px) { .features { grid-template-columns:1fr; } .hero h1 { font-size:30px; } }

  .how { max-width:720px; margin:0 auto 32px; }
  .how h2 { text-align:center; font-size:22px; margin:0 0 6px; letter-spacing:.02em; }
  .how > p { text-align:center; color:var(--muted); font-size:14.5px; margin:0 0 16px; }
  .how-steps { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  @media (max-width:560px) { .how-steps { grid-template-columns:1fr; } }
  .how-step {
    background:linear-gradient(180deg, var(--panel), var(--panel2)); border:1px solid var(--border);
    border-radius:14px; padding:16px; box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
  }
  .how-step .n { font-family:var(--mono); font-size:12px; color:var(--amber); letter-spacing:.1em; margin-bottom:8px; }
  .how-step h3 { margin:0 0 6px; font-size:15px; }
  .how-step p { margin:0; font-size:13.5px; color:var(--muted); line-height:1.5; }

  .audience { max-width:720px; margin:0 auto 32px; text-align:center; }
  .audience h2 { font-size:22px; margin:0 0 6px; }
  .audience > p { color:var(--muted); font-size:14.5px; margin:0 0 14px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
  .chip {
    font-size:13px; color:var(--fg); padding:8px 12px; border-radius:999px;
    border:1px solid var(--border); background:rgba(255,255,255,.02);
  }

  .faq { max-width:640px; margin:8px auto 40px; }
  .faq h2 { text-align:center; font-size:22px; margin:0 0 14px; }
  .faq details {
    border:1px solid var(--border); border-radius:12px; background:linear-gradient(180deg, var(--panel), var(--panel2));
    padding:0 16px; margin-bottom:8px;
  }
  .faq summary { cursor:pointer; list-style:none; padding:14px 0; font-weight:600; font-size:14.5px; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq details p { margin:0 0 14px; color:var(--muted); font-size:14px; line-height:1.55; }

  .footer-note { text-align:center; color:var(--faint); font-size:12.5px; margin:8px auto 24px; max-width:520px; line-height:1.5; }
  .footer-note a { color:var(--muted); }

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
  .token-create { display:flex; gap:10px; margin-top:12px; }
  .token-create input { flex:1; min-width:0; }
  .token-list { margin-top:14px; border-top:1px solid var(--border); }
  .token-row { display:flex; align-items:center; gap:10px; padding:11px 0; border-bottom:1px solid var(--border); }
  .token-row-main { flex:1; min-width:0; }
  .token-row-name { font-size:13.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .token-row-meta { margin-top:3px; color:var(--muted); font:12px var(--mono); }
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

  /* ---------- request hosted access ---------- */
  .access-head { text-align:center; margin:36px auto 18px; max-width:560px; }
  .access-head h2 { font-size:23px; margin:0 0 6px; letter-spacing:.02em; }
  .access-head p { color:var(--muted); font-size:15px; margin:0; }
  .access-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; max-width:760px; margin:0 auto 26px; }
  .access-card {
    position:relative; overflow:hidden; display:flex; flex-direction:column;
    background:linear-gradient(180deg, var(--panel), var(--panel2));
    border:1px solid var(--border); border-radius:16px; padding:22px 22px 24px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 10px 26px rgba(0,0,0,.3);
  }
  .access-card::before { content:""; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg, transparent, var(--amber) 30%, var(--amber2) 70%, transparent); }
  .access-card h3 { font-size:20px; margin:0 0 10px; }
  .access-card p { color:var(--muted); font-size:14px; line-height:1.6; margin:0 0 14px; }
  .access-card ul { padding-left:18px; margin:0 0 22px; font-size:13.5px; line-height:1.7; flex:1; }
  .access-card button { margin-top:auto; }
  #accessRequestModal .modal-card { max-height:calc(100dvh - 40px); overflow:auto; }
  @media(max-width:600px) { .access-grid { grid-template-columns:1fr; } }
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
  #teamSection { margin-top:18px; padding-top:16px; border-top:1px solid var(--border); }
  #teamSection.hidden { display:none; }
  .roster { display:flex; flex-direction:column; gap:8px; margin-top:14px; }
  .rosterrow { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--panel2); }
  .rosterrow .rname { font-weight:500; }
  .rosterrow .remail { font-size:12px; }
  .rosterrow .rspacer { flex:1; }
  .rosterrow button { padding:6px 10px; font-size:13px; }
  .badge { font-size:10px; letter-spacing:.1em; text-transform:uppercase; padding:3px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted); }
  .badge.mgr { color:var(--amber); border-color:rgba(242,169,80,.4); }
  .invitelink { display:flex; gap:8px; margin-top:10px; }
  .invitelink.hidden { display:none; }
  .invitelink input { flex:1; font-family:var(--mono); font-size:12px; }
  #inviteRole { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:#0b0d13; color:var(--fg); font:inherit; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
${WORKSPACE_STYLE}
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
      <button id="navRequestAccess">Request access</button>
    </div>
    <button id="signout" class="ghost hidden">Sign out</button>
  </div>
  <div class="ruler" aria-hidden="true"></div>

  <!-- Landing (logged out) -->
  <div id="landingView" class="hidden">
    <div class="hero">
      <div class="logo" aria-hidden="true"></div>
      <div class="eyebrow">Windows &amp; macOS · automatic · open source desktop</div>
      <h1>Stop babysitting<br /><small>a timer.</small></h1>
      <p>clocked is a tray / menu-bar app that clocks you in and out from real machine
        activity — unlock, work, lock, idle. Hours stay on your PC (SQLite) first.
        Optional cloud sync emails a monthly timesheet even if the laptop was asleep.</p>
      <div class="downloadCta row">
        <button type="button" class="btn" id="heroRequestAccess">Request access</button>
        <a class="btn ghost" href="/download/mac">Download for macOS</a>
        <a class="btn ghost" href="/download/win">Download for Windows</a>
        <a class="btn ghost" href="/download/extension">Chrome extension</a>
        <div class="hintline">Optional extension sends site hostnames to the local app only — no screenshots, no keylogging, no full URLs.</div>
      </div>
      <p class="trust">MIT desktop app · local SQLite source of truth · hosted access by invitation · self-host the Worker anytime</p>
    </div>

    <div class="features">
      <div class="feature"><div class="k">Automatic presence</div><div class="v">Wake, unlock, and activity clock you in. Sleep, lock, idle, quit, and shutdown clock you out — idle is backdated to last input so empty time doesn&rsquo;t inflate the day.</div></div>
      <div class="feature"><div class="k">Local first</div><div class="v">Sessions live in SQLite on your machine. Pause from the tray, tune idle timeout, set working hours with an after-hours prompt, and keep tracking offline.</div></div>
      <div class="feature"><div class="k">Optional projects</div><div class="v">Opt in to attribute time to the focused app and privacy-safe context (document name or browser hostname). Window titles stay off by default.</div></div>
      <div class="feature"><div class="k">Monthly timesheet</div><div class="v">Hosted cloud emails a day-by-day CSV on your schedule. Preview anytime, add manual spans, and export or delete your cloud data.</div></div>
      <div class="feature"><div class="k">Teams</div><div class="v">Invite workers, review their hours, adjust entries as a manager, and centralize report delivery — not live surveillance.</div></div>
      <div class="feature"><div class="k">Yours to run</div><div class="v">Point the desktop app at your own Cloudflare Worker, or use hosted clocked for accounts, dashboard, and email without ops work.</div></div>
    </div>

    <div class="how">
      <h2>How it works</h2>
      <p>Three steps. Under a minute after install.</p>
      <div class="how-steps">
        <div class="how-step">
          <div class="n">01</div>
          <h3>Install the tray app</h3>
          <p>Download for Windows or macOS. It runs in the background, can start at login, and keeps a local SQLite timesheet with no account required.</p>
        </div>
        <div class="how-step">
          <div class="n">02</div>
          <h3>Connect cloud (optional)</h3>
          <p>Request hosted access, accept your invitation, then connect the app with your sync token. You can also point the app at your self-hosted Worker.</p>
        </div>
        <div class="how-step">
          <div class="n">03</div>
          <h3>Forget about it</h3>
          <p>Hours accumulate automatically. Open the dashboard for a day timeline, projects, and email settings — or wait for the monthly CSV.</p>
        </div>
      </div>
    </div>

    <div class="compare">
      <h2>Hosted vs self-hosted</h2>
      <p>The open-source desktop and a minimal Worker stay useful on their own. Hosted clocked adds accounts, teams, and managed delivery for free.</p>
      <div class="compare-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Self-hosted Worker</th>
              <th scope="col" class="hosted-col">Hosted clocked</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Desktop tray app</th>
              <td class="yes">Yes — MIT, local SQLite</td>
              <td class="hosted-col yes">Yes — same app</td>
            </tr>
            <tr>
              <th scope="row">Session sync</th>
              <td>You deploy Worker + D1 + secrets</td>
              <td class="hosted-col yes">Managed — paste token &amp; go</td>
            </tr>
            <tr>
              <th scope="row">Web dashboard</th>
              <td class="no">Basic / DIY (your fork)</td>
              <td class="hosted-col yes">Hours, day timeline, projects, export</td>
            </tr>
            <tr>
              <th scope="row">Accounts &amp; isolation</th>
              <td class="no">Typically one shared token</td>
              <td class="hosted-col yes">Per-user auth, tokens, email verify</td>
            </tr>
            <tr>
              <th scope="row">Monthly email report</th>
              <td>You wire Resend / Email Routing</td>
              <td class="hosted-col yes">Scheduled day, time &amp; timezone; multi-recipient</td>
            </tr>
            <tr>
              <th scope="row">Manual time edits</th>
              <td class="no">Your own tooling</td>
              <td class="hosted-col yes">Add / remove sessions in dashboard</td>
            </tr>
            <tr>
              <th scope="row">Teams &amp; manager views</th>
              <td class="no">Not in the minimal path</td>
              <td class="hosted-col yes">Invite, roster, shared timesheets</td>
            </tr>
            <tr>
              <th scope="row">Operations</th>
              <td class="no">You operate everything</td>
              <td class="hosted-col yes">Hosted updates, support path</td>
            </tr>
            <tr>
              <th scope="row">Best for</th>
              <td>Developers &amp; privacy-first solo ops</td>
              <td class="hosted-col">Freelancers &amp; small teams who want it to just work</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="compare-note">Run it yourself, or request hosted access and connect the app after receiving an invitation.</p>
    </div>

    <div class="audience">
      <h2>Built for people who bill time</h2>
      <p>Not another productivity panopticon. A quiet clock for real work.</p>
      <div class="chips">
        <span class="chip">Freelancers</span>
        <span class="chip">Consultants</span>
        <span class="chip">Small agencies</span>
        <span class="chip">Contractors</span>
        <span class="chip">Solo founders</span>
      </div>
    </div>

    <section class="access-section" aria-labelledby="accessHeading">
      <div class="access-head">
        <h2 id="accessHeading">Hosted access, by invitation</h2>
        <p>Tell us how you want to use Clocked. We review requests and send invitations by email.</p>
      </div>
      <div class="access-grid">
        <div class="access-card">
          <h3>For yourself</h3>
          <p>Your time, your timesheets, your delivery schedule. No team needed.</p>
          <ul><li>Sync across your computers</li><li>Review and export your hours</li><li>Schedule your monthly timesheet email</li></ul>
          <button class="requestAccess" data-kind="individual" type="button">Request individual access</button>
        </div>
        <div class="access-card">
          <h3>For your team</h3>
          <p>A separate team for your business, with managers and workers in one place.</p>
          <ul><li>Invite workers and additional managers</li><li>Review hours and manage timesheet delivery</li><li>Up to 50 people, including managers</li></ul>
          <button class="requestAccess" data-kind="team" type="button">Request team access</button>
        </div>
      </div>
      <p class="compare-note">The open-source desktop app works locally without an account.</p>
    </section>

    <div class="faq">
      <h2>FAQ</h2>
      <details>
        <summary>How do I get hosted access?</summary>
        <p>Request access for yourself or your team. We review each request and email an invitation if approved. You can then create an account or sign in, verify your email, and accept the invitation. Sending a request does not create an account.</p>
      </details>
      <details>
        <summary>Is this employee surveillance software?</summary>
        <p>No. By default clocked tracks presence from OS power and input events on the machine you install it on — no screenshots, no keylogging. Optional project tracking can record focused apps and privacy-safe site hostnames (not full URLs). Team managers see hours for people who joined their org — not live monitoring.</p>
      </details>
      <details>
        <summary>What if my laptop is closed at month-end?</summary>
        <p>Sessions live on your PC and sync when you&rsquo;re online. The cloud report is emailed by the server on your schedule, so you still get the timesheet even if the laptop was asleep that day.</p>
      </details>
      <details>
        <summary>Can I self-host?</summary>
        <p>Yes. The desktop app is open source and can point at your own Worker URL. You run Cloudflare, D1, secrets, and email yourself. Hosted clocked is the managed path for accounts, dashboard, teams, and email without ops.</p>
      </details>
      <details>
        <summary>Do I need an account to track time?</summary>
        <p>No. Local-only mode works with an empty config — hours stay in SQLite on your machine. An account is only needed for cloud sync, the web dashboard, teams, and monthly email.</p>
      </details>
      <details>
        <summary>Which platforms?</summary>
        <p>Native tray and menu-bar apps for Windows and macOS. Optional Chrome/Edge extension for accurate browser hostnames. The web dashboard works in any modern browser once you have an account.</p>
      </details>
    </div>

    <p class="footer-note">
      Source on <a href="https://github.com/DaveDushi/clocked" target="_blank" rel="noopener">GitHub</a>
      · Installer via <a href="/download">/download</a>
      · <a href="/press">Press kit</a>
      · <a href="/news">News</a>
      · Questions? Open an issue on the repo.
    </p>

    <div id="authModal" class="modal hidden">
      <div class="modal-backdrop"></div>
      <div id="auth" class="card modal-card">
        <button id="authClose" class="ghost modal-close" aria-label="Close">&times;</button>
      <div class="tabs">
        <button id="tabSignup" class="active">Create account</button>
        <button id="tabSignin">Sign in</button>
      </div>

      <div id="nameField" class="field">
        <p class="hint">Clocked is invite-only. Use the email address your invitation was sent to. Already have an account? Sign in with that address to join.</p>
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
      <b>Account created.</b> Verify your email to accept your invitation and open Clocked.
    </div>
    <!-- Verify email first (blocking). -->
    <div id="verifyGate" class="card hidden">
      <h3>Verify your email</h3>
      <p class="hint">We sent a link to your inbox. Confirm it to open your dashboard.</p>
      <button id="resendVerifyGate" class="ghost">Resend verification email</button>
      <div id="verifyGateMsg" class="msg" role="status"></div>
    </div>

    <!-- Invitation failures and accounts that have not joined yet. -->
    <div id="approvalGate" class="card hidden">
      <h3>Join with your invitation</h3>
      <p class="hint">Open the invitation sent to your account's email address to get access. If it expired, ask the person who invited you for a new one.</p>
      <div id="invitationMsg" class="msg" role="status"></div>
      <button id="retryInvitation" class="ghost" type="button">Try again</button>
    </div>

    <!-- Product UI — only after email verification. Tabbed to keep the page short. -->
    <div id="appMain" class="hidden">

    <div id="operatorInvites" class="card hidden">
      <h3>Invite someone</h3>
      <p id="operatorInviteHint" class="hint">Individuals manage their own timesheets and email delivery without a team. They can join a team later.</p>
      <div class="row">
        <div><label for="operatorInviteKind">Invite as</label><select id="operatorInviteKind"><option value="individual">Individual</option><option value="manager">Team manager</option></select></div>
        <div id="operatorTeamField" class="hidden"><label for="operatorTeamName">Their team name</label><input id="operatorTeamName" maxlength="80" placeholder="Acme Inc." /></div>
        <div><label for="operatorInviteEmail">Email</label><input id="operatorInviteEmail" type="email" placeholder="person@example.com" /></div>
        <button id="sendOperatorInvite" type="button">Send invitation</button>
      </div>
      <div id="operatorInviteMsg" class="msg" role="status"></div>
      <div id="operatorLinkBox" class="invitelink hidden">
        <input id="operatorInviteLink" readonly aria-label="Invitation link" />
        <button id="copyOperatorInvite" class="ghost" type="button">Copy invite link</button>
      </div>
    </div>

${WORKSPACE_MARKUP}

    </div><!-- /appMain -->
  </div><!-- /app -->

  <!-- Public access request. It notifies the operator and does not grant access. -->
  <div id="accessRequestModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="requestAccessHeading">
    <div class="modal-backdrop"></div>
    <div class="card modal-card">
      <button id="accessRequestClose" class="ghost modal-close" aria-label="Close">&times;</button>
      <h3 id="requestAccessHeading">Request access</h3>
      <p class="hint">Clocked's hosted service is invite-only. Tell us a little about yourself. We'll review your request and reply by email.</p>
      <div class="field"><label for="requestKind">Access for</label><select id="requestKind"><option value="individual">Just me</option><option value="team">My team</option></select></div>
      <div class="field">
        <label for="requestName">Name</label>
        <input id="requestName" type="text" autocomplete="name" />
      </div>
      <div class="field">
        <label for="requestEmail">Email</label>
        <input id="requestEmail" type="email" autocomplete="email" />
      </div>
      <div id="requestTeamFields" class="row hidden">
        <div>
          <label for="requestCompany">Company (optional)</label>
          <input id="requestCompany" type="text" autocomplete="organization" />
        </div>
        <div>
          <label for="requestTeamSize">Team size (optional)</label>
          <input id="requestTeamSize" type="text" inputmode="numeric" placeholder="e.g. 45" />
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label for="requestMessage">Message <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></label>
        <textarea id="requestMessage" rows="3"></textarea>
      </div>
      <button id="submitAccessRequest" style="width:100%">Send request</button>
      <div id="accessRequestMsg" class="msg" role="status"></div>
      <button id="navSignup" class="ghost" type="button" style="width:100%;margin-top:12px">I already have an invitation</button>
    </div>
  </div>
</div>

<script>
const createTimesheetView = (${createTimesheetView.toString()});
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
  if (!loggedIn) {
    if ($("appMain")) $("appMain").classList.add("hidden");
    if ($("verifyGate")) $("verifyGate").classList.add("hidden");
  }
}

// ---- auth mode (sign up / sign in) ----
function invitationCallbackURL() { return location.pathname + location.search; }
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

// ---- auth modal (opened from the top-right nav + landing CTAs) ----
function openAuth(m) {
  setMode(m);
  $("authModal").classList.remove("hidden");
  const first = m === "signup" ? "name" : "email";
  setTimeout(() => $(first).focus(), 30);
}
function closeAuth() { $("authModal").classList.add("hidden"); }
$("navSignin").onclick = () => openAuth("signin");
$("navSignup").onclick = () => { closeAccessRequest(); openAuth("signup"); };
$("navRequestAccess").onclick = () => openAccessRequest();
$("heroRequestAccess").onclick = () => openAccessRequest();
document.querySelectorAll(".requestAccess").forEach((button) => {
  button.onclick = () => openAccessRequest(button.dataset.kind);
});
$("authClose").onclick = closeAuth;
$("authModal").querySelector(".modal-backdrop").onclick = closeAuth;

// ---- public access requests ----
function openAccessRequest(kind = "individual") {
  $("requestKind").value = kind;
  $("requestKind").onchange();
  $("accessRequestMsg").textContent = "";
  $("accessRequestModal").classList.remove("hidden");
  setTimeout(() => $("requestName").focus(), 30);
}
function closeAccessRequest() { $("accessRequestModal").classList.add("hidden"); }
$("requestKind").onchange = () => $("requestTeamFields").classList.toggle("hidden", $("requestKind").value !== "team");
$("accessRequestClose").onclick = closeAccessRequest;
$("accessRequestModal").querySelector(".modal-backdrop").onclick = closeAccessRequest;
$("submitAccessRequest").onclick = async () => {
  const name = $("requestName").value.trim();
  const email = $("requestEmail").value.trim();
  const kind = $("requestKind").value;
  const company = $("requestCompany").value.trim();
  const teamSize = $("requestTeamSize").value.trim();
  const message = $("requestMessage").value.trim();
  $("accessRequestMsg").textContent = ""; $("accessRequestMsg").className = "msg";
  if (!name || !email || !$("requestEmail").checkValidity()) { $("accessRequestMsg").textContent = "Enter your name and a valid email address."; $("accessRequestMsg").className = "msg err"; return; }
  $("submitAccessRequest").disabled = true; $("submitAccessRequest").textContent = "Sending…";
  try {
    const body = kind === "team" ? { name, email, kind, company, teamSize, message } : { name, email, kind, message };
    const r = await api("/api/request-access", { method:"POST", body: JSON.stringify(body) });
    const d = await r.json().catch(()=>({}));
    if (r.ok) {
      $("accessRequestMsg").textContent = "Request sent. We'll review it and email you about access.";
      $("accessRequestMsg").className = "msg ok";
      $("requestName").value = $("requestEmail").value = $("requestCompany").value = $("requestTeamSize").value = $("requestMessage").value = "";
    } else {
      $("accessRequestMsg").textContent = d.error || "Could not send your request. Please try again.";
      $("accessRequestMsg").className = "msg err";
    }
  } catch {
    $("accessRequestMsg").textContent = "Could not reach Clocked. Check your connection and try again.";
    $("accessRequestMsg").className = "msg err";
  } finally {
    $("submitAccessRequest").disabled = false;
    $("submitAccessRequest").textContent = "Send request";
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAuth();
    closeAccessRequest();
  }
});

async function submitAuth() {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authMsg").textContent = ""; $("authMsg").className = "msg";
  if (!email || !password) { $("authMsg").textContent = "Email and password required."; $("authMsg").className = "msg err"; return; }
  if (mode === "signup" && password.length < 12) { $("authMsg").textContent = "Password must be at least 12 characters."; $("authMsg").className = "msg err"; return; }

  $("authBtn").disabled = true;
  let r, body;
  if (mode === "signup") {
    body = { email, password, name: ($("name").value.trim() || email), callbackURL: invitationCallbackURL() };
    r = await api("/api/auth/sign-up/email", { method:"POST", body: JSON.stringify(body) });
  } else {
    r = await api("/api/auth/sign-in/email", { method:"POST", body: JSON.stringify({ email, password, callbackURL: invitationCallbackURL() }) });
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
  const r = await api("/api/auth/sign-in/social", { method:"POST", body: JSON.stringify({ provider:"google", callbackURL:invitationCallbackURL() }) });
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
  else {
    show(false);
    setMode("signin");
    const params = new URLSearchParams(location.search);
    if (params.has("invitation") || params.has("individualInvitation")) openAuth("signup");
  }
}

async function afterLogin(fresh) {
  $("freshBanner").classList.toggle("hidden", !fresh);

  // Verify email, then the product.
  let me = await fetchMe();
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
  if (!(await acceptPendingInvite())) {
    setAccessStage("approval");
    return;
  }
  me = await fetchMe();
  if (!me || !me.user) { show(false); return; }
  if (!me.user.approved) {
    setAccessStage("approval");
    return;
  }
  setAccessStage("app");
  $("operatorInvites").classList.toggle("hidden", !me.operator);
  await startWorkspace(me);
}

/** Which post-login shell is visible. */
function setAccessStage(stage) {
  $("verifyGate").classList.toggle("hidden", stage !== "verify");
  $("approvalGate").classList.toggle("hidden", stage !== "approval");
  $("appMain").classList.toggle("hidden", stage !== "app");
  document.body.classList.toggle("ws-mode", stage === "app");
}

async function fetchMe() {
  const r = await api("/api/me");
  if (!r.ok) return null;
  return r.json();
}

if ($("resendVerifyGate")) {
  $("resendVerifyGate").onclick = async () => {
    const email = meEmail || ($("email") && $("email").value) || "";
    if (!email) {
      $("verifyGateMsg").textContent = "Missing account email — sign out and sign in again.";
      $("verifyGateMsg").className = "msg err";
      return;
    }
    // better-auth requires email in the body (optional callbackURL).
    const r = await api("/api/auth/send-verification-email", {
      method: "POST",
      body: JSON.stringify({ email: email, callbackURL: invitationCallbackURL() }),
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
let orgCap = 0, orgPlanKey = "", memberCount = 0;
let emailMode = "solo"; // "solo" | "manager" | "member" — who controls timesheet delivery
let canEditTimes = true; // false for team workers (non-managers)

function isManagerRoleC(role) {
  return String(role || "").split(",").some((r) => { const t = r.trim(); return t === "owner" || t === "admin"; });
}
function roleLabel(role) { return isManagerRoleC(role) ? "Manager" : "Worker"; }

// If arriving from an invite link (/?invitation=ID) while signed in, accept it.
async function acceptPendingInvite() {
  const params = new URLSearchParams(location.search);
  const individual = params.get("individualInvitation");
  const inv = individual || params.get("invitation");
  $("invitationMsg").textContent = "";
  if (!inv) return true;
  let r;
  try {
    r = await api(individual ? "/api/invitations/individual/accept" : "/api/auth/organization/accept-invitation", { method:"POST", body: JSON.stringify({ invitationId: inv }) });
  } catch {
    $("invitationMsg").textContent = "Could not reach clocked. Your invitation is still here. Check your connection and try again.";
    $("invitationMsg").className = "msg err";
    return false;
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    $("invitationMsg").textContent = d.message || "Could not accept this invitation. Check you are signed in with the invited email address, or ask for a new invitation.";
    $("invitationMsg").className = "msg err";
    return false;
  }
  const url = new URL(location.href);
  url.searchParams.delete(individual ? "individualInvitation" : "invitation");
  history.replaceState({}, "", url.pathname + url.search);
  return acceptPendingInvite();
}

$("retryInvitation").onclick = () => afterLogin(false);
$("operatorInviteKind").onchange = () => {
  const manager = $("operatorInviteKind").value === "manager";
  $("operatorTeamField").classList.toggle("hidden", !manager);
  $("operatorInviteHint").textContent = manager
    ? "Create a separate team for this person. They will own that team and invite their workers. They will not join your team."
    : "Individuals manage their own timesheets and email delivery without a team. They can join a team later.";
  $("operatorLinkBox").classList.add("hidden");
  $("operatorInviteMsg").textContent = "";
};
$("sendOperatorInvite").onclick = async () => {
  const email = $("operatorInviteEmail").value.trim();
  const teamName = $("operatorTeamName").value.trim();
  const kind = $("operatorInviteKind").value;
  $("operatorLinkBox").classList.add("hidden");
  $("operatorInviteMsg").textContent = "";
  if (!email || (kind === "manager" && !teamName)) { $("operatorInviteMsg").textContent = kind === "manager" ? "Enter the manager's email and their team name." : "Enter an email address."; return; }
  $("sendOperatorInvite").disabled = true;
  try {
    const body = kind === "manager" ? { kind, email, teamName } : { kind, email };
    const r = await api("/api/admin/invite", { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { $("operatorInviteMsg").textContent = d.error || "Could not create the invitation."; return; }
    $("operatorInviteLink").value = d.url;
    $("operatorLinkBox").classList.remove("hidden");
    $("operatorInviteMsg").textContent = d.emailSent ? "Invitation emailed. You can also copy the link below. It expires in 7 days." : "Invitation created, but the email could not be sent. Copy and share the link below. It expires in 7 days.";
  } catch {
    $("operatorInviteMsg").textContent = "Could not reach clocked. Check your connection before trying again.";
  } finally { $("sendOperatorInvite").disabled = false; }
};
$("copyOperatorInvite").onclick = async () => {
  await navigator.clipboard.writeText($("operatorInviteLink").value);
  $("operatorInviteMsg").textContent = "Invite link copied.";
};

let inactivityLoadVersion = 0;
function inactivityPath() { return "/api/team/inactivity?organizationId=" + encodeURIComponent(orgId); }
function syncInactivityFields() {
  $("inactivityFields").disabled = $("inactivityMode").disabled || $("inactivityMode").value !== "team";
  $("inactivityFields").classList.toggle("hidden", $("inactivityMode").value !== "team");
}
async function loadInactivityEditor() {
  const version = ++inactivityLoadVersion;
  $("inactivityMode").disabled = true; $("saveInactivity").disabled = true;
  syncInactivityFields();
  $("inactivityMsg").textContent = "Loading inactivity policy...";
  $("inactivityMsg").className = "msg";
  try {
    const response = await api(inactivityPath());
    const data = await response.json();
    if (version !== inactivityLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not load inactivity policy.");
    $("inactivityMode").value = data.policy ? "team" : "personal";
    $("inactivityLimit").value = data.policy ? data.policy.timeout_secs / 60 : 15;
    $("inactivityWarning").value = data.policy ? data.policy.warning_secs / 60 : 2;
    $("inactivityMode").disabled = false; $("saveInactivity").disabled = false;
    $("inactivityMsg").textContent = "";
  } catch (error) {
    if (version !== inactivityLoadVersion) return;
    $("inactivityMsg").textContent = error.message || "Could not load inactivity policy.";
    $("inactivityMsg").className = "msg err";
  }
  syncInactivityFields();
}
$("inactivityMode").onchange = syncInactivityFields;
$("saveInactivity").onclick = async () => {
  const team = $("inactivityMode").value === "team";
  if (team && (!$("inactivityLimit").reportValidity() || !$("inactivityWarning").reportValidity())) return;
  const policy = team ? { timeout_secs: Number($("inactivityLimit").value) * 60, warning_secs: Number($("inactivityWarning").value) * 60 } : null;
  if (policy && policy.warning_secs >= policy.timeout_secs) {
    $("inactivityMsg").textContent = "The warning must be shorter than the inactivity limit.";
    $("inactivityMsg").className = "msg err"; return;
  }
  const path = inactivityPath();
  const version = inactivityLoadVersion;
  $("saveInactivity").disabled = true; $("inactivityMode").disabled = true; syncInactivityFields();
  $("inactivityMsg").textContent = "Saving...";
  try {
    const response = await api(path, { method: "POST", body: JSON.stringify({ policy }) });
    const data = await response.json();
    if (version !== inactivityLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not save inactivity policy.");
    $("inactivityMsg").textContent = "Saved. Updated desktop apps apply this on their next sync.";
    $("inactivityMsg").className = "msg ok";
  } catch (error) {
    if (version !== inactivityLoadVersion) return;
    $("inactivityMsg").textContent = error.message || "Could not save inactivity policy.";
    $("inactivityMsg").className = "msg err";
  } finally {
    if (version === inactivityLoadVersion) {
      $("saveInactivity").disabled = false; $("inactivityMode").disabled = false; syncInactivityFields();
    }
  }
};

// Working hours have their own controls so report delivery changes cannot overwrite them.
let hoursLoadVersion = 0;
const HOURS_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
HOURS_DAYS.forEach((day, i) => {
  const label = document.createElement("label"); label.className = "check";
  const input = document.createElement("input"); input.type = "checkbox"; input.value = String(i + 1);
  input.checked = i < 5;
  label.append(input, document.createTextNode(day)); $("hoursDays").appendChild(label);
});
function workingHoursPath() {
  return "/api/team/working-hours?organizationId=" + encodeURIComponent(orgId) +
    ($("hoursTarget").value ? "&userId=" + encodeURIComponent($("hoursTarget").value) : "");
}
function syncWorkingHoursFields() {
  $("hoursFields").disabled = $("hoursMode").disabled || $("hoursMode").value !== "scheduled";
  $("hoursFields").classList.toggle("hidden", $("hoursMode").value !== "scheduled");
}
async function loadWorkingHoursEditor() {
  const version = ++hoursLoadVersion;
  $("hoursMode").disabled = true; $("saveWorkingHours").disabled = true;
  syncWorkingHoursFields();
  $("workingHoursMsg").textContent = "Loading working hours...";
  $("workingHoursMsg").className = "msg";
  $("hoursMode").options[0].textContent = $("hoursTarget").value ? "Use team default" : "Use personal settings";
  try {
    const response = await api(workingHoursPath());
    const data = await response.json();
    if (version !== hoursLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not load working hours.");
    const schedule = data.schedule;
    $("hoursMode").value = schedule ? schedule.mode : "inherit";
    $("hoursStart").value = schedule && schedule.mode === "scheduled" ? schedule.start : "09:00";
    $("hoursEnd").value = schedule && schedule.mode === "scheduled" ? schedule.end : "17:00";
    const days = schedule && schedule.mode === "scheduled" ? schedule.days : [1, 2, 3, 4, 5];
    $("hoursDays").querySelectorAll("input").forEach((input) => { input.checked = days.includes(Number(input.value)); });
    $("hoursMode").disabled = false; $("saveWorkingHours").disabled = false;
    $("workingHoursMsg").textContent = "";
  } catch (error) {
    if (version !== hoursLoadVersion) return;
    $("workingHoursMsg").textContent = error.message || "Could not load working hours.";
    $("workingHoursMsg").className = "msg err";
  }
  syncWorkingHoursFields();
}
$("hoursTarget").onchange = loadWorkingHoursEditor;
$("hoursMode").onchange = syncWorkingHoursFields;
$("saveWorkingHours").onclick = async () => {
  const mode = $("hoursMode").value;
  const schedule = mode === "inherit" ? null : mode === "disabled" ? { mode: "disabled" } : {
    mode: "scheduled", start: $("hoursStart").value, end: $("hoursEnd").value,
    days: Array.from($("hoursDays").querySelectorAll("input:checked"), (input) => Number(input.value))
  };
  const path = workingHoursPath();
  $("saveWorkingHours").disabled = true; $("hoursTarget").disabled = true;
  $("hoursMode").disabled = true; syncWorkingHoursFields();
  $("workingHoursMsg").textContent = "Saving..."; $("workingHoursMsg").className = "msg";
  try {
    const response = await api(path, { method: "POST", body: JSON.stringify({ schedule }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save working hours.");
    $("workingHoursMsg").textContent = "Saved. Updated desktop apps apply this on their next sync, including startup, wake, or Sync now.";
    $("workingHoursMsg").className = "msg ok";
    await loadWorkingHoursSummary();
  } catch (error) {
    $("workingHoursMsg").textContent = error.message || "Could not save working hours.";
    $("workingHoursMsg").className = "msg err";
  } finally {
    $("saveWorkingHours").disabled = false; $("hoursTarget").disabled = false;
    $("hoursMode").disabled = false; syncWorkingHoursFields();
  }
};
async function loadWorkingHoursSummary() {
  const summary = $("workingHoursSummary");
  try {
    const response = await api("/api/working-hours");
    if (!response.ok) throw new Error("Could not load your working hours.");
    const data = await response.json();
    if (!data.schedule) {
      summary.textContent = "Working hours use your personal desktop settings. A team manager can assign a schedule.";
    } else {
      const schedule = data.schedule;
      const hours = schedule.mode === "disabled" ? "After-hours prompt turned off" :
        schedule.days.map((day) => HOURS_DAYS[day - 1]).join(", ") + ", " + schedule.start + " to " + schedule.end;
      summary.textContent = "Managed by " + data.organizationName + (data.source === "member" ? " with an individual override. " : ". ") +
        hours + ". Uses your computer's local time. Updated desktop apps apply changes on their next sync. Your personal settings are kept for when this assignment ends.";
    }
  } catch (error) { summary.textContent = "Could not load your working hours. Your desktop keeps its last synced schedule."; }
}

// ---- per-device tokens (full secret is returned only when minted) ----
let fullToken = "";
function setTokenView(d) {
  fullToken = d.token || "";
  $("copyToken").disabled = !fullToken;
  if (fullToken) {
    $("token").textContent = fullToken;
    $("token").classList.add("reveal");
    $("tokenMsg").textContent = "Copy this token now - it will not be shown again.";
    $("tokenMsg").className = "msg ok";
  } else {
    $("token").textContent = "Add a device to mint a token";
    $("token").classList.remove("reveal");
  }
}
function renderTokenList(tokens) {
  const list = $("tokenList");
  list.replaceChildren();
  if (!tokens || !tokens.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "12px 0";
    empty.style.fontSize = "13px";
    empty.textContent = "No connected devices.";
    list.appendChild(empty);
    return;
  }
  for (const item of tokens) {
    const row = document.createElement("div");
    row.className = "token-row";
    const main = document.createElement("div");
    main.className = "token-row-main";
    const name = document.createElement("div");
    name.className = "token-row-name";
    name.textContent = item.name || "Device";
    const meta = document.createElement("div");
    meta.className = "token-row-meta";
    meta.textContent = (item.prefix || "hidden") + " · added " + new Date(item.createdAt).toLocaleDateString();
    const revoke = document.createElement("button");
    revoke.className = "ghost del revoke-token";
    revoke.type = "button";
    revoke.dataset.tokenId = item.id;
    revoke.textContent = "Revoke";
    main.append(name, meta);
    row.append(main, revoke);
    list.appendChild(row);
  }
}
async function loadTokenList() {
  const r = await api("/api/tokens");
  if (r.ok) {
    const d = await r.json();
    renderTokenList(d.tokens || []);
  }
}
async function loadToken() {
  const r = await api("/api/token");
  if (r.status === 403) {
    $("verifyBanner").classList.remove("hidden");
    return;
  }
  $("verifyBanner").classList.add("hidden");
  if (r.ok) {
    const d = await r.json();
    setTokenView(d);
    await loadTokenList();
  }
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
    body: JSON.stringify({ email, callbackURL: invitationCallbackURL() }),
  });
  const d = await r.json().catch(() => ({}));
  $("tokenMsg").textContent = r.ok
    ? "Verification email sent — check your inbox."
    : (d.message || d.error || "Could not send verification email.");
  $("tokenMsg").className = r.ok ? "msg ok" : "msg err";
};
$("copyToken").onclick = async () => {
  if (!fullToken) {
    $("tokenMsg").textContent = "Existing secrets are hidden. Add a device to mint a token you can copy.";
    $("tokenMsg").className = "msg";
    return;
  }
  try { await navigator.clipboard.writeText(fullToken); $("tokenMsg").textContent = "Copied to clipboard."; $("tokenMsg").className = "msg ok"; }
  catch { $("tokenMsg").textContent = "Select the token and copy manually."; $("tokenMsg").className = "msg err"; }
};
$("mintToken").onclick = async () => {
  const name = $("tokenName").value.trim();
  if (!name) {
    $("tokenMsg").textContent = "Enter a name for this laptop or device.";
    $("tokenMsg").className = "msg err";
    return;
  }
  $("mintToken").disabled = true;
  const r = await api("/api/tokens", { method:"POST", body:JSON.stringify({ name }) });
  $("mintToken").disabled = false;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    $("tokenMsg").textContent = d.error || "Could not add device.";
    $("tokenMsg").className = "msg err";
    return;
  }
  $("tokenName").value = "";
  setTokenView(d);
  $("tokenMsg").textContent = "Device added. Copy this token now and paste it into that device's Settings.";
  $("tokenMsg").className = "msg ok";
  await loadTokenList();
};
let revokeArmedId = "";
$("tokenList").onclick = async (event) => {
  const button = event.target.closest("button.revoke-token");
  if (!button) return;
  const id = button.dataset.tokenId || "";
  if (!id) return;
  if (revokeArmedId !== id) {
    revokeArmedId = id;
    button.textContent = "Confirm?";
    $("tokenMsg").textContent = "Only this device token will be revoked.";
    $("tokenMsg").className = "msg";
    setTimeout(() => {
      if (revokeArmedId === id) revokeArmedId = "";
      if (button.isConnected) button.textContent = "Revoke";
    }, 4000);
    return;
  }
  revokeArmedId = "";
  button.disabled = true;
  const r = await api("/api/tokens/" + encodeURIComponent(id), { method:"DELETE" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    button.disabled = false;
    button.textContent = "Revoke";
    $("tokenMsg").textContent = d.error || "Could not revoke device.";
    $("tokenMsg").className = "msg err";
    return;
  }
  $("tokenMsg").textContent = "Device token revoked. Other devices are still connected.";
  $("tokenMsg").className = "msg ok";
  await loadTokenList();
};

const exportBtn = $("exportData");
if (exportBtn) exportBtn.onclick = async () => {
  const msg = $("privacyMsg");
  if (msg) { msg.textContent = "Preparing export…"; msg.className = "msg"; }
  const r = await api("/api/export");
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    if (msg) { msg.textContent = d.error || "Export failed."; msg.className = "msg err"; }
    return;
  }
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "clocked-export.json";
  a.click();
  URL.revokeObjectURL(a.href);
  if (msg) { msg.textContent = "Download started."; msg.className = "msg ok"; }
};

let deleteArmed = false;
const deleteBtn = $("deleteData");
if (deleteBtn) deleteBtn.onclick = async () => {
  const msg = $("privacyMsg");
  if (!deleteArmed) {
    deleteArmed = true;
    deleteBtn.textContent = "Confirm delete?";
    if (msg) {
      msg.textContent = "This erases your cloud sessions, project totals, and sync token. Desktop SQLite is unaffected. Click again to confirm.";
      msg.className = "msg";
    }
    setTimeout(() => {
      deleteArmed = false;
      deleteBtn.textContent = "Delete cloud data";
    }, 5000);
    return;
  }
  deleteArmed = false;
  deleteBtn.textContent = "Delete cloud data";
  deleteBtn.disabled = true;
  const r = await api("/api/account/delete", {
    method: "POST",
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  deleteBtn.disabled = false;
  if (r.ok) {
    if (msg) {
      msg.textContent = "Cloud data deleted. Regenerate a token to sync again.";
      msg.className = "msg ok";
    }
    setTokenView({ token: null, prefix: null, exists: false, created: false });
    renderTokenList([]);
    fullToken = "";
  } else {
    const d = await r.json().catch(() => ({}));
    if (msg) { msg.textContent = d.error || "Delete failed."; msg.className = "msg err"; }
  }
};

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
function fillTimeZones() {
  const list = $("sendTimezones");
  if (list.children.length) return;
  let zones = ["UTC"];
  try {
    if (typeof Intl.supportedValuesOf === "function") zones = zones.concat(Intl.supportedValuesOf("timeZone"));
  } catch (e) {}
  if (zones.length === 1) zones = zones.concat([
    "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "Europe/London", "Europe/Paris", "Asia/Jerusalem", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"
  ]);
  zones.forEach((z) => list.appendChild(new Option(z, z)));
}
function syncSendDayState() {
  const on = $("autoSend").checked;
  $("sendDay").disabled = !on;
  $("sendTime").disabled = !on;
  $("sendTimezone").disabled = !on;
  $("sendDayWrap").classList.toggle("off", !on);
}
$("autoSend").onchange = syncSendDayState;

async function loadEmailSettings() {
  fillSendDays();
  fillTimeZones();
  if (emailMode === "manager") {
    const r = await api("/api/team/settings?organizationId=" + encodeURIComponent(orgId));
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC", defaultRecipients: [] };
    // Prefill with the managers' emails until an explicit destination is saved.
    renderRecipients((d.recipients && d.recipients.length) ? d.recipients : (d.defaultRecipients || []));
    setSchedule(d.sendDay, d.sendTime, d.sendTimezone);
  } else if (emailMode === "member") {
    const r = await api("/api/settings");
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC" };
    renderEmailReadonly(d.recipients || [], d.sendDay, d.sendTime, d.sendTimezone);
  } else {
    const r = await api("/api/settings");
    const d = r.ok ? await r.json() : { recipients: [], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC" };
    renderRecipients(d.recipients);
    setSchedule(d.sendDay, d.sendTime, d.sendTimezone);
  }
}

function setSchedule(day, time, timezone) {
  day = Number(day);
  $("autoSend").checked = day !== 0;
  $("sendDay").value = String(day === 0 ? 1 : day);
  $("sendTime").value = time || "06:00";
  $("sendTimezone").value = timezone || "UTC";
  syncSendDayState();
}

function renderEmailReadonly(recipients, sendDay, sendTime, sendTimezone) {
  const day = Number(sendDay);
  const when = day === 0
    ? "not emailed automatically"
    : (day === 99 ? "emailed on the last day of each month" : "emailed on the " + ordinal(day) + " of each month") +
      " at " + pvEsc(sendTime || "06:00") + " (" + pvEsc(sendTimezone || "UTC") + ")";
  const who = (recipients && recipients.length) ? recipients.map(pvEsc).join(", ") : "your manager";
  $("emailReadonly").innerHTML = "<p class='muted' style='font-size:13.5px;margin:0;line-height:1.6'>Your monthly timesheet is " + when + " to <b style='color:var(--fg)'>" + who + "</b> — set by your team manager.</p>";
}

$("signout").onclick = async () => {
  try {
    await api("/api/auth/sign-out", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
  } catch (e) { /* still clear UI */ }
  // Reset client state, then full reload so no cached session UI sticks around.
  show(false);
  setMode("signin");
  orgId = ""; orgName = ""; orgRole = ""; meEmail = "";
  orgPlanKey = ""; canEditTimes = true; emailMode = "solo";
  window.location.assign(invitationCallbackURL());
};
$("addRecipient").onclick = () => addRecipientRow("");

$("saveEmail").onclick = async () => {
  const recipients = recipientValues();
  $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  if (!recipients.length) { $("emailMsg").textContent = "Add at least one recipient."; $("emailMsg").className = "msg err"; return; }
  const sendDay = $("autoSend").checked ? Number($("sendDay").value) : 0;
  const sendTime = $("sendTime").value;
  const sendTimezone = $("sendTimezone").value.trim();
  if ($("autoSend").checked && (!sendTime || !sendTimezone)) {
    $("emailMsg").textContent = "Choose a time and timezone."; $("emailMsg").className = "msg err"; return;
  }
  const path = emailMode === "manager"
    ? "/api/team/settings?organizationId=" + encodeURIComponent(orgId)
    : "/api/settings";
  $("saveEmail").disabled = true;
  const r = await api(path, { method:"POST", body: JSON.stringify({ recipients, sendDay, sendTime, sendTimezone }) });
  $("saveEmail").disabled = false;
  if (r.ok) { $("emailMsg").textContent = "Saved."; $("emailMsg").className = "msg ok"; }
  else { const e = await r.json().catch(()=>({})); $("emailMsg").textContent = e.error || "Save failed."; $("emailMsg").className = "msg err"; }
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
${WORKSPACE_SCRIPT}

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
