import { createTimesheetView } from "./timesheet-view.js";
import { WORKSPACE_MARKUP } from "./workspace-markup.js";
import { WORKSPACE_SCRIPT } from "./workspace-script.js";
import { WORKSPACE_STYLE } from "./workspace-style.js";

// Self-contained landing page + dashboard (HTML + inline CSS/JS, no build step,
// no assets). Auth is better-auth (cookies, same-origin fetch); data comes from
// /api/hours, /api/settings, and /api/token. Served at GET /.
//
// New accounts require an invitation. Team invitations require explicit consent.
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
<link rel="canonical" href="https://clocked.easytomanage.com/" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://clocked.easytomanage.com/" />
<meta property="og:title" content="clocked — automatic Windows time tracking" />
<meta property="og:description" content="Automatic time tracking with an open-source desktop app. Request hosted access for yourself or your team, with cloud sync and monthly timesheet email." />
<meta property="og:image" content="https://clocked.easytomanage.com/og.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="675" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="clocked — automatic Windows time tracking" />
<meta name="twitter:description" content="Automatic time tracking for Windows. No timers. No spyware. Monthly timesheet by email." />
<meta name="twitter:image" content="https://clocked.easytomanage.com/og.jpg" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"clocked","applicationCategory":"BusinessApplication","operatingSystem":"Windows, macOS","description":"Automatic time tracking from power and session events. Local SQLite, optional project attribution, cloud sync, teams, and monthly timesheet email.","url":"https://clocked.easytomanage.com/","downloadUrl":"https://clocked.easytomanage.com/download","softwareVersion":"0.1.14","license":"https://opensource.org/licenses/MIT","codeRepository":"https://github.com/DaveDushi/clocked"}
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
  input, textarea, select {
    width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border);
    background:#0b0d13; color:var(--fg); font:inherit; transition:border-color .15s, box-shadow .15s;
  }
  textarea { resize:vertical; min-height:74px; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--amber); box-shadow:0 0 0 3px rgba(242,169,80,.16); }
  select {
    appearance:none; min-height:44px; padding-right:40px; cursor:pointer;
  }
  select:disabled { opacity:.5; cursor:default; }
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
  .sendday select { padding-right:36px; }
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

  .total { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .total b { font-family:var(--mono); font-size:26px; font-weight:600; color:var(--amber); text-shadow:0 0 12px rgba(242,169,80,.2); font-variant-numeric:tabular-nums; }

  /* ---------- landing / auth ---------- */
  body:has(.top.bare) { background:var(--bg); }
  body:has(.top.bare)::before { display:none; }
  .top.bare .logo { box-shadow:none; }
  .top.bare + .ruler { height:1px; background:var(--border); margin:20px 0 0; mask-image:none; -webkit-mask-image:none; }
  .top.bare #navRequestAccess { background:transparent; color:var(--fg); border:1px solid var(--border); box-shadow:none; font-weight:500; }
  #landingView { max-width:680px; margin:0 auto; }
  #landingView button, #landingView a.btn { box-shadow:none; }
  #landingView button:hover, #landingView a.btn:hover { transform:none; }
  .hero { padding:64px 0 44px; }
  .hero .eyebrow { color:var(--muted); font-size:13px; margin:0 0 16px; }
  .hero h1 { font-size:clamp(32px,5vw,46px); line-height:1.15; letter-spacing:-.035em; margin:0 0 18px; max-width:560px; font-weight:500; }
  .hero p { color:#a7adbb; font-size:16px; max-width:540px; margin:0; line-height:1.65; }
  .hero .downloadCta { justify-content:flex-start; margin-top:24px; }
  #heroRequestAccess { background:var(--amber); }
  .hero .trust { margin-top:16px; font-size:13px; color:var(--muted); }
  .access-section { border-top:1px solid var(--border); padding:30px 0; }
  .access-head h2, .faq h2 { font-size:20px; font-weight:500; margin:0 0 8px; }
  .access-head > p { color:var(--muted); margin:0; max-width:560px; font-size:14px; line-height:1.6; }
  .access-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:32px; margin-top:24px; }
  .access-option h3 { font-size:15px; font-weight:500; margin:0 0 6px; }
  .access-option p { color:var(--muted); margin:0 0 12px; font-size:14px; line-height:1.6; }
  #landingView .access-option button { background:transparent; color:var(--fg); padding:4px 0; border-radius:3px; font-size:14px; font-weight:500; text-decoration:underline; text-underline-offset:5px; white-space:normal; text-align:left; }
  .faq { border-top:1px solid var(--border); padding-top:28px; }
  .faq details { border-bottom:1px solid var(--border); }
  .faq summary { cursor:pointer; padding:16px 0; font-size:14px; color:var(--fg); }
  .faq details p { margin:0 0 16px; color:var(--muted); font-size:14px; line-height:1.6; }
  .faq a { color:var(--fg); }
  .footer-note { display:flex; flex-wrap:wrap; gap:12px 22px; margin:28px 0 0; font-size:13px; }
  .footer-note a { color:var(--muted); text-underline-offset:4px; }
  @media(max-width:560px) {
    .hero { padding:40px 0 30px; }
    .hero .downloadCta { align-items:stretch; gap:10px; }
    .hero .downloadCta > * { width:100%; white-space:normal; }
    .access-grid { grid-template-columns:1fr; gap:24px; }
    #topAuth { gap:4px; }
    .top.bare #topAuth button { padding:8px; font-size:12px; }
    .top.bare { gap:8px; }
    .top.bare .wordmark { font-size:18px; }
    .top.bare .logo { width:28px; height:28px; }
  }

  @media(max-width:380px) {
    .top.bare { flex-wrap:wrap; }
    .top.bare #topAuth { width:100%; justify-content:flex-end; }
    #requestTeamFields:not(.hidden) { flex-direction:column; align-items:stretch; }
    #requestTeamFields > div { min-width:0; }
  }

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
  #accessRequestModal .modal-card { max-height:calc(100dvh - 40px); overflow:auto; }
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

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
${WORKSPACE_STYLE}
  /* Keep the chevron after workspace background/padding shorthands. */
  :is(select, .ws select, .sendday select, .ws-section-head select) {
    color-scheme:dark; padding-right:40px;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%238b91a0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right 13px center;
  }
  select option, select optgroup { background-color:#151823; color:var(--fg); }
  .ws select.ws-month { padding-right:40px !important; }

  /* Native semantics and events, with an OS picker fallback in older browsers. */
  @supports (appearance:base-select) and selector(select::picker(select)) {
    :is(select, .ws select):not([multiple]):not([size]) {
      appearance:base-select; align-items:center;
    }
    select:not([multiple]):not([size])::picker-icon { display:none; }
    select:not([multiple]):not([size])::picker(select) {
      appearance:base-select; color-scheme:dark;
      background:#151823; color:var(--fg); font:inherit; line-height:1.5;
      border:1px solid #363d50; border-radius:10px; padding:5px;
      margin-block:6px; max-height:min(320px, 60vh); overflow:auto;
      box-shadow:0 12px 36px rgba(0,0,0,.45);
      scrollbar-color:#41485b #151823;
    }
    select:not([multiple]):not([size]) option {
      display:flex; align-items:center; gap:12px; min-height:38px;
      padding:9px 12px; border:0; border-radius:6px;
      background:transparent; color:var(--fg); font:inherit; cursor:pointer;
      white-space:normal; overflow-wrap:anywhere;
    }
    select:not([multiple]):not([size]) option:checked {
      background:rgba(242,169,80,.12); color:var(--amber);
    }
    select:not([multiple]):not([size]) option:not(:disabled):hover {
      background:#292e3d;
    }
    select:not([multiple]):not([size]) option:focus-visible {
      outline:2px solid var(--amber); outline-offset:-2px; background:#292e3d;
    }
    select:not([multiple]):not([size]) option::checkmark {
      order:1; margin-left:auto; color:var(--amber);
    }
    select:not([multiple]):not([size]) option:disabled { color:var(--muted); cursor:default; }
    :is(select, .ws select):open { border-color:var(--amber); }
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
      <button id="navRequestAccess">Request access</button>
    </div>
    <button id="signout" class="ghost hidden">Sign out</button>
  </div>
  <div class="ruler" aria-hidden="true"></div>

  <!-- Landing (logged out) -->
  <div id="landingView" class="hidden">
    <section class="hero" aria-labelledby="landingHeading">
      <div class="eyebrow">Automatic time tracking for Windows &amp; macOS</div>
      <h1 id="landingHeading">Your workday, without the timer.</h1>
      <p>Clocked tracks time as you work, then stops when you lock your computer or step away. Your hours stay on your machine, ready when you need them.</p>
      <div class="downloadCta row">
        <a class="btn ghost" href="/download/mac">Download for macOS</a>
        <a class="btn ghost" href="/download/win">Download for Windows</a>
        <button type="button" id="heroRequestAccess">Request access</button>
      </div>
      <p class="trust">Open-source desktop app. Works offline, no account needed.</p>
    </section>

    <section class="access-section" aria-labelledby="accessHeading">
      <div class="access-head">
        <h2 id="accessHeading">Add sync and shared timesheets</h2>
        <p>Hosted Clocked adds a web dashboard and scheduled timesheet emails. Access is by invitation. We review requests and reply by email.</p>
      </div>
      <div class="access-grid">
        <div class="access-option">
          <h3>For yourself</h3>
          <p>Sync your computers, review your hours, and get a monthly timesheet.</p>
          <button class="requestAccess" data-kind="individual" type="button">Request individual access &rarr;</button>
        </div>
        <div class="access-option">
          <h3>For your team</h3>
          <p>Invite up to 50 people, review hours together, and manage timesheet delivery.</p>
          <button class="requestAccess" data-kind="team" type="button">Request team access &rarr;</button>
        </div>
      </div>
    </section>

    <section class="faq" aria-labelledby="faqHeading">
      <h2 id="faqHeading">A few details</h2>
      <details>
        <summary>What does Clocked track?</summary>
        <p>By default, only work sessions based on activity, lock, and idle events. No screenshots or keylogging. Optional project tracking adds focused apps and site hostnames, never full URLs. Team managers can review hours, without live monitoring.</p>
      </details>
      <details>
        <summary>Do I need hosted access?</summary>
        <p>No. The desktop app keeps your hours locally in SQLite and works without an account. Hosted access adds sync, the dashboard, teams, and scheduled email reports. Approved requests receive an invitation to create an account.</p>
      </details>
      <details>
        <summary>Can I self-host?</summary>
        <p>Yes. Point the desktop app at your own Cloudflare Worker. The source and setup instructions are on <a href="https://github.com/DaveDushi/clocked" target="_blank" rel="noopener">GitHub</a>.</p>
      </details>
    </section>

    <footer class="footer-note">
      <a href="/privacy">Privacy policy</a>
      <a href="/terms">Terms of service</a>
      <a href="https://github.com/DaveDushi/clocked" target="_blank" rel="noopener">Source &amp; setup</a>
      <a href="/download/extension">Chrome / Edge extension</a>
      <a href="/press">Press kit</a>
      <a href="/news">News</a>
    </footer>

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
      <div id="teamInvitationDetails" class="hidden">
        <h3>Join <span id="teamInvitationName"></span>?</h3>
        <p>Your role will be <b id="teamInvitationRole"></b>.</p>
        <p class="hint">Team managers can view, edit, and email reports of sessions that start after you join. Earlier sessions stay private. The team's timesheet delivery and working-hours policies will apply while this is your active team.</p>
        <button id="acceptTeamInvitation" type="button">Accept invitation</button>
      </div>
      <div id="invitationMsg" class="msg" role="status"></div>
      <button id="retryInvitation" class="ghost" type="button">Try again</button>
      <button id="dismissTeamInvitation" class="ghost hidden" type="button">Not now</button>
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

async function acceptPendingInvite(acceptTeam = false) {
  const params = new URLSearchParams(location.search);
  const individual = params.get("individualInvitation");
  const inv = individual || params.get("invitation");
  $("invitationMsg").textContent = "";
  if (!acceptTeam) $("teamInvitationDetails").classList.add("hidden");
  $("dismissTeamInvitation").classList.toggle("hidden", !params.has("invitation"));
  $("retryInvitation").classList.remove("hidden");
  if (!inv) return true;
  let r;
  try {
    if (!individual && !acceptTeam) {
      const details = await api("/api/auth/organization/get-invitation?id=" + encodeURIComponent(inv));
      const invitation = await details.json().catch(() => ({}));
      if (!details.ok || invitation.status !== "pending" || typeof invitation.organizationName !== "string" || typeof invitation.role !== "string") {
        $("invitationMsg").textContent = invitation.message || "Could not load this invitation. Check you are signed in with the invited email address, or ask for a new invitation.";
        $("invitationMsg").className = "msg err";
        return false;
      }
      $("teamInvitationName").textContent = invitation.organizationName;
      $("teamInvitationRole").textContent = roleLabel(invitation.role);
      $("teamInvitationDetails").classList.remove("hidden");
      $("retryInvitation").classList.add("hidden");
      return false;
    }
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
$("acceptTeamInvitation").onclick = async () => {
  if ($("acceptTeamInvitation").disabled) return;
  $("acceptTeamInvitation").disabled = true;
  $("dismissTeamInvitation").disabled = true;
  try {
    if (await acceptPendingInvite(true)) await afterLogin(false);
  } finally {
    $("acceptTeamInvitation").disabled = false;
    $("dismissTeamInvitation").disabled = false;
  }
};
$("dismissTeamInvitation").onclick = async () => {
  if ($("dismissTeamInvitation").disabled) return;
  const url = new URL(location.href);
  url.searchParams.delete("invitation");
  history.replaceState({}, "", url.pathname + url.search);
  await afterLogin(false);
};
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
  if ($("saveInactivity").disabled || settingsScope !== "team" || !wsIsTeam() || !isManagerRoleC(orgRole)) return;
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
    $("hoursTarget").disabled = false;
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
  if ($("saveWorkingHours").disabled || !wsIsTeam() || !isManagerRoleC(orgRole)) return;
  if (!$("dlgMember").open && (!$("dlgSettings").open || settingsScope !== "team")) return;
  const version = hoursLoadVersion;
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
    if (version !== hoursLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not save working hours.");
    $("workingHoursMsg").textContent = "Saved. Updated desktop apps apply this on their next sync, including startup, wake, or Sync now.";
    $("workingHoursMsg").className = "msg ok";
    await loadWorkingHoursSummary();
  } catch (error) {
    if (version !== hoursLoadVersion) return;
    $("workingHoursMsg").textContent = error.message || "Could not save working hours.";
    $("workingHoursMsg").className = "msg err";
  } finally {
    if (version !== hoursLoadVersion) return;
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
  input.setAttribute("aria-label", "Timesheet recipient email");
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
const sendWeekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function fillSendDays(selected) {
  const weekly = $("sendFrequency").value === "weekly";
  const sel = $("sendDay");
  sel.replaceChildren();
  if (weekly) sendWeekdays.forEach((name, i) => sel.add(new Option(name, String(i + 1))));
  else {
    for (let d = 1; d <= 28; d++) sel.add(new Option(ordinal(d), String(d)));
    sel.add(new Option("last day", "99"));
  }
  sel.value = String(selected || 1);
  $("sendDayLabel").textContent = weekly ? "Day of week" : "Day of month";
  sel.setAttribute("aria-label", weekly ? "Day of week" : "Day of month");
  $("sendPeriodHint").textContent = weekly
    ? "Weekly emails cover the seven completed days before delivery."
    : "Monthly emails cover the previous calendar month.";
}
$("sendFrequency").onchange = () => fillSendDays(1);
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
  $("sendFrequency").disabled = !on;
  $("sendDay").disabled = !on;
  $("sendTime").disabled = !on;
  $("sendTimezone").disabled = !on;
  $("sendDayWrap").classList.toggle("off", !on);
}
$("autoSend").onchange = syncSendDayState;

let emailSettingsContext = null;
let emailLoadVersion = 0;
async function loadEmailSettings(context) {
  const version = ++emailLoadVersion;
  emailSettingsContext = null; $("saveEmail").disabled = true;
  fillSendDays(); fillTimeZones();
  try {
    const response = await api(context.path);
    const data = await response.json();
    if (version !== emailLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not load delivery settings.");
    const editable = context.kind === "team" || !data.managed;
    emailSettingsContext = editable ? context : null;
    $("emailEdit").classList.toggle("hidden", !editable);
    $("emailReadonly").classList.toggle("hidden", editable);
    if (editable) {
      $("teamReportFormatField").hidden = context.kind !== "team" || orgPlanKey === "single";
      $("teamReportFormat").value = data.reportFormat || "per-member";
      renderRecipients(data.recipients.length ? data.recipients : (data.defaultRecipients || []));
      setSchedule(data.sendDay, data.sendTime, data.sendTimezone, data.sendFrequency);
      $("saveEmail").disabled = false;
    } else renderEmailReadonly(data.recipients || [], data.sendDay, data.sendTime, data.sendTimezone, data.sendFrequency);
  } catch (error) {
    if (version !== emailLoadVersion) return;
    $("emailReadonly").textContent = error.message || "Could not load delivery settings.";
  }
}

function setSchedule(day, time, timezone, frequency) {
  $("sendFrequency").value = frequency || "monthly";
  fillSendDays(Number(day));
  day = Number(day);
  $("autoSend").checked = day !== 0;
  $("sendDay").value = String(day === 0 ? 1 : day);
  $("sendTime").value = time || "06:00";
  $("sendTimezone").value = timezone || "UTC";
  syncSendDayState();
}

function renderEmailReadonly(recipients, sendDay, sendTime, sendTimezone, frequency) {
  const day = Number(sendDay);
  const when = day === 0
    ? "not emailed automatically"
    : (frequency === "weekly" ? "emailed every " + sendWeekdays[day - 1] : day === 99 ? "emailed on the last day of each month" : "emailed on the " + ordinal(day) + " of each month") +
      " at " + pvEsc(sendTime || "06:00") + " (" + pvEsc(sendTimezone || "UTC") + ")";
  const who = (recipients && recipients.length) ? recipients.map(pvEsc).join(", ") : "your manager";
  $("emailReadonly").innerHTML = "<p class='muted' style='font-size:13.5px;margin:0;line-height:1.6'>Your timesheet is " + when + " to <b style='color:var(--fg)'>" + who + "</b> — set by your team manager.</p>";
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
  const context = emailSettingsContext, version = emailLoadVersion;
  if (!context || $("saveEmail").disabled) return;
  const recipients = recipientValues();
  $("emailMsg").textContent = ""; $("emailMsg").className = "msg";
  if (!recipients.length) { $("emailMsg").textContent = "Add at least one recipient."; $("emailMsg").className = "msg err"; return; }
  const sendDay = $("autoSend").checked ? Number($("sendDay").value) : 0;
  const sendFrequency = $("sendFrequency").value;
  const sendTime = $("sendTime").value;
  const sendTimezone = $("sendTimezone").value.trim();
  if ($("autoSend").checked && (!sendTime || !sendTimezone)) {
    $("emailMsg").textContent = "Choose a time and timezone."; $("emailMsg").className = "msg err"; return;
  }
  $("saveEmail").disabled = true;
  try {
    const response = await api(context.path, { method:"POST", body: JSON.stringify({ recipients, sendDay, sendTime, sendTimezone, sendFrequency,
      ...(context.kind === "team" && orgPlanKey !== "single" ? { reportFormat: $("teamReportFormat").value } : {}) }) });
    const data = await response.json();
    if (version !== emailLoadVersion) return;
    if (!response.ok) throw new Error(data.error || "Save failed.");
    $("emailMsg").textContent = "Saved."; $("emailMsg").className = "msg ok";
  } catch (error) {
    if (version !== emailLoadVersion) return;
    $("emailMsg").textContent = error.message || "Save failed."; $("emailMsg").className = "msg err";
  } finally { if (version === emailLoadVersion) $("saveEmail").disabled = false; }
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
