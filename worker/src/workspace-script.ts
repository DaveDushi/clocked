import { createWorkspaceModel } from "./workspace-model.js";
import { selectPrimaryMembership } from "./memberships.js";

// Inline client for the signed-in workspace. It shares the dashboard script's scope
// (api, $, createTimesheetView, the org globals and the retained settings handlers).
// Written as plain string-built JS like the rest of the dashboard: no backticks.
export const WORKSPACE_SCRIPT = "const wsModel = (" + createWorkspaceModel.toString() + ")();\n" +
  "const wsPrimaryMembership = (" + selectPrimaryMembership.toString() + ");\n" + String.raw`
const ws = {
  me: null, mode: "personal", page: "timesheets", period: "", query: "", expanded: new Set(),
  scope: "all", sort: "average", overview: null, overviewError: "", overviewVersion: 0,
  personal: null, personalError: "", memberData: null, memberKey: "", pending: null, policy: undefined,
  day: null, edit: null, send: null, busy: false, messageTarget: "", sheetId: "", settingsMember: ""
};
const wsEsc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wsArrow = "<svg class='icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' aria-hidden='true'><path d='m9 5 7 7-7 7'/></svg>";
const BREAK_NOTE = "Breaks are gaps of 2 minutes or more between recorded sessions on the same day. Overnight time is excluded. A gap shows how recording stopped, not why someone was away.";

function wsToday() { const now = new Date(); return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }; }
function wsCurrentPeriod() { const t = wsToday(); return wsModel.period(t.y, t.m); }
function wsIsTeam() { return ws.mode === "team"; }
function wsCanEdit() { return ws.mode !== "worker"; }
function wsMembers() { return ws.overview ? ws.overview.members : []; }
function wsMember(id) { return wsMembers().find((m) => m.id === id) || null; }
function wsRoleTag(role) {
  const roles = String(role || "").split(",").map((r) => r.trim());
  return roles.includes("owner") ? "Owner" : roles.includes("admin") ? "Manager" : "";
}

/** "Today" in the timezone the server used for the loaded month. */
function wsDataToday() {
  if (wsIsTeam() && ws.overview) return ws.overview.today;
  if (ws.personal && ws.personal.period === wsCurrentPeriod() && ws.personal.days.length) return ws.personal.days[ws.personal.days.length - 1].date;
  const t = wsToday();
  return wsModel.period(t.y, t.m) + "-" + wsModel.pad(t.d);
}
function wsRecordedThrough() {
  return ws.period === wsCurrentPeriod()
    ? "Recorded through " + wsModel.dayLabel(wsDataToday())
    : wsModel.monthLabel(ws.period) + " complete";
}
function wsPeriodNotice() {
  return ws.period === wsCurrentPeriod()
    ? "<p class='ws-notice'>" + wsEsc(wsModel.monthLabel(ws.period).split(" ")[0]) + " is still in progress. This includes sessions recorded through " + wsEsc(wsModel.dayLabel(wsDataToday())) + ". Sending now will not include the rest of the month.</p>"
    : "<p class='ws-complete'>Complete month · " + wsEsc(wsModel.monthLabel(ws.period)) + "</p>";
}

// ---- dialogs: native modal dialogs trap focus; the stack restores it on close ----
const wsDialogs = [];
function wsFocusFirst(dialog) {
  const target = dialog.querySelector("[data-autofocus]") ||
    Array.from(dialog.querySelectorAll("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea, button:not([disabled]):not([data-close])"))
      .find((el) => el.getClientRects().length) || dialog.querySelector("[data-close]");
  if (target) target.focus({ preventScroll: true });
}
function wsOpenDialog(id, opener) {
  const dialog = $(id);
  if (dialog.open) { wsFocusFirst(dialog); return; }
  const from = opener || document.activeElement;
  wsDialogs.push({ id, opener: from, key: from && from.dataset ? from.dataset.key || "" : "" });
  dialog.showModal();
  wsFocusFirst(dialog);
}
function wsCloseDialog(id) { const dialog = $(id); if (dialog && dialog.open) dialog.close(); }
function wsRestoreFocus(frame) {
  if (frame.opener && frame.opener.isConnected && frame.opener.getClientRects().length) { frame.opener.focus({ preventScroll: true }); return; }
  const keyed = frame.key ? document.querySelector("#workspace [data-key='" + frame.key.replace(/'/g, "") + "']") : null;
  if (keyed) { keyed.focus({ preventScroll: true }); return; }
  const top = wsDialogs.length ? $(wsDialogs[wsDialogs.length - 1].id) : null;
  if (top) wsFocusFirst(top); else $("wsMain").focus({ preventScroll: true });
}
document.querySelectorAll("#workspace dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("close", () => {
    const index = wsDialogs.findIndex((frame) => frame.id === dialog.id);
    if (index < 0) return;
    const frame = wsDialogs.splice(index, 1)[0];
    if (dialog.id === "dlgDay") ws.day = null;
    if (dialog.id === "dlgEdit") { ws.edit = null; ws.messageTarget = ""; if (!$("dlgDay").open) ws.day = null; }
    if (dialog.id === "dlgSheet") ws.sheetId = "";
    wsRestoreFocus(frame);
  });
});
function wsDialogHead(id, title) {
  return "<div class='ws-dialog-head'><h2 id='" + id + "'>" + wsEsc(title) + "</h2><button type='button' class='text-button' data-close aria-label='Close'>&times;</button></div>";
}
function wsFeedback(id, text, kind) {
  const el = $(id);
  if (!el) return false;
  el.textContent = text || "";
  el.className = "ws-feedback" + (text ? " " + (kind || "err") : "");
  return true;
}

// ---- data ----
const personalView = createTimesheetView({
  request: api,
  loading(target, retained) {
    if (retained) return;
    ws.personal = null; ws.personalError = "";
    wsRender();
  },
  render(data) { ws.personal = data; ws.personalError = ""; wsRender(); wsRefreshDay(); },
  selection() {},
  busy(pending) { ws.busy = pending; wsSyncBusy(); },
  message(text, retry) { wsRouteMessage(text, retry, false); }
});
const memberView = createTimesheetView({
  request: api,
  loading(target, retained) {
    if (retained) return;
    ws.memberData = null; ws.memberKey = target.key;
    wsRefreshDay();
  },
  render(data, target) { ws.memberData = data; ws.memberKey = target.key; wsRefreshDay(); },
  selection() {},
  busy(pending) { ws.busy = pending; wsSyncBusy(); },
  message(text, retry) { wsRouteMessage(text, retry, true); }
});
function wsSyncBusy() {
  document.querySelectorAll("#workspace [data-edit-control]").forEach((el) => { el.disabled = ws.busy || el.dataset.blocked === "1"; });
}
function wsRouteMessage(text, retry, team) {
  if (!text) { if (ws.messageTarget) wsFeedback(ws.messageTarget, ""); return; }
  const kind = text === "Saved." ? "ok" : "err";
  if (ws.messageTarget && wsFeedback(ws.messageTarget, text, kind)) return;
  if (ws.day && wsFeedback("dayMsg", text, kind)) return;
  if (!team && !ws.personal && kind === "err") { ws.personalError = text; ws.personalRetry = retry; wsRender(); }
}

function wsLoadPage() {
  if (wsIsTeam()) return wsLoadOverview(false);
  return personalView.load({
    key: ws.me.user.id + ":" + ws.period, period: ws.period, label: ws.me.user.email,
    hoursUrl: "/api/hours?period=" + ws.period, editUrl: "/api/manual-session"
  });
}
async function wsLoadOverview(keep) {
  const version = ++ws.overviewVersion;
  if (!keep) { ws.overview = null; ws.overviewError = ""; wsRender(); }
  try {
    const response = await api("/api/team/overview?organizationId=" + encodeURIComponent(orgId) + "&period=" + ws.period);
    const data = await response.json().catch(() => ({}));
    if (version !== ws.overviewVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not load team timesheets.");
    ws.overview = data; ws.overviewError = "";
    memberCount = data.members.length;
  } catch (error) {
    if (version !== ws.overviewVersion) return;
    ws.overviewError = "Could not load team timesheets. Check your connection and try again.";
    if (!keep) ws.overview = null;
  }
  wsRender();
  wsRefreshSheet();
}
async function wsLoadPending() {
  try {
    const response = await api("/api/auth/organization/list-invitations?organizationId=" + encodeURIComponent(orgId));
    const data = await response.json();
    if (!response.ok) throw new Error();
    const list = Array.isArray(data) ? data : (data.invitations || []);
    ws.pending = list.filter((inv) => inv.status === "pending" && (!inv.expiresAt || new Date(inv.expiresAt) > new Date()));
  } catch { ws.pending = null; }
  if (ws.page === "timesheets") wsRenderBottom();
  wsRenderPending();
}
async function wsLoadPolicy() {
  try {
    const response = await api("/api/team/inactivity?organizationId=" + encodeURIComponent(orgId));
    const data = await response.json();
    if (!response.ok) throw new Error();
    ws.policy = data.policy || null;
  } catch { ws.policy = undefined; }
  $("inactivitySummary").textContent = ws.policy === undefined ? "Could not load the team policy"
    : ws.policy ? "Team limit: " + Math.round(ws.policy.timeout_secs / 60) + " minutes without input" : "Each computer uses its own setting";
  if (ws.page === "stats") wsRender();
}

// ---- URL state ----
function wsSyncUrl() {
  const url = new URL(location.href);
  url.searchParams.set("view", ws.page);
  url.searchParams.set("month", ws.period);
  history.replaceState({}, "", url.pathname + url.search);
}

// ---- rendering ----
function wsMonthSelect() {
  const t = wsToday();
  return "<select class='ws-month' data-role='month' aria-label='Reporting month'>" +
    wsModel.monthOptions(t, 36, ws.period).map((o) => "<option value='" + o.value + "'" + (o.value === ws.period ? " selected" : "") + ">" + wsEsc(o.label) + "</option>").join("") +
    "</select>";
}
function wsState(text, error, retry) {
  return "<div class='ws-state' role='status'>" + (error ? "<span class='err'>" + wsEsc(error) + "</span><button type='button' data-action='" + retry + "'>Try again</button>" : wsEsc(text)) + "</div>";
}
function wsRender() {
  document.querySelectorAll("#workspace .ws-nav button").forEach((button) => {
    if (button.dataset.page === ws.page) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  const main = $("wsMain");
  const scrollY = window.scrollY;
  const heat = main.querySelector(".ws-heat-scroll");
  const heatLeft = heat ? heat.scrollLeft : 0;
  const focusKey = document.activeElement && main.contains(document.activeElement) ? document.activeElement.dataset.key || document.activeElement.dataset.role || "" : "";
  main.innerHTML = ws.page === "stats" ? wsStatsHtml() : wsIsTeam() ? wsTeamHtml() : wsPersonalHtml();
  if (ws.page === "timesheets" && wsIsTeam() && ws.overview) wsRenderRoster();
  const nextHeat = main.querySelector(".ws-heat-scroll");
  if (nextHeat) nextHeat.scrollLeft = heatLeft;
  window.scrollTo(0, scrollY);
  if (focusKey) {
    const again = main.querySelector("[data-key='" + focusKey + "'], [data-role='" + focusKey + "']");
    if (again) again.focus({ preventScroll: true });
  }
}

// Team timesheets
function wsTeamHtml() {
  const head = "<div class='ws-title'><h1>Team<span class='count'>" + (ws.overview ? ws.overview.members.length + " member" + (ws.overview.members.length === 1 ? "" : "s") : "") + "</span></h1>" +
    "<button type='button' data-action='invite' data-key='invite'>+ Invite member</button></div>";
  if (!ws.overview) return head + wsState("Loading team timesheets…", ws.overviewError, "reload");
  const stale = ws.overviewError ? "<p class='ws-feedback err' role='status'>" + wsEsc(ws.overviewError) + "</p>" : "";
  return head + stale +
    "<div class='ws-toolbar'><div class='ws-toolbar-left'>" + wsMonthSelect() +
    "<input type='search' class='ws-search' data-role='search' placeholder='Find a member' aria-label='Find a member' value='" + wsEsc(ws.query) + "' /></div>" +
    "<div class='ws-team-actions'><button type='button' data-action='toggle-all' id='wsViewAll' aria-pressed='false'>View all timesheets</button>" +
    "<button type='button' class='primary' data-action='send-all' data-key='send-all'>Send all &#8599;</button></div></div>" +
    "<table class='ws-roster'><caption class='sr-only'>Member timesheets for " + wsEsc(wsModel.monthLabel(ws.period)) + "</caption>" +
    "<thead><tr><th scope='col'>Member</th><th scope='col' class='days'>Days</th><th scope='col' class='num'>Worked time</th><th scope='col' class='end'><span class='sr-only'>Details</span></th></tr></thead>" +
    "<tbody id='wsRosterBody'></tbody><tfoot id='wsRosterFoot'></tfoot></table>" +
    "<div class='ws-bottom' id='wsBottom'></div>";
}
function wsVisibleMembers() {
  const q = ws.query.trim().toLowerCase();
  return wsMembers().filter((m) => !q || (m.name + " " + m.email).toLowerCase().includes(q));
}
function wsRenderRoster() {
  const body = $("wsRosterBody");
  if (!body) return;
  const visible = wsVisibleMembers();
  body.innerHTML = visible.length ? visible.map((m) => {
    const open = ws.expanded.has(m.id);
    const tag = wsRoleTag(m.role);
    return "<tr class='ws-row" + (open ? " open" : "") + "'><td><button type='button' class='ws-member' data-action='toggle-member' data-id='" + wsEsc(m.id) + "' data-key='member:" + wsEsc(m.id) + "' aria-expanded='" + open + "' aria-controls='detail-" + wsEsc(m.id) + "'>" +
      wsEsc(m.name) + (tag ? "<span class='ws-role'>" + tag + "</span>" : "") + "</button></td>" +
      "<td class='days'>" + m.stats.recordedDays + "</td><td class='num'>" + wsModel.duration(m.stats.workedMinutes) + "</td>" +
      "<td><button type='button' class='ws-expand' data-action='toggle-member' data-id='" + wsEsc(m.id) + "' aria-expanded='" + open + "' aria-label='Toggle " + wsEsc(m.name) + " timesheet'>" + wsArrow + "</button></td></tr>" +
      (open ? "<tr id='detail-" + wsEsc(m.id) + "'><td colspan='4' class='ws-detail-cell'>" + wsMemberDetail(m, false) + "</td></tr>" : "");
  }).join("") : "<tr><td colspan='4' class='ws-empty'>" + (wsMembers().length ? "No members match your search." : "No members yet. Invite someone to get started.") + "</td></tr>";
  const total = visible.reduce((sum, m) => sum + m.stats.workedMinutes, 0);
  $("wsRosterFoot").innerHTML = visible.length ? "<tr class='ws-total'><td colspan='2'>" + (ws.query.trim() ? "Matching members" : "Team total") + "</td><td class='num'>" + wsModel.duration(total) + "</td><td></td></tr>" : "";
  const all = wsMembers().length > 0 && wsMembers().every((m) => ws.expanded.has(m.id));
  const viewAll = $("wsViewAll");
  viewAll.textContent = all ? "Collapse all" : "View all timesheets";
  viewAll.setAttribute("aria-pressed", String(all));
  wsRenderBottom();
}
function wsRenderBottom() {
  const bottom = $("wsBottom");
  if (!bottom) return;
  const count = ws.pending ? ws.pending.length : 0;
  bottom.innerHTML = "<span>" + wsEsc(wsRecordedThrough()) + "</span>" +
    (count ? "<button type='button' class='text-button' data-action='invite' data-key='pending'>" + count + " pending invitation" + (count === 1 ? "" : "s") + " &#8599;</button>" : "");
}
function wsMemberDetail(m, inSheet) {
  const rows = m.days.map((d) => "<button type='button' class='ws-daily' data-action='open-day' data-user='" + wsEsc(m.id) + "' data-date='" + d.date + "' data-key='day:" + wsEsc(m.id) + ":" + d.date + (inSheet ? ":sheet" : "") + "' aria-label='View " + wsEsc(m.name) + " sessions on " + wsEsc(wsModel.dayLabel(d.date, true)) + "'>" +
    "<span>" + wsEsc(wsModel.dayLabel(d.date)) + "</span><span class='span'>" + d.start + " – " + d.end + "</span>" +
    "<span class='brk'>" + wsModel.shortDuration(d.breakMinutes) + "</span><span class='hrs'>" + wsModel.duration(d.minutes) + "</span></button>").join("");
  return "<section class='ws-detail' aria-label='" + wsEsc(m.name) + " recorded days'>" +
    (inSheet ? "<div style='height:6px'></div>" : "<div class='ws-detail-head'><strong>" + wsEsc(m.name) + "</strong><small>" + wsEsc(wsModel.monthLabel(ws.period)) + " · " + m.stats.recordedDays + " day" + (m.stats.recordedDays === 1 ? "" : "s") + " · " + wsModel.duration(m.stats.workedMinutes) + "</small></div>") +
    (m.days.length ? "<div class='ws-daily-head'><span>Date</span><span class='span'>Day span</span><span>Breaks</span><span>Worked</span></div>" + rows +
      "<div class='ws-subtotal'><span>Member total</span><span class='mono'>" + wsModel.duration(m.stats.workedMinutes) + " worked · " + wsModel.duration(m.stats.breakMinutes) + " breaks</span></div>"
      : "<p class='ws-empty'>No sessions recorded in " + wsEsc(wsModel.monthLabel(ws.period)) + ".</p>") +
    "<div class='ws-detail-actions'><div><button type='button' class='text-button' data-action='member-settings' data-id='" + wsEsc(m.id) + "' data-key='msettings:" + wsEsc(m.id) + (inSheet ? ":sheet" : "") + "'>Member settings</button>" +
    "<button type='button' class='text-button' data-action='add-day' data-user='" + wsEsc(m.id) + "' data-key='add-day:" + wsEsc(m.id) + (inSheet ? ":sheet" : "") + "'>Add time</button>" +
    (m.days.length ? "<button type='button' class='text-button' data-action='preview' data-user='" + wsEsc(m.id) + "'>Preview CSV</button>" : "") + "</div>" +
    (m.days.length ? "<small>Select a date to review or edit a session</small>" : "") + "</div></section>";
}

// Personal and worker timesheet
function wsPersonalHtml() {
  const worker = ws.mode === "worker";
  const head = "<div class='ws-title'><div><h1>My timesheet</h1><p>" + wsEsc(ws.me.user.email) + "</p></div></div>";
  const toolbar = "<div class='ws-toolbar'>" + wsMonthSelect() + (worker ? "" : "<button type='button' class='primary' data-action='personal-send' data-key='personal-send'>Send timesheet &#8599;</button>") + "</div>";
  if (!ws.personal) return head + toolbar + wsState("Loading your timesheet…", ws.personalError, "reload");
  const data = ws.personal;
  const days = data.recordedDays || [];
  const breaks = days.reduce((sum, d) => sum + d.breakMinutes, 0);
  const table = days.length
    ? "<table class='ws-personal'><caption class='sr-only'>Your worked time and breaks for " + wsEsc(wsModel.monthLabel(ws.period)) + "</caption>" +
      "<thead><tr><th scope='col'>Date</th><th scope='col' class='ws-span'>Day span</th><th scope='col' class='num'>Breaks</th><th scope='col' class='num'>Worked time</th></tr></thead><tbody>" +
      days.map((d) => "<tr><td><button type='button' class='ws-day-link' data-action='open-day' data-user='' data-date='" + d.date + "' data-key='day::" + d.date + "'>" + wsEsc(wsModel.dayLabel(d.date)) + "</button></td>" +
        "<td class='ws-span'>" + d.start + " – " + d.end + "</td><td class='num break-value'>" + wsModel.shortDuration(d.breakMinutes) + "</td><td class='num'>" + wsModel.duration(d.minutes) + "</td></tr>").join("") +
      "</tbody><tfoot><tr class='ws-total'><td>Month total</td><td class='ws-span'></td><td class='num'>" + wsModel.duration(breaks) + "</td><td class='num'>" + wsModel.duration(data.totalMinutes) + "</td></tr></tfoot></table>"
    : "<p class='ws-empty'>No sessions recorded in " + wsEsc(wsModel.monthLabel(ws.period)) + "." + (worker ? "" : " Connect the desktop app in Settings, or add time from a day.") + "</p>";
  const projects = (data.projects || []).length ? "<section class='ws-projects'><h2>By project</h2>" + (function () {
    const max = data.projects.reduce((a, p) => Math.max(a, p.minutes || 0), 0) || 1;
    return data.projects.slice(0, 12).map((p) => "<div class='ws-project'><span title='" + wsEsc(p.project) + "'>" + wsEsc(p.project) + "</span><i style='width:" + Math.max(4, Math.round((p.minutes / max) * 100)) + "%'></i><span class='mono' style='text-align:right'>" + wsModel.duration(p.minutes) + "</span></div>").join("");
  })() + "<p class='ws-note'>Project totals come from optional activity tracking on your computers and are separate from worked time.</p></section>" : "";
  return head + toolbar + table +
    "<div class='ws-bottom'><span>" + wsEsc(wsRecordedThrough()) + "</span><span>" + (days.length ? (worker ? "Select a date to review it" : "Select a date to review or edit") : "") +
    (worker ? "" : "</span><button type='button' class='text-button' data-action='add-day' data-user='' data-key='add-day:'>+ Add time to a day without sessions</button><span>") + "</span></div>" +
    (worker ? "<p class='ws-locked'>Your team manager handles corrections to your timesheet.</p>" : "") +
    "<p class='ws-note'>" + BREAK_NOTE + "</p>" + projects;
}

// Stats
function wsMetric(label, value, hint) {
  return "<div class='ws-metric'><label>" + label + "</label><strong>" + value + "</strong><small>" + wsEsc(hint) + "</small></div>";
}
function wsMetrics(stats, all, name) {
  const days = stats.recordedDays;
  return "<div class='ws-metrics'>" +
    wsMetric("Worked time", wsModel.duration(stats.workedMinutes), all ? "All " + wsMembers().length + " members" : name || days + " recorded day" + (days === 1 ? "" : "s")) +
    wsMetric("Break time", wsModel.duration(stats.breakMinutes), stats.breakCount + " break" + (stats.breakCount === 1 ? "" : "s")) +
    wsMetric("Avg. break time / day", wsModel.shortDuration(stats.avgBreakMinutes), all ? "Per recorded member-day" : "Includes zero-break days") +
    wsMetric("Breaks / day", wsModel.rate(stats.breaksPerDay), days + (all ? " recorded member-day" : " recorded day") + (days === 1 ? "" : "s")) +
    "</div>";
}
function wsStatsHtml() {
  const team = wsIsTeam();
  const head = "<div class='ws-title'><div><h1>" + (team ? "Team stats" : "My stats") + "</h1><p>Recorded worked time and breaks for the selected month.</p></div></div>";
  let filters = "<div class='ws-stats-filters'>" + wsMonthSelect();
  if (team && ws.overview) {
    if (ws.scope !== "all" && !wsMember(ws.scope)) ws.scope = "all";
    filters += "<select data-role='scope' aria-label='Stats for'><option value='all'>All " + wsMembers().length + " members</option>" +
      wsMembers().map((m) => "<option value='" + wsEsc(m.id) + "'" + (ws.scope === m.id ? " selected" : "") + ">" + wsEsc(m.name) + "</option>").join("") + "</select>";
  }
  filters += "</div>";
  if (team) {
    if (!ws.overview) return head + filters + wsState("Loading team stats…", ws.overviewError, "reload");
    if (ws.scope === "all") {
      return head + filters + wsMetrics(ws.overview.team, true) + (ws.overview.team.recordedDays ? wsComparisonHtml() + wsBreakGridHtml() : "<p class='ws-empty'>No sessions recorded in " + wsEsc(wsModel.monthLabel(ws.period)) + ".</p>");
    }
    const m = wsMember(ws.scope);
    return head + filters + wsMetrics(m.stats, false, m.name) + wsWorkedCalendarHtml(m.days, m.id);
  }
  if (!ws.personal) return head + filters + wsState("Loading your stats…", ws.personalError, "reload");
  return head + filters + wsMetrics(ws.personal.stats, false) + wsWorkedCalendarHtml(ws.personal.recordedDays || [], "");
}
function wsComparisonHtml() {
  const members = ws.overview.members;
  const rows = wsModel.sortMembers(members, ws.sort);
  const max = members.reduce((a, m) => Math.max(a, m.stats.avgBreakMinutes), 0);
  const median = ws.overview.median;
  const option = (value, label) => "<option value='" + value + "'" + (ws.sort === value ? " selected" : "") + ">" + label + "</option>";
  return "<section class='ws-section'><div class='ws-section-head'><h2>Breaks by member</h2>" +
    "<select data-role='sort' aria-label='Sort members'>" + option("average", "Highest daily break time") + option("breaks", "Most breaks per day") + option("name", "Name") + "</select></div>" +
    "<div class='ws-compare-scroll'><table class='ws-compare'><caption class='sr-only'>Break comparison for " + wsEsc(wsModel.monthLabel(ws.period)) + "</caption><thead><tr><th scope='col'>Member</th><th scope='col' class='num'>Worked</th><th scope='col' class='num'>Break time</th><th scope='col' class='num'>Breaks / day</th><th scope='col' class='num'>Avg. break time / day</th></tr></thead><tbody>" +
    "<tr class='ws-ref'><th scope='row' style='font-weight:400;text-align:left;padding:12px 0;font-size:12px'>Team median <small>(" + median.members + " with recorded days)</small></th><td class='num'>—</td><td class='num'>—</td><td class='num'>" + (median.breaksPerDay == null ? "—" : wsModel.rate(median.breaksPerDay)) + "</td><td class='num'>" + (median.avgBreakMinutes == null ? "—" : wsModel.shortDuration(median.avgBreakMinutes)) + "</td></tr>" +
    rows.map((m) => {
      const recorded = m.stats.recordedDays > 0;
      return "<tr><td><button type='button' data-action='open-sheet' data-id='" + wsEsc(m.id) + "' data-key='sheet:" + wsEsc(m.id) + "' aria-label='Review " + wsEsc(m.name) + " recorded days'>" + wsEsc(m.name) + " &#8599;</button>" + (recorded ? "" : " <small>No recorded days</small>") + "</td>" +
        "<td class='num'>" + wsModel.duration(m.stats.workedMinutes) + "</td><td class='num break-value'>" + (recorded ? wsModel.duration(m.stats.breakMinutes) : "—") + "</td>" +
        "<td class='num'>" + (recorded ? wsModel.rate(m.stats.breaksPerDay) : "—") + "</td>" +
        "<td class='num ws-bar'>" + (recorded ? "<i style='width:" + (max ? (m.stats.avgBreakMinutes / max) * 100 : 0) + "%'></i>" + wsModel.shortDuration(m.stats.avgBreakMinutes) : "—") + "</td></tr>";
    }).join("") +
    "</tbody></table></div><p class='ws-note'>Averages include recorded days without breaks and leave out days without sessions, so people with different numbers of recorded days compare fairly. The team median is the middle of each member's own daily average.</p>" +
    wsPolicyNote() + "</section>";
}
function wsPolicyNote() {
  if (ws.policy === undefined) return "";
  return "<p class='ws-note'>" + (ws.policy
    ? "Team inactivity limit: " + Math.round(ws.policy.timeout_secs / 60) + " minutes without input. Desktop apps apply it after their next sync. Sessions do not record which limit was active, so gaps from before a change may reflect each computer's own setting."
    : "Each computer uses its own inactivity limit, so the same pause can end a session on one computer and not on another. Set a team limit in Settings to make future idle gaps comparable.") + "</p>";
}
function wsBreakGridHtml() {
  const dates = wsModel.visibleDates(ws.period, ws.overview.today);
  const header = "<div class='ws-heat-row' aria-hidden='true'><span class='ws-heat-corner'></span>" + dates.map((d) => "<span class='ws-heat-label'>" + Number(d.slice(8)) + "</span>").join("") + "</div>";
  const body = ws.overview.members.map((m) => {
    const byDate = {};
    m.days.forEach((d) => { byDate[d.date] = d; });
    return "<div class='ws-heat-row'><button type='button' class='ws-heat-name' data-action='open-sheet' data-id='" + wsEsc(m.id) + "' data-key='heat:" + wsEsc(m.id) + "' title='" + wsEsc(m.name) + "'>" + wsEsc(m.name) + "</button>" +
      dates.map((date) => {
        const d = byDate[date];
        const label = m.name + ", " + wsModel.dayLabel(date, true) + ": ";
        if (!d) return "<span class='ws-heat-cell none' role='img' aria-label='" + wsEsc(label + "no recorded sessions") + "' title='" + wsEsc(m.name + " · " + wsModel.dayLabel(date) + " · No recorded sessions") + "'></span>";
        const text = d.breakMinutes ? wsModel.shortDuration(d.breakMinutes) + " break time in " + d.breakCount + " break" + (d.breakCount === 1 ? "" : "s") : "recorded, no breaks";
        return "<button type='button' class='ws-heat-cell' style='--strength:" + wsModel.breakStrength(d.breakMinutes) + "' data-action='open-day' data-user='" + wsEsc(m.id) + "' data-date='" + date + "' data-key='hday:" + wsEsc(m.id) + ":" + date + "' aria-label='" + wsEsc(label + text) + "' title='" + wsEsc(m.name + " · " + wsModel.dayLabel(date) + " · " + text) + "'></button>";
      }).join("") + "</div>";
  }).join("");
  return "<section class='ws-section'><div class='ws-section-head'><h2>Daily break time</h2><small>" + wsEsc(wsModel.monthLabel(ws.period)) + "</small></div>" +
    "<div class='ws-heat-scroll'><div class='ws-heat' role='group' aria-label='Break time by member and day' style='--days:" + dates.length + "'>" + header + body + "</div></div>" +
    "<div class='ws-legend'><span>0m</span>" + [0, 30, 60, 90, 120].map((v) => "<i style='background:rgba(242,169,80," + wsModel.breakStrength(v) + ")'></i>").join("") + "<span>120m+</span><span class='gap'></span><i class='none-key'></i><span>No recorded sessions</span></div>" +
    "<p class='ws-note'>The faintest squares are recorded days without breaks. Select a day to inspect its sessions. On small screens, scroll the grid sideways.</p></section>";
}
function wsWorkedCalendarHtml(days, userId) {
  const cal = wsModel.calendar(ws.period);
  const today = wsDataToday();
  const byDate = {};
  days.forEach((d) => { byDate[d.date] = d; });
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let cells = "";
  for (let row = 0; row < 7; row++) {
    cells += "<span class='ws-cal-day' aria-hidden='true'>" + labels[row] + "</span>";
    for (let week = 0; week < cal.weeks; week++) {
      const day = week * 7 + row - cal.offset + 1;
      if (day < 1 || day > cal.last) { cells += "<span class='ws-cal-cell outside' aria-hidden='true'></span>"; continue; }
      const date = ws.period + "-" + wsModel.pad(day);
      const d = byDate[date];
      const nice = wsModel.dayLabel(date, true);
      if (!d) {
        const future = date > today;
        const text = nice + ": " + (future ? "not yet recorded" : "no recorded sessions");
        cells += !future && wsCanEdit()
          ? "<button type='button' class='ws-cal-cell none' data-action='open-day' data-user='" + wsEsc(userId) + "' data-date='" + date + "' data-key='cal:" + wsEsc(userId) + ":" + date + "' aria-label='" + wsEsc(text) + "' title='" + wsEsc(wsModel.dayLabel(date) + " · No recorded sessions") + "'>" + day + "</button>"
          : "<span class='ws-cal-cell " + (future ? "future" : "none") + "' role='img' aria-label='" + wsEsc(text) + "' title='" + wsEsc(wsModel.dayLabel(date) + " · " + (future ? "Not yet recorded" : "No recorded sessions")) + "' style='display:inline-flex;align-items:center;justify-content:center;font:11px var(--mono)'>" + day + "</span>";
        continue;
      }
      const level = wsModel.workedLevel(d.minutes);
      cells += "<button type='button' class='ws-cal-cell' style='--shade:" + wsModel.WORK_SHADES[level] + ";--ink:" + (level < 3 ? "#38220d" : "#ffeed7") + "' data-action='open-day' data-user='" + wsEsc(userId) + "' data-date='" + date + "' data-key='cal:" + wsEsc(userId) + ":" + date + "' data-minutes='" + d.minutes + "' aria-label='" + wsEsc(nice + ": " + wsModel.duration(d.minutes) + " worked") + "' title='" + wsEsc(wsModel.dayLabel(date) + " · " + wsModel.duration(d.minutes) + " worked") + "'>" + day + "</button>";
    }
  }
  return "<section class='ws-section'><div class='ws-section-head'><h2>Worked time by day</h2><small>" + wsEsc(wsModel.monthLabel(ws.period)) + "</small></div>" +
    "<div class='ws-cal' style='--weeks:" + cal.weeks + "' role='group' aria-label='Daily worked time. Darker amber means more worked time.'>" + cells + "</div>" +
    "<div class='ws-legend'><span>Less</span>" + wsModel.WORK_SHADES.map((shade, i) => "<i style='background:" + shade + "' title='" + wsModel.WORK_LEVELS[i] + "'></i>").join("") + "<span>More</span><span class='gap'></span><i class='none-key'></i><span>No sessions</span><span class='gap'></span><i class='future-key'></i><span>Not yet recorded</span></div>" +
    "<p class='ws-note'>Darker amber means more worked time, excluding breaks. Select a day to see its sessions and breaks.</p></section>";
}

// ---- member sheet (Stats) ----
function wsOpenSheet(id, opener) {
  ws.sheetId = id;
  wsRenderSheet();
  wsOpenDialog("dlgSheet", opener);
}
function wsRenderSheet() {
  const m = wsMember(ws.sheetId);
  const body = $("dlgSheetBody");
  const top = body.scrollTop;
  if (!m) { body.innerHTML = wsDialogHead("dlgSheetTitle", "Member") + "<p>This member is no longer on the team.</p>"; return; }
  body.innerHTML = wsDialogHead("dlgSheetTitle", m.name) +
    "<p class='sub'>" + wsEsc(wsModel.monthLabel(ws.period)) + " · " + m.stats.recordedDays + " recorded day" + (m.stats.recordedDays === 1 ? "" : "s") + "</p>" +
    "<div class='ws-sheet-summary'><div>Worked<strong>" + wsModel.duration(m.stats.workedMinutes) + "</strong></div><div>Avg. break time / day<strong>" + wsModel.shortDuration(m.stats.avgBreakMinutes) + "</strong></div><div>Breaks / day<strong>" + wsModel.rate(m.stats.breaksPerDay) + "</strong></div></div>" +
    wsMemberDetail(m, true);
  body.scrollTop = top;
}
function wsRefreshSheet() { if ($("dlgSheet").open) wsRenderSheet(); }

// ---- day dialog ----
function wsMemberTarget(userId) {
  const query = "organizationId=" + encodeURIComponent(orgId) + "&userId=" + encodeURIComponent(userId);
  return { key: userId + ":" + ws.period, period: ws.period, label: userId,
    hoursUrl: "/api/team/hours?" + query + "&period=" + ws.period, editUrl: "/api/team/manual-session?" + query };
}
function wsOpenDay(userId, date, opener) {
  ws.day = { userId: userId || "", date };
  if (userId) {
    const target = wsMemberTarget(userId);
    if (ws.memberKey !== target.key || !ws.memberData) memberView.load(target);
  }
  wsRefreshDay(true);
  wsOpenDialog("dlgDay", opener);
}
function wsDayData() {
  if (!ws.day) return null;
  if (!ws.day.userId) return ws.personal;
  return ws.memberKey === ws.day.userId + ":" + ws.period ? ws.memberData : null;
}
function wsSourceLabel(s, ownerName) {
  if (s.entry) {
    const who = s.editor === "other" ? "a manager" : ws.day.userId ? ownerName : "you";
    return (s.entry === "edited" ? "Edited by " : "Added by ") + who;
  }
  if (s.start_reason === "manual" && s.end_reason === "manual") return "Started and ended manually";
  return "Recorded · " + wsModel.reasonLabel(s.start_reason) + " to " + wsModel.reasonLabel(s.end_reason);
}
function wsRefreshDay(force) {
  if (!ws.day || (!force && !$("dlgDay").open)) return;
  const body = $("dlgDayBody");
  const top = body.scrollTop;
  const data = wsDayData();
  const member = ws.day.userId ? wsMember(ws.day.userId) : null;
  const ownerName = member ? member.name : "";
  const editable = wsCanEdit();
  let html = wsDialogHead("dlgDayTitle", wsModel.dayLabel(ws.day.date, true)) + (member ? "<p class='sub'>" + wsEsc(member.name) + "</p>" : "");
  if (!data) {
    html += "<p class='sub' role='status'>Loading sessions…</p><div id='dayMsg' class='ws-feedback' role='status'></div>";
    body.innerHTML = html; return;
  }
  const day = (data.recordedDays || []).find((d) => d.date === ws.day.date) || null;
  const entries = wsModel.dayEntries(data.sessions || [], day);
  if (!day) {
    html += "<p class='sub'>No sessions recorded on this day.</p>";
  } else {
    html += "<div class='ws-day-summary'><div>Worked time<strong>" + wsModel.duration(day.minutes) + "</strong></div><div>Break time<strong>" + wsModel.shortDuration(day.breakMinutes) + "</strong></div><div>Breaks<strong>" + day.breaks.length + "</strong></div></div>" +
      entries.map((e) => {
        if (e.kind === "break") {
          return "<div class='ws-timeline gap'><span class='time'>" + e.gap.start + " – " + e.gap.end + "</span><div><span class='what'>Break</span><small class='source'>" + wsEsc(wsModel.causeLabel(e.gap.cause)) + "</small></div><span class='dur'>" + wsModel.shortDuration(e.gap.minutes) + "</span><span></span></div>";
        }
        const s = e.session;
        const notes = [wsSourceLabel(s, ownerName)];
        if (e.overlaps) notes.push("Overlaps another session, counted once");
        if (s.sessionStartUtc && s.startMin === 0 && Date.parse(s.sessionStartUtc) < s.startMs) notes.push("Started the previous day");
        if (s.sessionEndUtc && s.endMin === 1440 && Date.parse(s.sessionEndUtc) > s.endMs) notes.push("Continues after midnight");
        return "<div class='ws-timeline" + (s.entry ? " edited" : "") + "'><span class='time'>" + s.start + " – " + s.end + "</span><div><span class='what'>Work session</span><small class='source'>" + wsEsc(notes.join(" · ")) + "</small></div><span class='dur'>" + wsModel.shortDuration(s.minutes) + "</span>" +
          (editable ? "<button type='button' class='text-button' data-action='edit-session' data-id='" + wsEsc(s.id) + "' data-key='edit:" + wsEsc(s.id) + "' data-edit-control aria-label='Edit session " + s.start + " to " + s.end + "'>Edit</button>" : "<span></span>") + "</div>";
      }).join("");
  }
  html += (editable ? "<div class='ws-actions-row'><button type='button' data-action='add-session' data-key='add-session' data-edit-control>+ Add missing session</button></div>" : "") +
    "<div id='dayMsg' class='ws-feedback' role='status'></div><p class='ws-note'>" + BREAK_NOTE + "</p>";
  body.innerHTML = html;
  body.scrollTop = top;
  wsSyncBusy();
}

// ---- edit / add session ----
async function wsOpenAddDay(userId, opener) {
  ws.day = { userId: userId || "", date: "" };
  if (userId) {
    const target = wsMemberTarget(userId);
    if (ws.memberKey !== target.key || !ws.memberData) await memberView.load(target);
  }
  if (!wsDayData()) return;
  wsOpenEdit("", opener);
}
function wsOpenEdit(sessionId, opener) {
  const data = wsDayData();
  const segment = sessionId && data ? (data.sessions || []).find((s) => s.id === sessionId) : null;
  if (sessionId && !segment) return;
  let date = ws.day.date, start = "", end = "", overnight = false, tooLong = false;
  if (segment) {
    const a = wsModel.zonedParts(segment.sessionStartUtc, segment.timezone);
    const b = wsModel.zonedParts(segment.sessionEndUtc, segment.timezone);
    date = a.date; start = a.time; end = b.time;
    overnight = b.date !== a.date;
    tooLong = overnight && (!wsModel.isNextDay(a.date, b.date) || Date.parse(segment.sessionEndUtc) - Date.parse(segment.sessionStartUtc) > 86400000);
  }
  ws.edit = { id: sessionId || "", armed: false };
  const lastDate = ws.period === wsCurrentPeriod() ? wsDataToday() : ws.period + "-" + wsModel.pad(wsModel.daysInMonth(ws.period));
  const dateLimits = segment ? "" : ws.day.date ? " readonly" : " min='" + ws.period + "-01' max='" + lastDate + "'";
  const member = ws.day.userId ? wsMember(ws.day.userId) : null;
  $("dlgEditBody").innerHTML = wsDialogHead("dlgEditTitle", segment ? "Edit session" : "Add missing session") +
    "<p class='sub'>" + wsEsc((member ? member.name : "") + (member && ws.day.date ? " · " : "") + (ws.day.date ? wsModel.dayLabel(ws.day.date, true) : "")) + (segment ? " · currently " + wsEsc(segment.start + " – " + segment.end) : "") + "</p>" +
    (tooLong ? "<p class='ws-notice'>This session runs longer than a day, so it cannot be edited here. Remove it and add the correct time instead.</p>" : "") +
    "<form id='editForm' novalidate>" +
    "<label for='editDate'>Clock-in date</label><input id='editDate' type='date' value='" + date + "' required" + dateLimits + " />" +
    "<div class='ws-time-fields'><div><label for='editStart'>Clock-in</label><input id='editStart' type='time' value='" + start + "' required data-autofocus /></div>" +
    "<div><label for='editEnd'>Clock-out</label><input id='editEnd' type='time' value='" + end + "' required /></div></div>" +
    "<label class='ws-check'><input id='editOvernight' type='checkbox'" + (overnight ? " checked" : "") + " /> Clock-out is on the next day</label>" +
    "<p class='sub' style='margin-top:12px'>" + (segment
      ? "Saving replaces this session with the times above and marks it as edited. The original desktop recording will not come back on the next sync."
      : "The new session is marked as added in the dashboard.") + " Times are in " + wsEsc(segment ? segment.timezone : "the timezone recorded for this day") + ".</p>" +
    "<div id='editMsg' class='ws-feedback' role='alert'></div>" +
    "<div class='ws-actions-row" + (segment ? " split" : "") + "'>" + (segment ? "<button type='button' class='danger' data-action='remove-session' data-edit-control>Remove session</button>" : "") +
    "<div style='display:flex;gap:10px'><button type='button' data-close>Cancel</button><button type='submit' class='primary' data-edit-control" + (tooLong ? " data-blocked='1'" : "") + ">" + (segment ? "Save session" : "Add session") + "</button></div></div></form>";
  ws.messageTarget = "editMsg";
  $("editForm").addEventListener("submit", wsSubmitEdit);
  wsOpenDialog("dlgEdit", opener);
  wsSyncBusy();
}
function wsActiveView() { return ws.day && ws.day.userId ? memberView : personalView; }
async function wsSubmitEdit(event) {
  event.preventDefault();
  const date = $("editDate").value, start = $("editStart").value, end = $("editEnd").value;
  const overnight = $("editOvernight").checked;
  if (!date || !start || !end) { wsFeedback("editMsg", "Enter a date, clock-in and clock-out."); return; }
  if (!overnight && end <= start) { wsFeedback("editMsg", "Clock-out must be after clock-in. For a session that ends after midnight, tick the next-day box."); return; }
  if (overnight && end >= start) { wsFeedback("editMsg", "A session can be at most 24 hours long."); return; }
  const body = { date, start, end, overnight };
  const editing = ws.edit && ws.edit.id;
  if (editing) body.id = ws.edit.id;
  wsFeedback("editMsg", "Saving…", "ok");
  const saved = await wsActiveView().edit(editing ? "PATCH" : "POST", body);
  if (saved) { wsCloseDialog("dlgEdit"); wsAfterEdit(); }
}
async function wsRemoveSession(button) {
  if (!ws.edit || !ws.edit.id) return;
  if (!ws.edit.armed) {
    ws.edit.armed = true; button.textContent = "Confirm removal";
    wsFeedback("editMsg", "This removes the session from the timesheet. Select Confirm removal to continue.", "err");
    return;
  }
  const removed = await wsActiveView().edit("DELETE", { id: ws.edit.id });
  if (removed) { wsCloseDialog("dlgEdit"); wsAfterEdit(); }
}
function wsAfterEdit() {
  if (ws.day) wsFeedback("dayMsg", "Saved.", "ok");
  if (wsIsTeam()) wsLoadOverview(true);
}

// ---- send ----
async function wsLoadRecipients(teamEndpoint) {
  const response = await api(teamEndpoint ? "/api/team/settings?organizationId=" + encodeURIComponent(orgId) : "/api/settings");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not load recipients.");
  return data.recipients && data.recipients.length ? data.recipients : (data.defaultRecipients || []);
}
function wsOpenSendAll(opener) {
  if (!ws.overview) return;
  ws.send = { selected: new Set(wsMembers().map((m) => m.id)), recipients: null, error: "", done: false, period: ws.period };
  wsRenderSendAll();
  wsOpenDialog("dlgSend", opener);
  wsLoadRecipients(true).then((list) => { ws.send.recipients = list; wsUpdateSend(); }).catch((error) => { ws.send.error = error.message; wsUpdateSend(); });
}
function wsRenderSendAll() {
  const members = wsMembers();
  const reference = wsModel.median(members.filter((m) => m.stats.recordedDays > 0).map((m) => m.stats.recordedDays));
  $("dlgSendBody").innerHTML = wsDialogHead("dlgSendTitle", "Review team timesheets") + wsPeriodNotice() +
    "<form id='sendForm'><div class='ws-recipients'><span>Recipients</span><strong id='sendRecipients'>Loading…</strong><button type='button' class='text-button' data-action='settings-delivery'>Change in Settings</button></div>" +
    "<div class='ws-select-head'><label class='ws-check' style='margin:0 !important'><input id='sendAll' type='checkbox' checked /> Select all members</label><span id='sendCount'></span></div>" +
    "<div class='ws-send-list'>" + members.map((m) => {
      const facts = wsModel.sendFacts(m, reference == null ? null : Math.round(reference));
      return "<label class='ws-send-member'><input type='checkbox' data-send-member='" + wsEsc(m.id) + "' checked /><span><strong>" + wsEsc(m.name) + "</strong><small>" + m.stats.recordedDays + " recorded day" + (m.stats.recordedDays === 1 ? "" : "s") + "</small>" +
        facts.map((f) => "<small class='fact'>" + wsEsc(f) + "</small>").join("") + "</span><span class='mono'>" + wsModel.duration(m.stats.workedMinutes) + "</span></label>";
    }).join("") + "</div>" +
    "<div class='ws-send-total'><span>Selected worked time</span><strong id='sendTotal'></strong></div>" +
    "<p class='sub' style='margin-top:12px'>One timesheet per selected member, emailed to the recipients above. Everyone on the team is listed, whatever your search. Pending invitations are not included.</p>" +
    "<div id='sendMsg' class='ws-feedback' role='status'></div><div id='sendResults' class='ws-results'></div>" +
    "<div class='ws-send-footer'><div class='ws-actions-row'><button type='button' data-close>Cancel</button><button type='submit' id='sendConfirm' class='primary'></button></div></div></form>";
  $("sendForm").addEventListener("submit", wsSubmitSendAll);
  $("sendAll").addEventListener("change", (event) => {
    ws.send.selected = event.target.checked ? new Set(wsMembers().map((m) => m.id)) : new Set();
    document.querySelectorAll("[data-send-member]").forEach((box) => { box.checked = event.target.checked; });
    wsUpdateSend();
  });
  document.querySelectorAll("[data-send-member]").forEach((box) => box.addEventListener("change", () => {
    if (box.checked) ws.send.selected.add(box.dataset.sendMember); else ws.send.selected.delete(box.dataset.sendMember);
    wsUpdateSend();
  }));
  wsUpdateSend();
}
function wsUpdateSend() {
  if (!ws.send || !$("sendConfirm")) return;
  const total = wsMembers().length;
  const size = ws.send.selected.size;
  $("sendCount").textContent = size + " of " + total + " selected";
  $("sendTotal").textContent = wsModel.duration(wsMembers().filter((m) => ws.send.selected.has(m.id)).reduce((sum, m) => sum + m.stats.workedMinutes, 0));
  const all = $("sendAll");
  all.checked = size === total && total > 0;
  all.indeterminate = size > 0 && size < total;
  $("sendRecipients").textContent = ws.send.error ? ws.send.error : ws.send.recipients ? (ws.send.recipients.join(", ") || "None set") : "Loading…";
  const button = $("sendConfirm");
  button.textContent = ws.send.done ? "Sent" : "Send " + size + " timesheet" + (size === 1 ? "" : "s");
  button.disabled = ws.send.done || ws.send.sending || size === 0 || !ws.send.recipients || ws.send.recipients.length === 0;
}
async function wsSubmitSendAll(event) {
  event.preventDefault();
  if (!ws.send || ws.send.sending || ws.send.selected.size === 0) return;
  const userIds = wsMembers().filter((m) => ws.send.selected.has(m.id)).map((m) => m.id);
  ws.send.sending = true; wsUpdateSend();
  wsFeedback("sendMsg", "Sending " + userIds.length + " timesheet" + (userIds.length === 1 ? "" : "s") + "…", "ok");
  $("sendResults").textContent = "";
  try {
    const response = await api("/api/team/send?organizationId=" + encodeURIComponent(orgId), { method: "POST", body: JSON.stringify({ period: ws.send.period, userIds }) });
    const data = await response.json().catch(() => ({}));
    if (!data.results) throw new Error(data.error || "Could not send timesheets.");
    const failed = data.results.filter((r) => !r.ok);
    ws.send.done = failed.length === 0;
    wsFeedback("sendMsg", (data.sent || 0) + " of " + data.results.length + " timesheets for " + wsModel.monthLabel(data.period) + " sent to " + data.recipients.join(", ") + ".", failed.length ? "err" : "ok");
    if (failed.length) {
      $("sendResults").textContent = "Not sent: " + failed.map((r) => { const m = wsMember(r.userId); return (m ? m.name : r.userId) + " (" + r.error + ")"; }).join(", ") + ". Select only these people to try again.";
      ws.send.selected = new Set(failed.map((r) => r.userId));
      document.querySelectorAll("[data-send-member]").forEach((box) => { box.checked = ws.send.selected.has(box.dataset.sendMember); });
    }
  } catch (error) {
    wsFeedback("sendMsg", error.message || "Could not send timesheets.");
  } finally {
    ws.send.sending = false; wsUpdateSend();
  }
}
function wsOpenPersonalSend(opener) {
  if (!ws.personal) return;
  ws.send = { period: ws.period, sending: false, done: false };
  $("dlgSendBody").innerHTML = wsDialogHead("dlgSendTitle", "Send your timesheet") + wsPeriodNotice() +
    "<div class='ws-day-summary'><div>Worked time<strong>" + wsModel.duration(ws.personal.totalMinutes) + "</strong></div><div>Recorded days<strong>" + ws.personal.activeDays + "</strong></div></div>" +
    "<form id='personalSendForm'><div class='ws-recipients'><span>Recipients</span><strong id='sendRecipients'>Loading…</strong><button type='button' class='text-button' data-action='settings-delivery'>Change in Settings</button></div>" +
    "<p class='sub'>The email includes a day-by-day CSV of " + wsEsc(wsModel.monthLabel(ws.period)) + ".</p>" +
    "<div id='sendMsg' class='ws-feedback' role='status'></div>" +
    "<div class='ws-actions-row split'><button type='button' data-action='preview' data-user=''>Preview CSV</button><div style='display:flex;gap:10px'><button type='button' data-close>Cancel</button><button type='submit' id='personalSendConfirm' class='primary' disabled>Send timesheet</button></div></div></form>";
  $("personalSendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("personalSendConfirm");
    button.disabled = true;
    wsFeedback("sendMsg", "Sending…", "ok");
    try {
      const response = await api("/api/send?period=" + ws.send.period, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Send failed.");
      wsFeedback("sendMsg", "Sent " + wsModel.monthLabel(data.period) + " to " + data.recipients + " recipient" + (data.recipients === 1 ? "" : "s") + ".", "ok");
      button.textContent = "Sent";
    } catch (error) {
      wsFeedback("sendMsg", error.message || "Send failed.");
      button.disabled = false;
    }
  });
  wsOpenDialog("dlgSend", opener);
  wsLoadRecipients(emailMode === "manager").then((list) => {
    $("sendRecipients").textContent = list.join(", ") || "None set";
    $("personalSendConfirm").disabled = list.length === 0;
  }).catch((error) => { $("sendRecipients").textContent = error.message; });
}

// ---- CSV preview ----
async function wsOpenPreview(userId, opener) {
  const member = userId ? wsMember(userId) : null;
  const title = "Preview · " + (member ? member.name + " · " : "") + wsModel.monthLabel(ws.period);
  $("dlgPreviewBody").innerHTML = wsDialogHead("dlgPreviewTitle", title) + "<p class='sub' role='status'>Loading…</p>";
  wsOpenDialog("dlgPreview", opener);
  const url = userId
    ? "/api/team/preview?organizationId=" + encodeURIComponent(orgId) + "&userId=" + encodeURIComponent(userId) + "&period=" + ws.period
    : "/preview?period=" + ws.period;
  let html;
  try {
    const response = await api(url);
    if (!response.ok) throw new Error();
    const text = (await response.text()).trim();
    if (!text) html = "<p class='sub'>No sessions recorded for this month.</p>";
    else {
      const rows = text.split(String.fromCharCode(10)).map(pvParseLine);
      const head = rows[0];
      html = "<div class='pv-scroll'><table class='pv'><thead><tr>" + head.map((h) => "<th>" + wsEsc(h) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.slice(1).filter((cells) => cells.join("") !== "").map((cells) => "<tr" + (cells.indexOf("Total") !== -1 ? " class='pv-total'" : cells.indexOf("Vacation") !== -1 ? " class='pv-vac'" : "") + ">" +
          head.map((_, i) => "<td>" + wsEsc(cells[i] || "") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    }
  } catch { html = "<p class='ws-feedback err'>Could not load the preview.</p>"; }
  if ($("dlgPreview").open) $("dlgPreviewBody").innerHTML = wsDialogHead("dlgPreviewTitle", title) + html;
}

// ---- settings ----
function wsShow(id, visible) { $(id).classList.toggle("hidden", !visible); }
let settingsScope = "personal";
function wsInvalidateSettings() {
  emailSettingsContext = null; ++emailLoadVersion; ++hoursLoadVersion; ++inactivityLoadVersion;
  $("saveEmail").disabled = true; $("saveWorkingHours").disabled = true; $("saveInactivity").disabled = true;
}
function wsSelectSettings(scope) {
  wsInvalidateSettings();
  const canManage = wsIsTeam() && isManagerRoleC(orgRole);
  const team = scope === "team" && canManage;
  settingsScope = team ? "team" : "personal";
  $("settingsTeamTab").hidden = !canManage; wsShow("settingsTeamTab", canManage);
  for (const name of ["Personal", "Team"]) {
    const selected = name === (team ? "Team" : "Personal");
    $("settings" + name + "Tab").setAttribute("aria-selected", String(selected));
    $("settings" + name + "Tab").tabIndex = selected ? 0 : -1;
    $("settings" + name + "Panel").hidden = !selected;
  }
  for (const id of ["setMyHours", "setDesktop", "setPrivacy", "setTeamCreate", "setOperator"]) $("settingsPersonalPanel").appendChild($(id));
  for (const id of ["setWorkingHours", "setInactivity", "setPlan"]) $("settingsTeamPanel").appendChild($(id));
  $(team ? "teamDeliverySlot" : "personalDeliverySlot").appendChild($("setDelivery"));
  $("emailTitle").textContent = "Timesheet delivery";
  $("emailMsg").textContent = "";
  wsShow("emailEdit", false); wsShow("emailReadonly", true);
  $("emailReadonly").textContent = "Loading delivery settings...";
  wsShow("setWorkingHours", canManage); wsShow("setInactivity", canManage); wsShow("setPlan", canManage);
  const ownsSingle = ws.mode === "personal" && orgPlanKey === "single" && !!orgId && isManagerRoleC(orgRole);
  wsShow("setTeamCreate", ws.mode === "personal" && (ws.me.operator || ownsSingle));
  wsShow("setOperator", !!ws.me.operator);
  if (team) {
    $("planSummary").textContent = (orgPlanKey === "enterprise" ? "Enterprise" : "Team") + " \u00b7 " + memberCount + (orgCap >= 1000000 ? "" : " of " + orgCap) + " member seats used";
    $("teamHoursSlot").appendChild($("workingHoursEditor"));
    $("hoursTargetField").classList.add("hidden"); $("hoursTarget").value = "";
    loadWorkingHoursEditor(); loadInactivityEditor();
  } else loadWorkingHoursSummary();
  loadEmailSettings(team || ownsSingle ? { kind: "team", path: "/api/team/settings?organizationId=" + encodeURIComponent(orgId) } : { kind: "personal", path: "/api/settings" });
}
$("settingsPersonalTab").onclick = () => wsSelectSettings("personal");
$("settingsTeamTab").onclick = () => wsSelectSettings("team");
$("dlgSettings").querySelector("[role=tablist]").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  wsSelectSettings(event.key === "Home" ? "personal" : event.key === "End" ? "team" : settingsScope === "personal" ? "team" : "personal");
  $(settingsScope === "team" ? "settingsTeamTab" : "settingsPersonalTab").focus();
});
for (const id of ["dlgSettings", "dlgMember"]) $(id).addEventListener("close", wsInvalidateSettings);
function wsOpenSettings(opener, section) {
  $("dlgSettingsTitle").textContent = "Settings";
  wsSelectSettings(section === "setDelivery" && wsIsTeam() ? "team" : "personal");
  loadToken();
  if (section) $(section).open = true;
  wsOpenDialog("dlgSettings", opener);
  if (section) { $(section).scrollIntoView({ block: "nearest" }); $(section).querySelector("summary").focus({ preventScroll: true }); }
}
new MutationObserver(() => { if ($("inactivityMsg").classList.contains("ok")) wsLoadPolicy(); })
  .observe($("inactivityMsg"), { attributes: true, attributeFilter: ["class"] });

function wsOpenMemberSettings(id, opener) {
  const m = wsMember(id);
  if (!m || !wsIsTeam() || !isManagerRoleC(orgRole)) return;
  wsInvalidateSettings();
  ws.settingsMember = id;
  $("dlgMemberTitle").textContent = m.name;
  $("memberSettingsSub").textContent = m.email + " · " + (wsRoleTag(m.role) || "Worker");
  const target = $("hoursTarget");
  if (!Array.from(target.options).some((o) => o.value === id)) target.add(new Option(m.name, id));
  target.value = id;
  $("hoursTargetField").classList.add("hidden");
  $("memberHoursSlot").appendChild($("workingHoursEditor"));
  loadWorkingHoursEditor();
  const self = m.id === ws.me.user.id;
  $("memberRemoveSection").classList.toggle("hidden", self);
  $("memberRemoveSection").open = false;
  $("memberRemove").textContent = "Remove from team";
  $("memberRemove").dataset.armed = "";
  wsFeedback("memberRemoveMsg", "");
  wsOpenDialog("dlgMember", opener);
}
$("memberRemove").addEventListener("click", async () => {
  const m = wsMember(ws.settingsMember);
  if (!m) return;
  const button = $("memberRemove");
  if (!button.dataset.armed) { button.dataset.armed = "1"; button.textContent = "Confirm removal of " + m.name; return; }
  button.disabled = true;
  try {
    const response = await api("/api/auth/organization/remove-member", { method: "POST", body: JSON.stringify({ memberIdOrEmail: m.email, organizationId: orgId }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || "Could not remove member.");
    ws.expanded.delete(m.id);
    wsCloseDialog("dlgMember");
    if ($("dlgSheet").open && ws.sheetId === m.id) wsCloseDialog("dlgSheet");
    wsLoadOverview(true);
  } catch (error) {
    wsFeedback("memberRemoveMsg", error.message);
  } finally { button.disabled = false; }
});

// ---- invitations ----
function wsOpenInvite(opener) {
  $("inviteForm").reset();
  $("inviteLinkBox").classList.add("hidden");
  const full = orgCap < 1000000 && memberCount >= orgCap;
  $("inviteBtn").disabled = full;
  wsFeedback("inviteMsg", full ? "Your team is full (" + memberCount + " of " + orgCap + " seats)." : "", "err");
  wsRenderPending();
  wsOpenDialog("dlgInvite", opener);
  wsLoadPending();
}
function wsRenderPending() {
  const box = $("pendingInvites");
  if (ws.pending === null) { box.innerHTML = "<p class='sub'>Could not load pending invitations.</p>"; return; }
  if (!ws.pending.length) { box.innerHTML = "<p class='sub'>No pending invitations.</p>"; return; }
  box.innerHTML = ws.pending.map((inv) => "<div class='ws-invite-row'><div><span>" + wsEsc(inv.email) + "</span><small>" + (String(inv.role || "").includes("admin") ? "Manager" : "Worker") +
    (inv.expiresAt ? " · expires " + wsEsc(new Date(inv.expiresAt).toLocaleDateString()) : "") + "</small></div>" +
    "<button type='button' class='text-button' data-action='cancel-invite' data-id='" + wsEsc(inv.id) + "'>Cancel</button></div>").join("");
}
$("inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("inviteEmail").value.trim();
  $("inviteLinkBox").classList.add("hidden");
  if (!email || !$("inviteEmail").checkValidity()) { wsFeedback("inviteMsg", "Enter a valid email to invite."); return; }
  $("inviteBtn").disabled = true;
  try {
    const response = await api("/api/auth/organization/invite-member", { method: "POST", body: JSON.stringify({ email, role: $("inviteRole").value, organizationId: orgId }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || "Could not create invite.");
    const id = data.id || (data.invitation && data.invitation.id) || "";
    if (id) {
      $("inviteLink").value = location.origin + "/?invitation=" + id;
      $("inviteLinkBox").classList.remove("hidden");
      wsFeedback("inviteMsg", "Invitation ready. Send this private link to " + email + " so they can join your team.", "ok");
    } else wsFeedback("inviteMsg", "Invitation sent to " + email + ".", "ok");
    $("inviteEmail").value = "";
    wsLoadPending();
  } catch (error) {
    wsFeedback("inviteMsg", error.message || "Could not create invite.");
  } finally { $("inviteBtn").disabled = orgCap < 1000000 && memberCount >= orgCap; }
});
$("copyInvite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("inviteLink").value); wsFeedback("inviteMsg", "Invite link copied. Only share it with the person you invited.", "ok"); }
  catch { $("inviteLink").select(); }
});
async function wsCancelInvite(id, button) {
  button.disabled = true;
  try {
    const response = await api("/api/auth/organization/cancel-invitation", { method: "POST", body: JSON.stringify({ invitationId: id }) });
    if (!response.ok) throw new Error();
  } catch { wsFeedback("inviteMsg", "Could not cancel that invitation."); button.disabled = false; return; }
  wsLoadPending();
}

$("teamCreateBtn").onclick = async () => {
  const name = ($("teamCreateName").value || "").trim();
  $("teamCreateMsg").textContent = ""; $("teamCreateMsg").className = "msg";
  $("teamCreateBtn").disabled = true;
  try {
    const response = await api("/api/team/create", { method: "POST", body: JSON.stringify({ name }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not create team.");
    $("teamCreateName").value = "";
    wsCloseDialog("dlgSettings");
    const me = await fetchMe();
    if (me) await startWorkspace(me);
  } catch (error) {
    $("teamCreateMsg").textContent = error.message; $("teamCreateMsg").className = "msg err";
  } finally { $("teamCreateBtn").disabled = false; }
};

// ---- account ----
function wsOpenAccount(opener) {
  const org = wsIsTeam() || ws.mode === "worker" ? orgName + " · " + (wsIsTeam() ? (orgRole.includes("owner") ? "Owner" : "Manager") : "Worker") : "Personal account";
  $("dlgAccountBody").innerHTML = wsDialogHead("dlgAccountTitle", "Your account") +
    "<p class='sub'>" + wsEsc(ws.me.user.email) + "</p><div class='ws-plan'><span>" + wsEsc(org) + "</span></div>" +
    "<div class='ws-actions-row'><button type='button' data-close>Close</button><button type='button' class='primary' data-action='signout'>Sign out</button></div>";
  wsOpenDialog("dlgAccount", opener);
}

// ---- events ----
$("workspace").addEventListener("click", (event) => {
  const el = event.target.closest("[data-action], [data-page]");
  if (!el || !$("workspace").contains(el)) return;
  if (el.dataset.page) {
    if (ws.page !== el.dataset.page) { ws.page = el.dataset.page; wsSyncUrl(); wsRender(); }
    return;
  }
  const action = el.dataset.action;
  if (action === "toggle-member") {
    if (ws.expanded.has(el.dataset.id)) ws.expanded.delete(el.dataset.id); else ws.expanded.add(el.dataset.id);
    wsRenderRoster();
    const again = document.querySelector("#wsRosterBody [data-key='member:" + el.dataset.id + "']");
    if (again && el.classList.contains("ws-member")) again.focus({ preventScroll: true });
  } else if (action === "toggle-all") {
    const all = wsMembers().every((m) => ws.expanded.has(m.id));
    if (all) ws.expanded.clear();
    else { ws.query = ""; const search = document.querySelector("[data-role='search']"); if (search) search.value = ""; ws.expanded = new Set(wsMembers().map((m) => m.id)); }
    wsRenderRoster();
  } else if (action === "send-all") wsOpenSendAll(el);
  else if (action === "personal-send") wsOpenPersonalSend(el);
  else if (action === "invite") wsOpenInvite(el);
  else if (action === "cancel-invite") wsCancelInvite(el.dataset.id, el);
  else if (action === "open-day") wsOpenDay(el.dataset.user, el.dataset.date, el);
  else if (action === "open-sheet") wsOpenSheet(el.dataset.id, el);
  else if (action === "member-settings") wsOpenMemberSettings(el.dataset.id, el);
  else if (action === "preview") wsOpenPreview(el.dataset.user, el);
  else if (action === "edit-session") wsOpenEdit(el.dataset.id, el);
  else if (action === "add-session") wsOpenEdit("", el);
  else if (action === "add-day") wsOpenAddDay(el.dataset.user, el);
  else if (action === "remove-session") wsRemoveSession(el);
  else if (action === "settings-delivery") wsOpenSettings(el, "setDelivery");
  else if (action === "reload") wsLoadPage();
  else if (action === "signout") $("signout").click();
});
$("wsMain").addEventListener("change", (event) => {
  const role = event.target.dataset.role;
  if (role === "month") {
    ws.period = event.target.value;
    ws.expanded.clear();
    ws.memberData = null; ws.memberKey = "";
    wsSyncUrl();
    wsLoadPage();
  } else if (role === "scope") { ws.scope = event.target.value; wsRender(); }
  else if (role === "sort") { ws.sort = event.target.value; wsRender(); }
});
$("wsMain").addEventListener("input", (event) => {
  if (event.target.dataset.role === "search") { ws.query = event.target.value; wsRenderRoster(); }
});
$("wsSettings").onclick = (event) => wsOpenSettings(event.currentTarget);
$("wsAccount").onclick = (event) => wsOpenAccount(event.currentTarget);

/** Show the workspace for this account. Called after sign-in passes the access gates. */
async function startWorkspace(me) {
  ws.me = me;
  meEmail = (me.user && me.user.email) || "";
  orgId = ""; orgName = ""; orgRole = ""; orgPlanKey = ""; orgCap = 0; memberCount = 0;
  const membership = wsPrimaryMembership(me.orgs || []);
  if (membership) {
    orgId = membership.organizationId; orgName = membership.name || ""; orgRole = membership.role || ""; orgPlanKey = membership.plan || "";
    orgCap = membership.cap || 0; memberCount = membership.memberCount || 1;
    if (isManagerRoleC(orgRole)) {
      ws.mode = orgPlanKey === "single" ? "personal" : "team";
      emailMode = "manager"; canEditTimes = true;
    } else {
      ws.mode = "worker"; emailMode = "member"; canEditTimes = false;
    }
  } else {
    ws.mode = "personal"; emailMode = "solo"; canEditTimes = true;
  }
  const params = new URLSearchParams(location.search);
  const t = wsToday();
  const month = params.get("month");
  ws.period = month && /^\d{4}-\d{2}$/.test(month) && month <= wsCurrentPeriod() ? month : wsModel.lastCompleteMonth(t);
  ws.page = params.get("view") === "stats" ? "stats" : "timesheets";
  ws.query = ""; ws.expanded = new Set(); ws.scope = "all"; ws.overview = null; ws.personal = null;
  ws.pending = []; ws.policy = undefined; ws.memberData = null; ws.memberKey = "";
  personalView.clear(true); memberView.clear(true);
  $("wsName").textContent = ws.mode === "personal" ? "Personal account" : orgName;
  $("wsSettings").setAttribute("aria-label", "Settings");
  $("settingsTeamTab").hidden = !(wsIsTeam() && isManagerRoleC(orgRole));
  wsShow("settingsTeamTab", !$("settingsTeamTab").hidden);
  $("wsAccount").textContent = wsModel.initials(meEmail);
  // The operator invitation form lives in Settings rather than above the workspace.
  const operatorCard = $("operatorInvites");
  if (operatorCard) {
    if (operatorCard.parentNode !== $("operatorSlot")) $("operatorSlot").appendChild(operatorCard);
    operatorCard.classList.toggle("hidden", !me.operator);
  }
  $("workspace").classList.remove("hidden");
  wsSyncUrl();
  wsRender();
  if (wsIsTeam()) { wsLoadPending(); wsLoadPolicy(); }
  await wsLoadPage();
}
`;
