// Signed-in workspace styles. Scoped under .ws so the landing page keeps its own look.
export const WORKSPACE_STYLE = /* css */ `
  html:has(body.ws-mode), body.ws-mode, .ws, .ws * { scrollbar-width:thin; scrollbar-color:#41485b transparent; }
  html:has(body.ws-mode)::-webkit-scrollbar, body.ws-mode::-webkit-scrollbar, .ws::-webkit-scrollbar, .ws *::-webkit-scrollbar { width:8px; height:8px; }
  html:has(body.ws-mode)::-webkit-scrollbar-track, body.ws-mode::-webkit-scrollbar-track, .ws::-webkit-scrollbar-track, .ws *::-webkit-scrollbar-track { background:transparent; }
  html:has(body.ws-mode)::-webkit-scrollbar-thumb, body.ws-mode::-webkit-scrollbar-thumb, .ws::-webkit-scrollbar-thumb, .ws *::-webkit-scrollbar-thumb { background:#41485b; border:2px solid transparent; border-radius:8px; background-clip:padding-box; }
  html:has(body.ws-mode)::-webkit-scrollbar-thumb:hover, body.ws-mode::-webkit-scrollbar-thumb:hover, .ws::-webkit-scrollbar-thumb:hover, .ws *::-webkit-scrollbar-thumb:hover { background-color:#647086; }
  html:has(body.ws-mode)::-webkit-scrollbar-button, body.ws-mode::-webkit-scrollbar-button, .ws::-webkit-scrollbar-button, .ws *::-webkit-scrollbar-button { display:none; width:0; height:0; }
  html:has(body.ws-mode)::-webkit-scrollbar-corner, body.ws-mode::-webkit-scrollbar-corner, .ws::-webkit-scrollbar-corner, .ws *::-webkit-scrollbar-corner { background:transparent; }
  body.ws-mode #topbar, body.ws-mode .ruler { display:none; }
  body.ws-mode .wrap { max-width:1180px; padding-top:18px; }
  .ws { --wsmuted:#9299aa; position:relative; border:1px solid var(--border); border-radius:14px; overflow:clip;
    background:radial-gradient(900px 350px at 70% -25%, rgba(242,169,80,.03), transparent 70%), var(--bg); font-size:14px; }
  .ws::before { content:""; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg, transparent, var(--amber) 30%, var(--amber2) 70%, transparent); }
  .ws.hidden { display:none; }
  .ws h1, .ws h2, .ws h3, .ws p { margin:0; }
  .ws h1 { font-size:27px; font-weight:500; letter-spacing:-.8px; }
  .ws h2 { font-size:19px; font-weight:500; letter-spacing:-.4px; }
  .ws h3 { font-size:14px; font-weight:500; }
  .ws small { font-size:12px; color:var(--wsmuted); }
  .ws .mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .ws label { display:block; text-transform:none; letter-spacing:0; font-size:12px; color:var(--wsmuted); margin:0; }
  .ws button, .ws a.btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; border:1px solid var(--border); background:transparent;
    color:var(--fg); border-radius:8px; padding:9px 12px; font:inherit; font-weight:500; font-size:13px; box-shadow:none; transform:none; cursor:pointer; white-space:nowrap; }
  .ws button:hover, .ws a.btn:hover { background:rgba(255,255,255,.025); border-color:#485064; transform:none; box-shadow:none; }
  .ws button:disabled { cursor:default; opacity:.45; }
  .ws button.primary, .ws a.btn.primary { background:linear-gradient(180deg, var(--amber), var(--amber2)); color:#221503; border-color:transparent; font-weight:600; }
  .ws button.primary:hover { filter:brightness(1.08); background:linear-gradient(180deg, var(--amber), var(--amber2)); }
  .ws button.danger { color:var(--err); border-color:rgba(255,112,112,.35); }
  .ws .text-button { border:0; padding:4px 0; color:var(--wsmuted); font-size:12px; background:none; }
  .ws .text-button:hover { background:none; color:var(--amber); }
  .ws input, .ws select, .ws textarea { border:1px solid var(--border); border-radius:8px; background:#0d0f16; color:var(--fg); padding:9px 11px; font:inherit; font-size:13px; min-width:0; }
  .ws select { cursor:pointer; }
  .ws input:focus, .ws select:focus { outline:none; border-color:var(--amber); box-shadow:0 0 0 3px rgba(242,169,80,.16); }
  .ws :focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
  .ws .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
  .ws .icon { width:17px; height:17px; flex:none; }

  .ws-header { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:18px 32px; border-bottom:1px solid var(--border); }
  .ws-brand { display:flex; align-items:center; gap:10px; min-width:0; }
  .ws-brand .logo { width:27px; height:27px; border-width:1.5px; }
  .ws-brand .logo::before { height:6px; }
  .ws-brand .logo::after { height:9px; }
  .ws-brand .wordmark { font-size:20px; }
  .ws-name { color:var(--wsmuted); font-size:12px; padding-left:18px; margin-left:8px; border-left:1px solid var(--border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ws-actions { display:flex; align-items:center; gap:16px; }
  .ws-actions .text-button { gap:7px; }
  .ws-avatar { width:32px; height:32px; padding:0 !important; border-radius:50% !important; font:11px var(--mono) !important; color:var(--amber) !important; background:rgba(242,169,80,.04) !important; }
  .ws-nav { display:flex; gap:26px; padding:0 32px; border-bottom:1px solid var(--border); }
  .ws-nav button { border:0; border-radius:0; padding:15px 0; background:none; color:var(--wsmuted); font-size:13px; }
  .ws-nav button:hover { background:none; color:var(--fg); }
  .ws-nav button[aria-current=page] { color:var(--amber); box-shadow:inset 0 -2px var(--amber); }
  .ws-main { max-width:1100px; margin:auto; padding:34px 38px 30px; min-height:360px; }

  .ws-title { display:flex; align-items:center; justify-content:space-between; gap:15px; margin-bottom:26px; }
  .ws-title .count { font-size:13px; color:var(--wsmuted); margin-left:10px; font-weight:400; letter-spacing:0; }
  .ws-title p { margin-top:5px; font-size:12px; color:var(--wsmuted); }
  .ws-toolbar { display:flex; justify-content:space-between; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; }
  .ws-toolbar-left, .ws-team-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .ws-month { font:12px var(--mono) !important; padding:9px 10px !important; }
  .ws-search { width:200px; font-size:12px !important; background:none !important; }
  .ws-team-actions [aria-pressed=true] { color:var(--amber); border-color:rgba(242,169,80,.4); }

  .ws table { width:100%; border-collapse:collapse; text-align:left; }
  .ws th { position:static; background:none; padding:12px 0; color:var(--wsmuted); font-size:11px; font-weight:400; text-transform:none; letter-spacing:0; border-bottom:1px solid var(--border); }
  .ws td { border-bottom:1px solid rgba(36,41,56,.7); padding:0; font-size:13px; }
  .ws tbody tr:hover { background:none; }
  .ws th.num, .ws td.num { text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .ws td.num { font-size:13px; }
  .ws-roster { table-layout:fixed; border-top:1px solid var(--border); }
  .ws-roster th.days, .ws-roster td.days { width:70px; text-align:right; color:var(--wsmuted); font:11px var(--mono); }
  .ws-roster th.end { width:40px; }
  .ws-member { display:flex !important; justify-content:flex-start !important; width:100%; min-height:54px; padding:13px 0 !important; border:0 !important; border-radius:0 !important; background:none !important; font-size:13px !important; gap:11px !important; text-align:left; white-space:normal !important; }
  .ws-member:hover { color:var(--amber); }
  .ws-role { font-size:10px; color:var(--wsmuted); font-family:var(--mono); }
  .ws-row.open .ws-member { color:var(--amber); }
  .ws-expand { padding:10px 0 10px 12px !important; border:0 !important; background:none !important; color:#6f7789 !important; }
  .ws-expand[aria-expanded=true] .icon { transform:rotate(90deg); }
  .ws-total td { padding:15px 0; border-bottom:0; color:var(--wsmuted); font-size:12px; }
  .ws-total td.num { font-size:14px; color:var(--fg); }
  .ws-bottom { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:18px; font-size:11px; color:var(--wsmuted); flex-wrap:wrap; }
  .ws-bottom .text-button { font-size:11px; }
  .ws-empty { padding:34px 0; color:var(--wsmuted); font-size:13px; text-align:center; }
  .ws-state { padding:48px 0; color:var(--wsmuted); font-size:13px; text-align:center; }
  .ws-state .err { color:var(--err); display:block; margin-bottom:12px; }
  .ws-detail-cell { padding:0 0 18px !important; border-bottom:1px solid var(--border) !important; }
  .ws-detail { padding:0 22px 18px; background:linear-gradient(180deg, #151823, #10121a); border:1px solid var(--border); border-radius:10px; margin:4px 0 3px; }
  .ws-detail-head { position:sticky; top:0; z-index:2; background:#131620; border-bottom:1px solid var(--border); padding:13px 0; margin-bottom:12px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .ws-detail-head strong { font-weight:500; }
  .ws-detail-head small { font-size:11px; }
  .ws-daily-head, .ws .ws-daily { display:grid; grid-template-columns:1.1fr 1.1fr 70px 80px; gap:10px; align-items:center; }
  .ws-daily-head { font-size:10px; color:var(--wsmuted); padding:0 0 10px; border-bottom:1px solid var(--border); }
  .ws-daily-head span:nth-last-child(-n+2) { text-align:right; }
  .ws-daily { width:100%; text-align:left; border:0 !important; border-bottom:1px solid var(--border) !important; border-radius:0 !important; padding:10px 0 !important; background:none !important; font-size:12px !important; white-space:normal !important; justify-content:initial !important; }
  .ws-daily:hover { color:var(--amber); }
  .ws-daily .span, .ws-span { font:11px var(--mono); color:var(--wsmuted); }
  .ws-daily .brk { text-align:right; font:11px var(--mono); color:#bdc6df; }
  .ws-daily .hrs { text-align:right; font:12px var(--mono); }
  .ws-subtotal { display:flex; justify-content:space-between; gap:12px; padding:14px 0 0; font-size:11px; color:var(--wsmuted); }
  .ws-subtotal .mono { color:var(--fg); }
  .ws-detail-actions { display:flex; justify-content:space-between; align-items:center; gap:14px; padding-top:12px; flex-wrap:wrap; }
  .ws-detail-actions .text-button { font-size:11px; }
  .ws-detail-actions > div { display:flex; gap:16px; }
  .ws-personal td { padding:0; }
  .ws-personal td.num, .ws-personal td.ws-span { padding:13px 0; }
  .ws-day-link { border:0 !important; border-radius:0 !important; padding:13px 0 !important; background:none !important; font-size:12px !important; justify-content:flex-start !important; }
  .ws-day-link:hover { color:var(--amber); }
  .ws .break-value { color:#bdc6df; }
  .ws-note { font-size:11px; color:var(--wsmuted); margin-top:18px; line-height:1.7; max-width:760px; }
  .ws-locked { font-size:12px; color:var(--wsmuted); margin-top:14px; }
  .ws-projects { margin-top:26px; padding-top:18px; border-top:1px solid var(--border); }
  .ws-projects h2 { font-size:15px; letter-spacing:0; margin-bottom:12px; }
  .ws-project { display:grid; grid-template-columns:minmax(0,160px) 1fr 64px; gap:12px; align-items:center; font-size:12px; margin:7px 0; }
  .ws-project span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ws-project i { display:block; height:4px; border-radius:2px; background:rgba(242,169,80,.7); }

  .ws-stats-filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:26px; }
  .ws-metrics { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:22px; padding:0 0 26px; border-bottom:1px solid var(--border); }
  .ws-metric label { font-size:11px; min-height:18px; }
  .ws-metric strong { font:24px var(--mono); display:block; letter-spacing:-1px; margin-top:6px; font-weight:400; }
  .ws-metric small { font-size:10px; display:block; margin-top:7px; }
  .ws-metric:first-child strong { color:var(--amber); }
  .ws-section { padding:26px 0 0; }
  .ws-section-head { display:flex; justify-content:space-between; align-items:center; gap:15px; margin-bottom:18px; flex-wrap:wrap; }
  .ws-section-head h2 { font-size:15px; letter-spacing:0; }
  .ws-section-head select { font-size:11px; padding:7px 9px; }
  .ws-compare-scroll { overflow-x:auto; }
  .ws-compare { min-width:650px; white-space:nowrap; }
  .ws-compare th { white-space:normal; line-height:1.4; padding-left:12px; font-size:10px; }
  .ws-compare th:first-child { padding-left:0; min-width:120px; }
  .ws-compare td { padding:12px 0 12px 12px; font-size:12px; }
  .ws-compare td:first-child { padding-left:0; }
  .ws-compare td.num { font-size:11px; }
  .ws-compare button { padding:0; border:0; background:none; font-size:12px; }
  .ws-compare button:hover { color:var(--amber); background:none; }
  .ws-ref td { color:var(--wsmuted) !important; background:rgba(255,255,255,.012); }
  .ws-bar { position:relative; isolation:isolate; }
  .ws-bar i { position:absolute; height:3px; bottom:5px; right:0; background:rgba(120,134,162,.4); max-width:100%; border-radius:2px; z-index:-1; }
  .ws-heat-scroll { overflow-x:auto; padding-bottom:8px; }
  .ws-heat { display:grid; gap:4px; min-width:640px; }
  .ws-heat-row { display:grid; grid-template-columns:120px repeat(var(--days), minmax(15px,1fr)); gap:4px; align-items:center; }
  .ws-heat-name { position:sticky; left:0; z-index:1; background:var(--bg) !important; font-size:11px !important; color:var(--wsmuted) !important; border:0 !important; padding:5px 6px 5px 0 !important; justify-content:flex-start !important; overflow:hidden; text-overflow:ellipsis; }
  .ws-heat-name:hover { color:var(--amber) !important; }
  .ws-heat-corner { position:sticky; left:0; background:var(--bg); align-self:stretch; }
  .ws-heat-label { font:9px var(--mono); text-align:center; color:var(--wsmuted); }
  .ws-heat-cell { padding:0 !important; aspect-ratio:1; min-height:15px; border:1px solid rgba(255,255,255,.04) !important; border-radius:3px !important; background:rgba(242,169,80,var(--strength)) !important; }
  .ws-heat-cell:hover { outline:1px solid var(--amber); outline-offset:1px; }
  .ws-heat-cell.none, .ws-cal-cell.none { opacity:1 !important; background:repeating-linear-gradient(135deg, #151823 0 2px, #0a0b10 2px 5px) !important; border-color:var(--border) !important; cursor:default; }
  .ws-legend { display:flex; gap:6px; align-items:center; color:var(--wsmuted); font-size:10px; margin-top:16px; flex-wrap:wrap; }
  .ws-legend i { display:inline-block; width:13px; height:13px; border:1px solid rgba(255,255,255,.07); border-radius:2px; }
  .ws-legend .gap { margin-left:12px; }
  .ws-legend .none-key { background:repeating-linear-gradient(135deg, #151823 0 2px, #0a0b10 2px 5px); border-color:var(--border); }
  .ws-legend .future-key { border:1px dashed #4a5163; }
  .ws-cal { display:grid; grid-template-columns:34px repeat(var(--weeks), 40px); gap:6px; align-items:center; margin-top:8px; }
  .ws-cal-day { font-size:10px; color:var(--wsmuted); }
  .ws-cal-head { font:9px var(--mono); color:var(--wsmuted); text-align:center; }
  .ws-cal-cell { width:40px; height:40px; padding:0 !important; border-radius:5px !important; border:1px solid rgba(242,169,80,.27) !important; background:var(--shade) !important; color:var(--ink) !important; font:11px var(--mono) !important; }
  .ws-cal-cell:hover { outline:1px solid var(--amber); outline-offset:2px; }
  .ws-cal-cell.none { color:var(--wsmuted) !important; }
  .ws-cal-cell.future { background:none !important; border:1px dashed #3a4152 !important; color:#70798c !important; opacity:1 !important; cursor:default; }
  .ws-cal-cell.outside { visibility:hidden; }

  .ws dialog { padding:0; border:0; background:transparent; color:var(--fg); max-width:calc(100vw - 32px); max-height:calc(100dvh - 32px); overflow:visible; }
  .ws dialog::backdrop { background:rgba(0,0,0,.62); }
  .ws-dialog { background:#10121a; border:1px solid #363e52; border-radius:14px; box-shadow:0 24px 80px rgba(0,0,0,.55); width:470px; max-width:100%; max-height:calc(100dvh - 40px); overflow:auto; padding:0 24px 24px; }
  .ws-dialog.wide { width:660px; }
  .ws-dialog.sheet { width:620px; height:calc(100dvh - 40px); }
  .ws dialog.ws-sheet { margin:20px 20px 20px auto; max-height:none; }
  .ws-dialog-head { position:sticky; top:0; z-index:4; background:#10121a; display:flex; justify-content:space-between; align-items:center; gap:15px; padding:20px 0 12px; }
  .ws-dialog-head .text-button { font-size:18px; padding:4px 8px; }
  .ws-dialog > p, .ws-dialog .sub { font-size:12px; color:var(--wsmuted); margin:0 0 14px; }
  .ws-dialog form label, .ws-dialog .field-label { margin:14px 0 7px; }
  .ws-dialog form input:not([type=checkbox]), .ws-dialog form select { width:100%; }
  .ws-actions-row { display:flex; justify-content:flex-end; gap:10px; margin-top:22px; flex-wrap:wrap; }
  .ws-actions-row.split { justify-content:space-between; }
  .ws-feedback { font-size:12px; margin-top:14px; min-height:0; }
  .ws-feedback.ok { color:var(--ok); } .ws-feedback.err { color:var(--err); }
  .ws-day-summary, .ws-sheet-summary { display:flex; gap:24px; padding:4px 0 18px; border-bottom:1px solid var(--border); font-size:11px; color:var(--wsmuted); flex-wrap:wrap; }
  .ws-day-summary strong, .ws-sheet-summary strong { display:block; color:var(--fg); font:17px var(--mono); margin-top:5px; font-weight:400; }
  .ws-timeline { display:grid; grid-template-columns:110px minmax(0,1fr) 62px 40px; align-items:center; gap:12px; padding:14px 0; border-bottom:1px solid var(--border); font-size:12px; }
  .ws-timeline .time, .ws-timeline .dur { font:11px var(--mono); color:var(--wsmuted); }
  .ws-timeline .dur { text-align:right; color:var(--fg); }
  .ws-timeline .what { display:flex; align-items:center; gap:9px; }
  .ws-timeline .what::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--amber); flex:none; }
  .ws-timeline.gap { color:#bdc6df; }
  .ws-timeline.gap .what::before { background:#7b849d; }
  .ws-timeline .source { display:block; font-size:10px; color:var(--wsmuted); margin:3px 0 0 15px; }
  .ws-timeline.edited .source { color:var(--amber); }
  .ws-timeline .text-button { font-size:11px; }
  .ws-time-fields { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .ws-check { display:flex !important; align-items:center; gap:9px; margin:14px 0 0 !important; font-size:12px; color:var(--fg) !important; }
  .ws-check input { width:15px !important; height:15px; accent-color:var(--amber); margin:0; }
  .ws-notice { padding:11px 12px; border:1px solid rgba(242,169,80,.2); border-radius:8px; color:var(--amber) !important; background:rgba(242,169,80,.03); font-size:12px; margin:0 0 14px; }
  .ws-complete { font-size:12px; color:var(--ok) !important; margin:0 0 14px; }
  .ws-recipients { font-size:12px; padding:12px 0; border-top:1px solid var(--border); display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; }
  .ws-recipients span { color:var(--wsmuted); }
  .ws-recipients strong { font-weight:400; word-break:break-all; }
  .ws-select-head { display:flex; align-items:center; justify-content:space-between; font-size:11px; gap:12px; padding:14px 0 10px; border-top:1px solid var(--border); }
  .ws-send-list { max-height:300px; overflow:auto; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .ws-send-member { display:grid !important; grid-template-columns:18px minmax(0,1fr) auto; align-items:center; gap:12px; padding:11px 0; margin:0 !important; border-bottom:1px solid rgba(36,41,56,.5); cursor:pointer; }
  .ws-send-member:last-child { border-bottom:0; }
  .ws-send-member input { width:15px; height:15px; accent-color:var(--amber); margin:0; }
  .ws-send-member strong { font-size:12px; font-weight:400; display:block; color:var(--fg); }
  .ws-send-member small { display:block; font-size:10px; margin-top:3px; }
  .ws-send-member .fact { color:var(--amber); }
  .ws-send-member .mono { font-size:11px; color:var(--fg); }
  .ws-send-total { display:flex; justify-content:space-between; color:var(--wsmuted); font-size:11px; gap:15px; margin-top:14px; }
  .ws-send-total strong { color:var(--fg); font-weight:400; }
  .ws-send-footer { position:sticky; bottom:-24px; background:#10121a; padding:4px 0 0; }
  .ws-results { font-size:11px; margin-top:10px; color:var(--err); }
  .ws-settings [hidden] { display:none !important; }
  .ws-settings-tabs { display:flex; gap:10px; margin-bottom:20px; border-bottom:1px solid var(--border); }
  .ws-settings-tabs [role=tab] { background:none; border:0; border-radius:0; padding:12px 8px; color:var(--wsmuted); }
  .ws-settings-tabs [aria-selected=true] { color:var(--fg); box-shadow:inset 0 -2px var(--amber); }
  .ws-settings { --settings-button-gap:10px; }
  .ws-settings .ws-dialog-head { padding-bottom:20px; }
  .ws-settings details { border-top:1px solid var(--border); padding:0; }
  .ws-settings details > summary { cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 0; list-style:none; font-size:13px; line-height:1.5; }
  .ws-settings details > summary::-webkit-details-marker { display:none; }
  .ws-settings details > summary::after { content:"+"; color:var(--wsmuted); font-family:var(--mono); flex:none; }
  .ws-settings details[open] > summary::after { content:"−"; }
  .ws-settings summary small { display:block; margin-top:4px; font-size:11px; line-height:1.5; }
  .ws-settings details[open] > summary { padding-bottom:0; }
  .ws-settings .body { display:grid; gap:16px; padding:16px 0 24px; }
  .ws-settings .body > *, .ws-settings .row > div { min-width:0; }
  .ws-settings .body .hint, .ws-settings .token-help { font-size:12px; color:var(--wsmuted); margin:0; line-height:1.6; }
  .ws-settings .body .hint:empty, .ws-settings .msg:empty, .ws-settings .ws-feedback:empty { display:none; }
  .ws-settings #emailEdit, .ws-settings #workingHoursEditor { display:grid; gap:16px; min-width:0; }
  .ws-settings label, .ws-settings .field-label { display:block; margin:0 0 6px; line-height:1.5; }
  .ws-settings fieldset { border:0; padding:0; margin:0; min-width:0; display:grid; gap:10px; }
  .ws-settings .row { gap:16px; flex-wrap:wrap; align-items:flex-end; }
  .ws-settings .row > div { flex:1 1 200px; }
  .ws-settings input:not([type=checkbox]):not([type=radio]), .ws-settings select { width:100%; max-width:100%; }
  .ws-settings .check, .ws-settings fieldset label.check { display:flex; align-items:flex-start; gap:8px; margin:0; font-size:12px; line-height:1.6; }
  .ws-settings input[type=checkbox], .ws-settings input[type=radio] { flex:none; width:16px; height:16px; margin:2px 0 0; padding:0; accent-color:var(--amber); }
  .ws-settings .ws-settings-days { display:flex; flex-wrap:wrap; gap:10px 16px; }
  .ws-settings .recipients { gap:10px; margin:0; }
  .ws-settings .recipient, .ws-settings .mentry { gap:var(--settings-button-gap); min-width:0; }
  .ws-settings .recipient input { min-width:0; }
  .ws-settings .recipient .del, .ws-settings .mentry .del { flex:none; width:38px; padding:8px 0; }
  .ws-settings .schedule { gap:12px; margin:0; }
  .ws-settings .sendday { display:grid; grid-template-columns:minmax(100px,.8fr) minmax(120px,1fr) minmax(0,1.6fr); align-items:end; gap:12px; padding:0 0 0 24px; }
  .ws-settings .sendday > div { min-width:0; }
  .ws-settings .sendday input, .ws-settings .sendday select { width:100%; min-height:40px; }
  .ws-settings .ws-actions-row, .ws-settings .inline-actions, .ws-settings .setupbox,
  .ws-settings .tokenbox, .ws-settings .token-create, .ws-settings .token-row,
  .ws-settings .invitelink { gap:var(--settings-button-gap); margin:0; }
  .ws-settings .ws-actions-row.split { justify-content:flex-start; }
  .ws-settings .body > button, .ws-settings #workingHoursEditor > button { justify-self:start; }
  .ws-settings .setupbox { display:flex; flex-wrap:wrap; }
  .ws-settings .tokenbox .token { font-size:12px; }
  .ws-settings .token-create { flex-wrap:wrap; }
  .ws-settings .token-create input { flex:1 1 200px; }
  .ws-settings .token-list { margin:0; }
  .ws-settings .token-list:empty { display:none; }
  .ws-settings .card { background:none; border:0; box-shadow:none; padding:0; margin:0; }
  .ws-settings .msg, .ws-settings .ws-feedback { font-size:12px; margin:0; line-height:1.6; overflow-wrap:anywhere; }
  .ws-settings .hidden, .ws-settings #emailEdit.hidden, .ws-settings #workingHoursEditor.hidden,
  .ws-settings .ws-settings-explainer { display:none; }
  .ws-settings .ws-settings-label { display:flex; align-items:center; justify-content:space-between; gap:var(--settings-button-gap); margin-bottom:6px; min-height:24px; }
  .ws-settings .ws-settings-label label, .ws-settings .ws-settings-label .field-label { margin:0; }
  .ws-settings .ws-settings-help { position:relative; flex:none; display:inline-flex; }
  .ws-settings .ws-settings-help > button { width:24px; height:24px; padding:0; border-radius:50%; color:var(--wsmuted); font-size:12px; }
  .ws-settings .ws-settings-help [role=tooltip] { position:absolute; z-index:5; right:0; top:calc(100% + 6px); width:240px; max-width:calc(100vw - 72px); padding:10px 12px; border:1px solid #485064; border-radius:8px; background:#1b1f2b; color:var(--fg); box-shadow:0 8px 24px rgba(0,0,0,.35); font-size:12px; line-height:1.6; visibility:hidden; opacity:0; pointer-events:none; }
  .ws-settings .ws-settings-help:hover [role=tooltip], .ws-settings .ws-settings-help:focus-within [role=tooltip] { visibility:visible; opacity:1; }
  @media (max-width:540px) {
    .ws-settings .sendday { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
    .ws-settings .sendday .ws-settings-field:last-of-type { grid-column:1 / -1; }
    .ws-settings .setupbox > .btn { flex:1 1 180px; }
    .ws-settings .token-row { flex-wrap:wrap; }
    .ws-settings .token-row-main { flex-basis:100%; }
    .ws-settings .token-row-meta { overflow-wrap:anywhere; }
    .ws-settings button, .ws-settings a.btn { white-space:normal; }
  }
  .ws-plan { border-top:1px solid var(--border); padding:15px 0; font-size:13px; }
  .ws-plan small { display:block; margin-top:4px; font-size:11px; }
  .ws-invite-row { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:12px 0; border-top:1px solid var(--border); font-size:12px; }
  .ws-invite-row small { display:block; font-size:10px; }

  @media (max-width:700px) {
    body.ws-mode .wrap { padding:0; }
    .ws { border-radius:0; border-left:0; border-right:0; }
    .ws-header { padding:16px 20px; }
    .ws-nav { padding:0 20px; }
    .ws-main { padding:26px 20px 24px; }
    .ws-metrics { gap:16px; }
    .ws-metric strong { font-size:21px; }
    .ws-heat-row { grid-template-columns:104px repeat(var(--days), minmax(15px,1fr)); }
  }
  @media (max-width:440px) {
    .ws-header { padding:14px 16px; }
    .ws-name { display:none; }
    .ws-actions .settings-label { display:none; }
    .ws-nav { padding:0 16px; }
    .ws-main { padding:22px 16px 20px; }
    .ws h1 { font-size:24px; }
    .ws-toolbar-left { flex-basis:100%; }
    .ws-search { width:140px; flex:1; }
    .ws-team-actions { width:100%; justify-content:flex-end; gap:8px; }
    .ws-team-actions button { font-size:12px; padding:8px 10px; }
    .ws-roster th.days, .ws-roster td.days { width:40px; }
    .ws-roster th.end { width:28px; }
    .ws-detail { padding:0 14px 14px; }
    .ws-daily-head, .ws .ws-daily { grid-template-columns:1fr 60px 66px; gap:8px; }
    .ws-daily .span, .ws-daily-head .span, .ws-span { display:none; }
    .ws-metrics { grid-template-columns:1fr 1fr; gap:20px; }
    .ws-compare { min-width:0; }
    .ws-compare th:nth-child(2), .ws-compare td:nth-child(2), .ws-compare th:nth-child(3), .ws-compare td:nth-child(3) { display:none; }
    .ws-compare th, .ws-compare td { padding-left:8px; }
    .ws-compare-scroll { overflow:visible; }
    .ws dialog.ws-sheet { margin:0; max-width:100vw; width:100vw; }
    .ws-dialog.sheet { width:100vw; height:100dvh; max-height:100dvh; border-radius:0; padding:0 18px 20px; }
    .ws dialog { max-width:calc(100vw - 16px); }
    .ws-dialog { padding:0 18px 20px; }
    .ws-timeline { grid-template-columns:88px minmax(0,1fr) 50px 30px; gap:6px; font-size:11px; }
    .ws-timeline .time, .ws-timeline .dur { font-size:10px; }
    .ws-cal { grid-template-columns:28px repeat(var(--weeks), minmax(0,40px)); gap:5px; }
    .ws-cal-cell { width:100%; height:auto; aspect-ratio:1; }
    .ws-time-fields { grid-template-columns:1fr; }
  }
`;
