// Self-contained dashboard page (HTML + inline CSS/JS, no build step, no assets).
// Auth is better-auth (cookies, same-origin fetch); data comes from /api/hours
// and /api/settings. Served at GET /.
const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clocked</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --fg:#e7e9ee; --muted:#9aa1ac; --acc:#4f8cff; --border:#262b36; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0; letter-spacing:.5px; }
  .top { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px; margin-bottom:16px; }
  label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:#0d0f14; color:var(--fg); font:inherit; }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > div { flex:1; }
  button { padding:10px 16px; border:0; border-radius:8px; background:var(--acc); color:#fff; font:inherit; font-weight:600; cursor:pointer; white-space:nowrap; }
  button.ghost { background:transparent; border:1px solid var(--border); color:var(--muted); font-weight:500; }
  button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--border); }
  th { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.4px; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .total { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:12px; border-top:1px solid var(--border); }
  .total b { font-size:24px; }
  .muted { color:var(--muted); }
  .msg { font-size:13px; margin-top:8px; min-height:18px; }
  .msg.err { color:#ff6b6b; } .msg.ok { color:#4fd18b; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>⏱ clocked</h1>
    <button id="signout" class="ghost hidden">Sign out</button>
  </div>

  <!-- Login -->
  <div id="login" class="card hidden">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" />
    <div style="height:12px"></div>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" />
    <div style="height:14px"></div>
    <button id="loginBtn">Sign in</button>
    <div id="loginMsg" class="msg"></div>
  </div>

  <!-- Dashboard -->
  <div id="app" class="hidden">
    <div class="card">
      <div class="row">
        <div>
          <label for="month">Month</label>
          <input id="month" type="month" />
        </div>
        <button id="load">View</button>
      </div>
      <table>
        <thead><tr><th>Day</th><th class="num">Hours</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="total"><span class="muted">Total</span><b id="total">0:00</b></div>
      <div id="hoursMsg" class="msg"></div>
    </div>

    <div class="card">
      <label for="mailTo">Send timesheet to</label>
      <div class="row">
        <div><input id="mailTo" type="email" placeholder="you@example.com" /></div>
        <button id="saveEmail">Save</button>
      </div>
      <div id="emailMsg" class="msg"></div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const api = (path, opts={}) => fetch(path, { credentials:"same-origin", headers:{"content-type":"application/json"}, ...opts });
const fmt = (min) => { const h = Math.floor(min/60), m = min%60; return h + ":" + String(m).padStart(2,"0"); };

function show(loggedIn) {
  $("login").classList.toggle("hidden", loggedIn);
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
  $("month").value = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0");
  await Promise.all([loadHours(), loadEmail()]);
}

async function loadHours() {
  const period = $("month").value;
  if (!period) return;
  $("hoursMsg").textContent = ""; $("hoursMsg").className = "msg";
  const r = await api("/api/hours?period=" + period);
  if (!r.ok) { $("hoursMsg").textContent = "Failed to load hours."; $("hoursMsg").className = "msg err"; return; }
  const d = await r.json();
  $("rows").innerHTML = d.days.length
    ? d.days.map((x) => "<tr><td>"+x.label+"</td><td class='num'>"+fmt(x.minutes)+"</td></tr>").join("")
    : "<tr><td class='muted' colspan='2'>No sessions this month.</td></tr>";
  $("total").textContent = fmt(d.totalMinutes);
}

async function loadEmail() {
  const r = await api("/api/settings");
  if (r.ok) { const d = await r.json(); $("mailTo").value = d.mailTo || ""; }
}

$("loginBtn").onclick = async () => {
  $("loginBtn").disabled = true; $("loginMsg").textContent = ""; $("loginMsg").className = "msg";
  const r = await api("/api/auth/sign-in/email", { method:"POST", body: JSON.stringify({ email:$("email").value.trim(), password:$("password").value }) });
  $("loginBtn").disabled = false;
  if (r.ok) { show(true); await afterLogin(); }
  else { const e = await r.json().catch(()=>({})); $("loginMsg").textContent = e.message || "Sign in failed."; $("loginMsg").className = "msg err"; }
};

$("signout").onclick = async () => { await api("/api/auth/sign-out", { method:"POST" }); show(false); };
$("load").onclick = loadHours;

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
