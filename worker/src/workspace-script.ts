import { createWorkspaceModel } from "./workspace-model.js";
import { selectPrimaryMembership } from "./memberships.js";

// Inline client for the signed-in workspace. It shares the dashboard script's scope
// (api, $, createTimesheetView, the org globals and the retained settings handlers).
// Written as plain string-built JS like the rest of the dashboard: no backticks.
export const WORKSPACE_SCRIPT = "const wsModel = (" + createWorkspaceModel.toString() + ")();\n" +
  "const wsPrimaryMembership = (" + selectPrimaryMembership.toString() + ");\n" + String.raw`
const ws = {
  version: 0,
  closedWeeks: new Set(), window: null, suppressClick: false, year: 0, annual: null, annualError: "", annualVersion: 0, annualLoading: false, annualKey: "",
  me: null, mode: "personal", page: "timesheets", period: "", query: "", expanded: new Set(),
  scope: "all", sort: "average", overview: null, overviewError: "", overviewVersion: 0,
  personal: null, personalError: "", memberData: null, memberKey: "", pending: null, policy: undefined,
  day: null, edit: null, send: null, busy: false, messageTarget: "", sheetId: "", sheetDay: "", settingsMember: ""
};
const wsEsc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wsArrow = "<svg class='icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' aria-hidden='true'><path d='m9 5 7 7-7 7'/></svg>";
const BREAK_NOTE = "Breaks are gaps of 2 minutes or more between recorded sessions on the same day. Overnight time is excluded. A gap shows how recording stopped, not why someone was away.";

function wsToday() { const now = new Date(); return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }; }
function wsCurrentPeriod() { const t = wsToday(); return wsModel.period(t.y, t.m); }
function wsIsTeam() { return ws.mode === "team"; }
function wsCanEdit() { return ws.mode !== "worker"; }
function wsMembers() { return ws.page === "stats" && ws.annual && wsIsTeam() ? ws.annual.members : ws.overview ? ws.overview.members : []; }
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
    if (dialog.id === "dlgSheet") { ws.sheetId = ""; ws.sheetDay = ""; }
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
  if (ws.page === "stats") return wsLoadYear();
  if (wsIsTeam()) return wsLoadOverview(false);
  return personalView.load({
    key: ws.me.user.id + ":" + ws.period, period: ws.period, label: ws.me.user.email,
    hoursUrl: "/api/hours?period=" + ws.period, editUrl: "/api/manual-session"
  });
}
async function wsLoadYear(force) {
  const key = ws.me.user.id + ":" + orgId + ":" + ws.year;
  if (!force && ws.annualKey === key && (ws.annual || ws.annualLoading)) return;
  const version = ++ws.annualVersion;
  const year = ws.year, team = wsIsTeam(), organization = orgId;
  ws.annualKey = key; ws.annual = null; ws.annualError = ""; ws.annualLoading = true; wsRender();
  const months = Array.from({ length: year === wsToday().y ? wsToday().m : 12 }, (_, i) => wsModel.period(year, i + 1));
  const results = [];
  let next = 0;
  try {
    const loaded = await Promise.allSettled(Array.from({ length: 3 }, async () => {
      while (next < months.length && version === ws.annualVersion) {
        const period = months[next++];
        const response = await api(team ? "/api/team/overview?organizationId=" + encodeURIComponent(organization) + "&period=" + period : "/api/hours?period=" + period);
        if (!response.ok) throw new Error("Could not load year");
        results.push(await response.json());
      }
    }));
    if (loaded.some((result) => result.status === "rejected")) throw new Error("Incomplete year");
    if (version !== ws.annualVersion) return;
    if (team) {
      const byId = new Map();
      for (const month of results) for (const member of month.members) {
        if (!byId.has(member.id)) byId.set(member.id, { ...member, days: [], enteredSessions: 0 });
        const target = byId.get(member.id);
        target.days.push(...member.days); target.enteredSessions += member.enteredSessions;
      }
      const members = Array.from(byId.values()).map((member) => ({ ...member, days: member.days.sort((a, b) => a.date.localeCompare(b.date)), stats: wsModel.statsForDays(member.days) }));
      ws.annual = { members, today: results.map((month) => month.today).sort().at(-1), overtimeMode: results[0]?.overtimeMode };
    } else {
      const days = results.flatMap((month) => month.recordedDays || []).map((day) => ({ ...day, breakCount: day.breaks.length })).sort((a, b) => a.date.localeCompare(b.date));
      ws.annual = { days };
    }
  } catch {
    if (version !== ws.annualVersion) return;
    ws.annualError = "Could not load the full year. Try again to load all months.";
  } finally {
    if (version === ws.annualVersion) { ws.annualLoading = false; wsRender(); if (ws.annual) wsRefreshSheet(); }
  }
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
  if (ws.page === "timesheets") wsRefreshSheet();
}
async function wsLoadPending() {
  const version = ws.version;
  try {
    const response = await api("/api/auth/organization/list-invitations?organizationId=" + encodeURIComponent(orgId));
    const data = await response.json();
    if (version !== ws.version) return;
    if (!response.ok) throw new Error();
    const list = Array.isArray(data) ? data : (data.invitations || []);
    ws.pending = list.filter((inv) => inv.status === "pending" && (!inv.expiresAt || new Date(inv.expiresAt) > new Date()));
  } catch { if (version !== ws.version) return; ws.pending = null; }
  if (ws.page === "timesheets") wsRenderBottom();
  wsRenderPending();
}
async function wsLoadPolicy() {
  const version = ws.version;
  try {
    const response = await api("/api/team/inactivity?organizationId=" + encodeURIComponent(orgId));
    const data = await response.json();
    if (version !== ws.version) return;
    if (!response.ok) throw new Error();
    ws.policy = data.policy || null;
  } catch { if (version !== ws.version) return; ws.policy = undefined; }
  $("inactivitySummary").textContent = ws.policy === undefined ? "Could not load the team policy"
    : ws.policy ? "Team limit: " + Math.round(ws.policy.timeout_secs / 60) + " minutes without input" : "Each computer uses its own setting";
  if (ws.page === "stats") wsRender();
}

// ---- URL state ----
function wsSyncUrl() {
  const url = new URL(location.href);
  if (wsIsTeam()) url.searchParams.set("team", orgId); else url.searchParams.delete("team");
  url.searchParams.set("view", ws.page);
  url.searchParams.set("month", ws.period);
  if (ws.page === "stats") url.searchParams.set("year", ws.year); else url.searchParams.delete("year");
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
  const oldChart = main.querySelector(".ws-year-scroll");
  const oldChartKey = oldChart ? oldChart.dataset.window : "";
  const oldChartLeft = oldChart ? oldChart.scrollLeft : 0;
  const scrollY = window.scrollY;
  const heat = main.querySelector(".ws-heat-scroll");
  const heatLeft = heat ? heat.scrollLeft : 0;
  const focusKey = document.activeElement && main.contains(document.activeElement) ? document.activeElement.dataset.key || document.activeElement.dataset.role || "" : "";
  main.innerHTML = ws.page === "stats" ? wsStatsHtml() : wsIsTeam() ? wsTeamHtml() : wsPersonalHtml();
  if (ws.page === "timesheets" && wsIsTeam() && ws.overview) wsRenderRoster();
  const nextHeat = main.querySelector(".ws-heat-scroll");
  if (nextHeat) nextHeat.scrollLeft = heatLeft;
  const chart = main.querySelector(".ws-year-scroll");
  if (chart) {
    if (oldChartKey === chart.dataset.window) chart.scrollLeft = oldChartLeft;
    else if (chart.scrollWidth > chart.clientWidth) {
      const latest = Array.from(chart.querySelectorAll("[data-minutes]")).sort((a, b) => a.dataset.date.localeCompare(b.dataset.date)).at(-1);
      if (latest) chart.scrollLeft = latest.getBoundingClientRect().right - chart.getBoundingClientRect().left + chart.scrollLeft - chart.clientWidth + 35;
    }
  }
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
    "<div id='wsRosterBody' class='ws-person-ledgers' aria-label='Team timesheets'></div><div id='wsRosterFoot' class='ws-ledger-team-total'></div>" +
    "<div class='ws-bottom' id='wsBottom'></div>";
}
function wsVisibleMembers() {
  const q = ws.query.trim().toLowerCase();
  return wsMembers().filter((m) => !q || (m.name + " " + m.email).toLowerCase().includes(q));
}
function wsRenderRoster() {
  const body = $("wsRosterBody"); if (!body) return;
  const visible = wsVisibleMembers();
  body.innerHTML = visible.length ? visible.map((m) => {
    const open = ws.expanded.has(m.id), tag = wsRoleTag(m.role);
    const byDate = new Map(m.days.map((day) => [day.date, day]));
    const pulse = Array.from({ length: wsModel.daysInMonth(ws.period) }, (_, index) => {
      const day = byDate.get(ws.period + "-" + wsModel.pad(index + 1));
      return "<i style='background:" + (day ? wsModel.WORK_SHADES[wsModel.workedLevel(day.minutes)] : "var(--border)") + "'></i>";
    }).join("");
    return "<article class='ws-person-ledger" + (open ? " open" : "") + "'><button type='button' class='ws-person-toggle' data-action='toggle-member' data-id='" + wsEsc(m.id) + "' data-key='member:" + wsEsc(m.id) + "' aria-expanded='" + open + "' aria-controls='detail-" + wsEsc(m.id) + "'><span class='ws-person-initials' aria-hidden='true'>" + wsEsc(wsModel.initials(m.name)) + "</span><span class='ws-person-name'>" + wsEsc(m.name) + "<small>" + m.stats.recordedDays + " recorded days" + (tag ? " / " + tag : "") + (m.days.some((day) => day.longBreakCount) ? " / " + m.days.reduce((sum, day) => sum + (day.longBreakCount || 0), 0) + " long breaks flagged" : "") + "</small></span><span class='ws-person-pulse' aria-hidden='true'>" + pulse + "</span><span class='ws-person-time mono'>" + wsModel.duration(m.stats.workedMinutes) + "<small>Worked hours</small></span><span class='ws-person-overtime mono'>" + wsOvertimeLabel(m.days) + "<small>Overtime</small></span>" + wsArrow + "</button>" +
      "<div id='detail-" + wsEsc(m.id) + "'" + (open ? "" : " hidden") + ">" + (open ? wsMemberDetail(m, false) : "") + "</div></article>";
  }).join("") : "<p class='ws-empty'>" + (wsMembers().length ? "No members match your search." : "No members yet. Invite someone to get started.") + "</p>";
  const total = visible.reduce((sum, m) => sum + m.stats.workedMinutes, 0);
  $("wsRosterFoot").innerHTML = visible.length ? "<span>" + (ws.query.trim() ? "Matching members" : "Team total") + "</span><span class='ws-total-hours'><span><strong class='mono'>" + wsModel.duration(total) + "</strong><small>Worked hours</small></span><span><strong class='mono'>" + wsOvertimeLabel(visible.flatMap((m) => m.days)) + "</strong><small>Overtime</small></span></span>" : "";
  const all = wsMembers().length > 0 && wsMembers().every((m) => ws.expanded.has(m.id));
  $("wsViewAll").textContent = all ? "Collapse all" : "View all timesheets"; $("wsViewAll").setAttribute("aria-pressed", String(all)); wsRenderBottom();
}
function wsRenderBottom() {
  const bottom = $("wsBottom");
  if (!bottom) return;
  const count = ws.pending ? ws.pending.length : 0;
  bottom.innerHTML = "<span>" + wsEsc(wsRecordedThrough()) + "</span>" +
    (count ? "<button type='button' class='text-button' data-action='invite' data-key='pending'>" + count + " pending invitation" + (count === 1 ? "" : "s") + " &#8599;</button>" : "");
}
function wsLedgerHtml(days, userId, sessions) {
  if (!days.length) return "<p class='ws-empty'>No sessions recorded in this period.</p>";
  const max = Math.max(480, ...days.map((day) => day.minutes));
  return "<div class='ws-ledger'>" + wsModel.weekGroups(days).map((week) => {
    const label = (date) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));
    return "<details class='ws-week' data-week='" + wsEsc(userId + ":" + week.start) + "'" + (ws.closedWeeks.has(userId + ":" + week.start) ? "" : " open") + "><summary><span>" + label(week.days[0].date) + " - " + label(week.days.at(-1).date) + "<small>" + week.days.length + " recorded days</small></span><span class='mono'>" + wsModel.duration(week.minutes) + "<span class='ws-week-chevron' aria-hidden='true'>&#8964;</span></span></summary><div class='ws-week-days'>" + week.days.map((day) => {
      const own = sessions ? sessions.filter((session) => session.date === day.date) : [];
      const marks = sessions ? own.map((session) => "<i class='ws-session-mark' style='left:" + session.startMin / 14.4 + "%;width:" + (session.endMin - session.startMin) / 14.4 + "%'></i>").join("") : "<i class='ws-session-mark' style='left:0;width:" + day.minutes / max * 100 + "%'></i>";
      const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(new Date(day.date + "T00:00:00Z"));
      const text = wsModel.dayLabel(day.date, true) + ", " + wsModel.duration(day.minutes) + " worked, " + wsModel.shortDuration(day.breakMinutes) + " breaks" + (userId ? ", " + wsOvertimeLabel([day]) + " overtime" : "") + ", " + day.start + " to " + day.end;
      return "<button type='button' class='ws-ledger-day" + (userId ? " has-overtime" : "") + "' data-action='open-day' data-user='" + wsEsc(userId) + "' data-date='" + day.date + "' data-key='day:" + wsEsc(userId) + ":" + day.date + "' aria-label='" + wsEsc(text) + "'><span class='ws-date-stamp'><small>" + weekday + "</small><b>" + Number(day.date.slice(8)) + "</b></span><span class='ws-day-rhythm'><span class='ws-day-span'>" + day.start + " <span aria-hidden='true'>&rarr;</span> " + day.end + "</span><span class='ws-session-track' aria-hidden='true'>" + marks + "</span><small>" + (sessions ? own.length + " session" + (own.length === 1 ? "" : "s") + " / " : "") + wsModel.shortDuration(day.breakMinutes) + " breaks" + (wsTimeAccounting([day]) ? " / " + wsEsc(wsTimeAccounting([day])) : "") + "</small></span><span class='ws-day-amount mono'>" + wsModel.duration(day.minutes) + "<small>" + (userId ? "Worked hours" : "View day &#8599;") + "</small></span>" + (userId ? "<span class='ws-day-overtime mono'>" + wsOvertimeLabel([day]) + "<small>Overtime</small></span>" : "") + "</button>";
    }).join("") + "</div></details>";
  }).join("") + "</div>";
}
function wsTimeAccounting(days) {
  const lunch = days.reduce((sum, day) => sum + (day.paidLunchMinutes || 0), 0);
  const overtime = days.reduce((sum, day) => sum + (day.overtimeMinutes || 0), 0);
  const flags = days.reduce((sum, day) => sum + (day.longBreakCount || 0), 0);
  const accounting = days.some((day) => day.paidLunchMinutes !== undefined);
  return (accounting ? wsModel.shortDuration(lunch) + " paid lunch / " + wsModel.shortDuration(overtime) + " overtime" : "") +
    (flags ? (accounting ? " / " : "") + flags + " long break" + (flags === 1 ? "" : "s") + " flagged" : "");
}
function wsOvertimeLabel(days) {
  const report = ws.page === "stats" ? ws.annual : ws.overview;
  const enabled = report && ["daily", "weekly"].includes(report.overtimeMode);
  return enabled ? wsModel.duration(days.reduce((sum, day) => sum + (day.overtimeMinutes || 0), 0)) : "Off";
}
function wsMemberDetail(m, inSheet) {
  const days = ws.page === "stats" ? wsWindowDays(m.days) : m.days;
  return "<section class='ws-member-ledger' aria-label='" + wsEsc(m.name) + " recorded days'>" +
    (wsTimeAccounting(days) ? "<p class='ws-note'>" + wsEsc(wsTimeAccounting(days)) + ". Select a day to review.</p>" : "") + wsLedgerHtml(days, m.id, null) + (ws.page === "stats" ? "" :
      "<div class='ws-detail-actions'><button type='button' class='text-button' data-action='member-settings' data-id='" + wsEsc(m.id) + "'>Member settings</button><button type='button' class='text-button' data-action='add-day' data-user='" + wsEsc(m.id) + "'>+ Add time</button>" + (days.length ? "<button type='button' class='text-button' data-action='preview' data-user='" + wsEsc(m.id) + "'>Preview CSV</button>" : "") + "</div>") + "</section>";
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
  const table = "<div class='ws-month-summary'><div><small>" + wsEsc(wsModel.monthLabel(ws.period)) + "</small><strong class='mono'>" + wsModel.duration(data.totalMinutes) + "</strong></div><p>" + days.length + " recorded days <span aria-hidden='true'>/</span> " + wsModel.duration(breaks) + " breaks<small>Session bars follow a 24-hour clock.</small></p></div>" + wsLedgerHtml(days, "", data.sessions || []);
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
function wsWindowDays(days) { return ws.window ? days.filter((day) => day.date >= ws.window.start && day.date <= ws.window.end) : days; }
function wsStatsMembers() { return ws.annual.members.map((member) => { const days = wsWindowDays(member.days); return { ...member, days, stats: wsModel.statsForDays(days) }; }); }
function wsWindowLabel() { return ws.window ? wsModel.dayLabel(ws.window.start) + " to " + wsModel.dayLabel(ws.window.end) : String(ws.year); }
function wsSetWindow(start, end) {
  const first = start < end ? start : end, last = start < end ? end : start;
  if (first.slice(0, 4) !== String(ws.year) || last.slice(0, 4) !== String(ws.year)) return;
  ws.window = { start: first, end: last }; wsRender();
}
new ResizeObserver(() => {
  const chart = $("wsMain").querySelector(".ws-year-scroll");
  if (!chart) return;
  const previous = Number(chart.dataset.width || chart.scrollWidth);
  if (previous >= chart.scrollWidth && chart.clientWidth < chart.scrollWidth) {
    const latest = Array.from(chart.querySelectorAll("[data-minutes]")).sort((a, b) => a.dataset.date.localeCompare(b.dataset.date)).at(-1);
    if (latest) chart.scrollLeft = latest.getBoundingClientRect().right - chart.getBoundingClientRect().left + chart.scrollLeft - chart.clientWidth + 35;
  }
  chart.dataset.width = chart.clientWidth;
}).observe($("wsMain"));
function wsZoomControls() {
  const start = ws.window ? ws.window.start : ws.year + "-01-01", end = ws.window ? ws.window.end : ws.year + "-12-31";
  return "<div class='ws-zoom'><div class='ws-zoom-presets'><button type='button' data-action='zoom-preset' data-days='30'>Last 30 days</button><button type='button' data-action='zoom-preset' data-days='90'>Last 90 days</button>" + (ws.window ? "<button type='button' data-action='zoom-reset'>Reset to year</button>" : "") + "</div><div class='ws-zoom-dates'><label>From<input id='wsZoomStart' type='date' value='" + start + "' min='" + ws.year + "-01-01' max='" + ws.year + "-12-31' required></label><label>To<input id='wsZoomEnd' type='date' value='" + end + "' min='" + ws.year + "-01-01' max='" + ws.year + "-12-31' required></label><button type='button' data-action='zoom-apply'>Zoom</button></div></div>";
}

function wsStatsHtml() {
  const team = wsIsTeam();
  const head = "<div class='ws-title'><div><h1>" + (team ? "Team stats" : "My stats") + "</h1><p>A year of recorded worked time and breaks.</p></div></div>";
  let scope = "";
  if (team && ws.annual) {
    if (ws.scope !== "all" && !wsMember(ws.scope)) ws.scope = "all";
    scope = "<select data-role='scope' aria-label='Stats for'><option value='all'>All " + wsMembers().length + " members</option>" + wsMembers().map((m) => "<option value='" + wsEsc(m.id) + "'" + (ws.scope === m.id ? " selected" : "") + ">" + wsEsc(m.name) + "</option>").join("") + "</select>";
  }
  const years = Array.from({ length: 5 }, (_, i) => wsToday().y - i);
  if (!years.includes(ws.year)) years.push(ws.year);
  const nav = "<nav class='ws-years' aria-label='Activity year'>" + years.map((year) => "<button type='button' data-action='year' data-year='" + year + "'" + (year === ws.year ? " aria-current='date'" : "") + ">" + year + "</button>").join("") + "</nav>";
  let content;
  if (!ws.annual) content = wsState("Loading " + ws.year + " activity ", ws.annualError, "reload-year");
  else {
    const all = team && ws.scope === "all";
    const member = team && !all ? wsMember(ws.scope) : null;
    const days = wsWindowDays(all ? ws.annual.members.flatMap((m) => m.days) : member ? member.days : ws.annual.days);
    const stats = wsModel.statsForDays(days);
    content = wsZoomControls() + wsWorkedCalendarHtml(days, all ? null : member ? member.id : "") + wsMetrics(stats, all, member ? member.name : "") + (all ? wsComparisonHtml() : "");
  }
  return head + (scope ? "<div class='ws-stats-filters'>" + scope + "</div>" : "") + "<div class='ws-year-layout'><div class='ws-year-content'>" + content + "</div>" + nav + "</div>";
}
function wsComparisonHtml() {
  const members = wsStatsMembers();
  const rows = wsModel.sortMembers(members, ws.sort);
  const max = members.reduce((a, m) => Math.max(a, m.stats.avgBreakMinutes), 0);
  const recorded = members.filter((m) => m.stats.recordedDays);
  const median = { members: recorded.length, avgBreakMinutes: wsModel.median(recorded.map((m) => m.stats.avgBreakMinutes)), breaksPerDay: wsModel.median(recorded.map((m) => m.stats.breaksPerDay)) };
  const option = (value, label) => "<option value='" + value + "'" + (ws.sort === value ? " selected" : "") + ">" + label + "</option>";
  return "<section class='ws-section'><div class='ws-section-head'><h2>Breaks by member</h2>" +
    "<select data-role='sort' aria-label='Sort members'>" + option("average", "Highest daily break time") + option("breaks", "Most breaks per day") + option("name", "Name") + "</select></div>" +
    "<div class='ws-compare-scroll'><table class='ws-compare'><caption class='sr-only'>Break comparison for " + ws.year + "</caption><thead><tr><th scope='col'>Member</th><th scope='col' class='num'>Worked</th><th scope='col' class='num'>Break time</th><th scope='col' class='num'>Breaks / day</th><th scope='col' class='num'>Avg. break time / day</th></tr></thead><tbody>" +
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
function wsWorkedCalendarHtml(days, userId) {
  if (ws.window) return wsRangeChartHtml(days, userId);
  const cal = ws.window ? wsModel.yearCalendar(ws.year, ws.window.start, ws.window.end) : wsModel.yearCalendar(ws.year);
  const today = wsIsTeam() ? ws.annual.today : wsDataToday();
  const byDate = new Map();
  for (const day of days) byDate.set(day.date, (byDate.get(day.date) || 0) + day.minutes);
  const labels = ["", "Mon", "", "Wed", "", "Fri", ""];
  const months = cal.months.map((month) => "<span style='grid-column:" + (month.week + 2) + "'>" + month.label + "</span>").join("");
  let cells = "";
  for (let row = 0; row < 7; row++) {
    cells += "<span class='ws-cal-day' aria-hidden='true'>" + labels[row] + "</span>";
    for (let week = 0; week < cal.weeks; week++) {
      const date = cal.dates[week * 7 + row];
      if (!date) { cells += "<span class='ws-cal-cell outside'></span>"; continue; }
      const recorded = byDate.has(date), minutes = byDate.get(date) || 0, future = date > today;
      const text = wsModel.dayLabel(date, true) + ", " + ws.year + ": " + (future ? "not yet recorded" : recorded ? wsModel.duration(minutes) + " worked" : "no recorded sessions");
      const style = recorded ? " style='--shade:" + wsModel.WORK_SHADES[wsModel.workedLevel(minutes / (userId === null ? Math.max(1, wsMembers().length) : 1))] + "'" : "";
      const className = "ws-cal-cell" + (future ? " future" : recorded ? "" : " none");
      const attrs = " class='" + className + "'" + style + " tabindex='-1' aria-label='" + wsEsc(text) + "' title='" + wsEsc(text) + "'";
      if (future) cells += "<span role='img'" + attrs + "></span>";
      else cells += "<button type='button'" + attrs + " data-action='" + (userId === null ? "year-team-day" : "open-day") + "' data-user='" + wsEsc(userId || "") + "' data-date='" + date + "' data-key='cal:" + wsEsc(userId || "all") + ":" + date + "'" + (recorded ? " data-minutes='" + minutes + "'" : "") + "></button>";
    }
  }
  return "<section class='ws-contributions'><div class='ws-section-head'><h2>" + byDate.size + " recorded day" + (byDate.size === 1 ? "" : "s") + " in " + wsWindowLabel() + "</h2></div>" +
    "<div class='ws-contribution-frame' style='--cell-size:10px'><div class='ws-year-scroll' data-window='" + ws.year + "' tabindex='0' aria-label='Full-year activity chart, scroll horizontally on smaller screens'><div class='ws-cal-months' aria-hidden='true' style='--weeks:" + cal.weeks + "'><span></span>" + months + "</div><div class='ws-cal' tabindex='0' style='--weeks:" + cal.weeks + "' role='group' aria-label='Daily worked time in " + ws.year + "'>" + cells + "</div></div>" +
    "<div class='ws-chart-footer'><span>" + (userId === null ? "Intensity: worked time per team member" : "Select a day to review sessions") + ". Drag across days to zoom." + "</span><div class='ws-legend'><span>Less</span><i class='none-key'></i>" + wsModel.WORK_SHADES.map((shade, i) => "<i style='background:" + shade + "' title='" + wsModel.WORK_LEVELS[i] + (userId === null ? " per team member" : "") + "'></i>").join("") + "<span>More</span></div></div></div></section>";
}
function wsRangeChartHtml(days, userId) {
  const byDate = new Map();
  for (const day of days) byDate.set(day.date, (byDate.get(day.date) || 0) + day.minutes);
  const dates = wsModel.yearCalendar(ws.year, ws.window.start, ws.window.end).dates.filter(Boolean).sort();
  const max = Math.max(120, Math.ceil(Math.max(0, ...byDate.values()) / 120) * 120);
  const stride = Math.max(1, Math.ceil(dates.length / 8));
  const bars = dates.map((date, index) => {
    const minutes = byDate.get(date) || 0, future = date > wsDataToday();
    const text = wsModel.dayLabel(date, true) + ": " + (future ? "not yet recorded" : byDate.has(date) ? wsModel.duration(minutes) + " worked" : "no recorded sessions");
    const attrs = " class='ws-range-point" + (byDate.has(date) ? " recorded" : "") + "' style='height:" + (minutes / max * 100) + "%' aria-label='" + wsEsc(text) + "' title='" + wsEsc(text) + "'";
    return "<div class='ws-range-column'>" + (future ? "<span role='img'" + attrs + "></span>" : "<button type='button'" + attrs + " data-action='" + (userId === null ? "year-team-day" : "open-day") + "' data-user='" + wsEsc(userId || "") + "' data-date='" + date + "' data-range-date='" + date + "' data-key='range:" + date + "'></button>") +
      (index % stride === 0 ? "<span class='ws-range-label'>" + date.slice(5).replace("-", "/") + "</span>" : "") + "</div>";
  }).join("");
  return "<section class='ws-contributions'><div class='ws-section-head'><h2>" + wsEsc(wsWindowLabel()) + "</h2><small>" + byDate.size + " recorded days</small></div><div class='ws-range-frame'><div class='ws-range-axis' aria-hidden='true'><span>" + max / 60 + "h</span><span>" + max / 120 + "h</span><span>0h</span></div><div class='ws-range-scroll' tabindex='0' aria-label='Daily worked time for selected dates'><div class='ws-range-bars' style='min-width:" + Math.max(100, dates.length * 18) + "px'><div class='ws-range-rule top'></div><div class='ws-range-rule middle'></div><div class='ws-range-rule bottom'></div>" + bars + "</div></div></div><p class='ws-range-note'>Each bar is one day's worked time, excluding breaks. Select a day for sessions.</p></section>";
}
function wsOpenYearTeamDay(date, opener) {
  ws.sheetId = "";
  ws.sheetDay = date;
  const members = wsMembers().filter((member) => member.days.some((day) => day.date === date));
  $("dlgSheetBody").innerHTML = wsDialogHead("dlgSheetTitle", wsModel.dayLabel(date, true)) + "<p class='sub'>Team worked time on this day</p><div class='ws-recent-days'>" +
    (members.length ? members.map((member) => "<button type='button' data-action='open-day' data-user='" + wsEsc(member.id) + "' data-date='" + date + "'><span>" + wsEsc(member.name) + "</span><span class='mono'>" + wsModel.duration(member.days.find((day) => day.date === date).minutes) + "</span></button>").join("") : "<p class='ws-note'>No sessions recorded on this day.</p>") + "</div>";
  if (!$("dlgSheet").open) wsOpenDialog("dlgSheet", opener);
}

// ---- member sheet (Stats) ----
function wsOpenSheet(id, opener) {
  ws.sheetId = id;
  ws.sheetDay = "";
  wsRenderSheet();
  wsOpenDialog("dlgSheet", opener);
}
function wsRenderSheet() {
  const m = ws.page === "stats" ? wsStatsMembers().find((member) => member.id === ws.sheetId) : wsMember(ws.sheetId);
  const body = $("dlgSheetBody");
  const top = body.scrollTop;
  if (!m) { body.innerHTML = wsDialogHead("dlgSheetTitle", "Member") + "<p>This member is no longer on the team.</p>"; return; }
  body.innerHTML = wsDialogHead("dlgSheetTitle", m.name) +
    "<p class='sub'>" + wsEsc(ws.page === "stats" ? wsWindowLabel() : wsModel.monthLabel(ws.period)) + " · " + m.stats.recordedDays + " recorded day" + (m.stats.recordedDays === 1 ? "" : "s") + "</p>" +
    "<div class='ws-sheet-summary'><div>Worked<strong>" + wsModel.duration(m.stats.workedMinutes) + "</strong></div><div>Avg. break time / day<strong>" + wsModel.shortDuration(m.stats.avgBreakMinutes) + "</strong></div><div>Breaks / day<strong>" + wsModel.rate(m.stats.breaksPerDay) + "</strong></div></div>" +
    wsMemberDetail(m, true);
  body.scrollTop = top;
}
function wsRefreshSheet() {
  if (!$("dlgSheet").open) return;
  if (ws.sheetDay) wsOpenYearTeamDay(ws.sheetDay); else wsRenderSheet();
}

// ---- day dialog ----
function wsMemberTarget(userId, period = ws.period) {
  const query = "organizationId=" + encodeURIComponent(orgId) + "&userId=" + encodeURIComponent(userId);
  return { key: orgId + ":" + userId + ":" + period, period, label: userId,
    hoursUrl: "/api/team/hours?" + query + "&period=" + period, editUrl: "/api/team/manual-session?" + query };
}
function wsOpenDay(userId, date, opener) {
  ws.day = { userId: userId || "", date };
  if (userId) {
    const target = wsMemberTarget(userId, date.slice(0, 7));
    if (ws.memberKey !== target.key || !ws.memberData) memberView.load(target);
  } else if (!ws.personal || ws.personal.period !== date.slice(0, 7)) {
    const period = date.slice(0, 7);
    personalView.load({ key: ws.me.user.id + ":" + period, period, label: ws.me.user.email,
      hoursUrl: "/api/hours?period=" + period, editUrl: "/api/manual-session" });
  }
  wsRefreshDay(true);
  wsOpenDialog("dlgDay", opener);
}
function wsDayData() {
  if (!ws.day) return null;
  const period = ws.day.date ? ws.day.date.slice(0, 7) : ws.period;
  if (!ws.day.userId) return ws.personal && ws.personal.period === period ? ws.personal : null;
  return ws.memberKey === wsMemberTarget(ws.day.userId, period).key ? ws.memberData : null;
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
          return "<div class='ws-timeline gap'><span class='time'>" + e.gap.start + " – " + e.gap.end + "</span><div><span class='what'>" + (e.gap.lunch ? "Lunch (inferred)" : e.gap.flagged ? "Long break flagged" : "Break") + "</span><small class='source'>" + wsEsc(wsModel.causeLabel(e.gap.cause)) + "</small></div><span class='dur'>" + wsModel.shortDuration(e.gap.minutes) + "</span><span></span></div>";
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
    (day && wsTimeAccounting([day]) ? "<p class='ws-note'>" + wsEsc(wsTimeAccounting([day])) + ". Paid lunch and overtime are included in worked time.</p>" : "") +
    "<div id='dayMsg' class='ws-feedback' role='status'></div><p class='ws-note'>" + BREAK_NOTE + "</p>";
  body.innerHTML = html;
  body.scrollTop = top;
  wsSyncBusy();
}

// ---- edit / add session ----
async function wsOpenAddDay(userId, opener) {
  const version = ws.version;
  ws.day = { userId: userId || "", date: "" };
  if (userId) {
    const target = wsMemberTarget(userId);
    if (ws.memberKey !== target.key || !ws.memberData) await memberView.load(target);
  }
  if (version !== ws.version || !wsDayData()) return;
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
  const version = ws.version;
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
  if (saved && version === ws.version) { wsCloseDialog("dlgEdit"); wsAfterEdit(); }
}
async function wsRemoveSession(button) {
  const version = ws.version;
  if (!ws.edit || !ws.edit.id) return;
  if (!ws.edit.armed) {
    ws.edit.armed = true; button.textContent = "Confirm removal";
    wsFeedback("editMsg", "This removes the session from the timesheet. Select Confirm removal to continue.", "err");
    return;
  }
  const removed = await wsActiveView().edit("DELETE", { id: ws.edit.id });
  if (removed && version === ws.version) { wsCloseDialog("dlgEdit"); wsAfterEdit(); }
}
function wsAfterEdit() {
  if (ws.day) wsFeedback("dayMsg", "Saved.", "ok");
  if (wsIsTeam()) wsLoadOverview(true);
  ws.annualKey = "";
  if (ws.page === "stats") wsLoadYear(true);
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
  const version = ws.version;
  ws.send = { selected: new Set(wsMembers().map((m) => m.id)), recipients: null, error: "", done: false, period: ws.period };
  wsRenderSendAll();
  wsOpenDialog("dlgSend", opener);
  wsLoadRecipients(true).then((list) => { if (version !== ws.version) return; ws.send.recipients = list; wsUpdateSend(); })
    .catch((error) => { if (version !== ws.version) return; ws.send.error = error.message; wsUpdateSend(); });
}
function wsRenderSendAll() {
  const members = wsMembers();
  const reference = wsModel.median(members.filter((m) => m.stats.recordedDays > 0).map((m) => m.stats.recordedDays));
  $("dlgSendBody").innerHTML = wsDialogHead("dlgSendTitle", "Review team timesheets") + wsPeriodNotice() +
    "<form id='sendForm'><div class='ws-recipients'><span>Recipients</span><strong id='sendRecipients'>Loading…</strong><button type='button' class='text-button' data-action='settings-delivery'>Change in Settings</button></div>" +
    "<div class='ws-select-head'><label class='ws-check' style='margin:0 !important'><input id='sendAll' type='checkbox' checked /> Select all members</label><span id='sendCount'></span></div>" +
    "<div class='ws-send-list'>" + members.map((m) => {
      const facts = wsModel.sendFacts(m, reference == null ? null : Math.round(reference));
      return "<div class='ws-send-row'><label class='ws-send-member'><input type='checkbox' data-send-member='" + wsEsc(m.id) + "' checked /><span><strong>" + wsEsc(m.name) + "</strong><small>" + m.stats.recordedDays + " recorded day" + (m.stats.recordedDays === 1 ? "" : "s") + "</small>" +
        facts.map((f) => "<small class='fact'>" + wsEsc(f) + "</small>").join("") + "</span><span class='mono'>" + wsModel.duration(m.stats.workedMinutes) + "</span></label>" +
        "<button type='button' class='text-button' data-action='preview' data-user='" + wsEsc(m.id) + "' aria-label='Preview CSV for " + wsEsc(m.name) + "'>Preview CSV</button></div>";
    }).join("") + "</div>" +
    "<div class='ws-send-total'><span>Selected worked time</span><strong id='sendTotal'></strong></div>" +
    "<p class='sub' style='margin-top:12px'>One email to each recipient above. Team delivery settings choose separate member CSVs or one Excel workbook with a summary and employee tabs. Preview the selected reports below before sending. Pending invitations are not included.</p>" +
    "<div id='sendMsg' class='ws-feedback' role='status'></div><div id='sendResults' class='ws-results'></div>" +
    "<div class='ws-send-footer'><div class='ws-actions-row split'><button type='button' id='teamPreviewConfirm' data-action='team-preview'>Preview email files</button><div style='display:flex;gap:10px'><button type='button' data-close>Cancel</button><button type='submit' id='sendConfirm' class='primary'></button></div></div></div></form>";
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
  button.textContent = ws.send.done ? "Sent" : "Send 1 team email";
  button.disabled = ws.send.done || ws.send.sending || size === 0 || !ws.send.recipients || ws.send.recipients.length === 0;
  $("teamPreviewConfirm").disabled = size === 0 || ws.send.sending;
}
async function wsSubmitSendAll(event) {
  event.preventDefault();
  const version = ws.version;
  if (!ws.send || ws.send.sending || ws.send.selected.size === 0) return;
  const userIds = wsMembers().filter((m) => ws.send.selected.has(m.id)).map((m) => m.id);
  ws.send.sending = true; wsUpdateSend();
  wsFeedback("sendMsg", "Sending one team email with " + userIds.length + " timesheet" + (userIds.length === 1 ? "" : "s") + "…", "ok");
  $("sendResults").textContent = "";
  try {
    const response = await api("/api/team/send?organizationId=" + encodeURIComponent(orgId), { method: "POST", body: JSON.stringify({ period: ws.send.period, userIds }) });
    const data = await response.json().catch(() => ({}));
    if (version !== ws.version) return;
    if (!data.results) throw new Error(data.error || "Could not send timesheets.");
    const failed = data.results.filter((r) => !r.ok);
    ws.send.done = failed.length === 0;
    wsFeedback("sendMsg", failed.length ? "The team email could not be sent." : "One team email for " + wsModel.monthLabel(data.period) + " sent to " + data.recipients.join(", ") + ".", failed.length ? "err" : "ok");
    if (failed.length) {
      $("sendResults").textContent = "Not sent: " + failed.map((r) => { const m = wsMember(r.userId); return (m ? m.name : r.userId) + " (" + r.error + ")"; }).join(", ") + ". Select only these people to try again.";
      ws.send.selected = new Set(failed.map((r) => r.userId));
      document.querySelectorAll("[data-send-member]").forEach((box) => { box.checked = ws.send.selected.has(box.dataset.sendMember); });
    }
  } catch (error) {
    if (version !== ws.version) return;
    wsFeedback("sendMsg", error.message || "Could not send timesheets.");
  } finally {
    if (version === ws.version) { ws.send.sending = false; wsUpdateSend(); }
  }
}
function wsOpenPersonalSend(opener) {
  if (!ws.personal) return;
  const version = ws.version;
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
      if (version !== ws.version) return;
      if (!response.ok) throw new Error(data.error || "Send failed.");
      wsFeedback("sendMsg", "Sent " + wsModel.monthLabel(data.period) + " to " + data.recipients + " recipient" + (data.recipients === 1 ? "" : "s") + ".", "ok");
      button.textContent = "Sent";
    } catch (error) {
      if (version !== ws.version) return;
      wsFeedback("sendMsg", error.message || "Send failed.");
      button.disabled = false;
    }
  });
  wsOpenDialog("dlgSend", opener);
  wsLoadRecipients(emailMode === "manager").then((list) => {
    if (version !== ws.version) return;
    $("sendRecipients").textContent = list.join(", ") || "None set";
    $("personalSendConfirm").disabled = list.length === 0;
  }).catch((error) => { if (version === ws.version) $("sendRecipients").textContent = error.message; });
}

// ---- CSV preview ----
function wsCsvPreview(text) {
  if (!text.trim()) return "<p class='sub'>No sessions recorded for this month.</p>";
  const rows = text.trim().split(String.fromCharCode(10)).map(pvParseLine);
  const head = rows[0];
  return "<div class='pv-scroll'><table class='pv'><thead><tr>" + head.map((h) => "<th>" + wsEsc(h) + "</th>").join("") + "</tr></thead><tbody>" +
    rows.slice(1).filter((cells) => cells.join("") !== "").map((cells) => "<tr" + (cells.indexOf("Total") !== -1 ? " class='pv-total'" : cells.indexOf("Vacation") !== -1 ? " class='pv-vac'" : "") + ">" +
      head.map((_, i) => "<td>" + wsEsc(cells[i] || "") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
}
async function wsOpenTeamPreview(opener) {
  if (!ws.send || !ws.send.selected.size) return;
  const version = ws.version;
  const title = "Team email files · " + wsModel.monthLabel(ws.send.period);
  $("dlgPreviewBody").innerHTML = wsDialogHead("dlgPreviewTitle", title) + "<p class='sub' role='status'>Loading…</p>";
  wsOpenDialog("dlgPreview", opener);
  let html;
  try {
    const response = await api("/api/team/preview-bundle?organizationId=" + encodeURIComponent(orgId), {
      method: "POST", body: JSON.stringify({ period: ws.send.period, userIds: wsMembers().filter((m) => ws.send.selected.has(m.id)).map((m) => m.id) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the preview.");
    html = "<p class='sub'>" + data.files.length + " file" + (data.files.length === 1 ? "" : "s") + " in one email per recipient.</p>" +
      data.files.map((file, fileIndex) => "<h3>" + wsEsc(file.filename) + "</h3><div class='ws-sheet-tabs' role='tablist' aria-label='" + wsEsc(file.filename) + " sheets'>" +
        file.sheets.map((sheet, i) => "<button type='button' role='tab' id='sheet-tab-" + fileIndex + "-" + i + "' aria-controls='sheet-panel-" + fileIndex + "-" + i + "' aria-selected='" + (i === 0) + "' data-action='preview-sheet' data-file='" + fileIndex + "' data-sheet='" + i + "'>" + wsEsc(sheet.name) + "</button>").join("") + "</div>" +
        file.sheets.map((sheet, i) => "<section role='tabpanel' id='sheet-panel-" + fileIndex + "-" + i + "' aria-labelledby='sheet-tab-" + fileIndex + "-" + i + "' data-preview-file='" + fileIndex + "' data-preview-sheet='" + i + "'" + (i ? " hidden" : "") + "><div class='pv-scroll'><table class='pv'><tbody>" +
          sheet.rows.map((row) => "<tr>" + row.map((value) => "<td" + (row.length === 1 ? " colspan='" + Math.max(...sheet.rows.map((r) => r.length)) + "'" : "") + ">" + wsEsc(value) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div></section>").join("")).join("") +
      "<details><summary>Email summary</summary><pre style='white-space:pre-wrap'>" + wsEsc(data.text) + "</pre></details>";
  } catch (error) { html = "<p class='ws-feedback err'>" + wsEsc(error.message || "Could not load the preview.") + "</p>"; }
  if (version === ws.version && $("dlgPreview").open) $("dlgPreviewBody").innerHTML = wsDialogHead("dlgPreviewTitle", title) + html;
}
async function wsOpenPreview(userId, opener) {
  const version = ws.version;
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
    html = wsCsvPreview(await response.text());
  } catch { html = "<p class='ws-feedback err'>Could not load the preview.</p>"; }
  if (version === ws.version && $("dlgPreview").open) $("dlgPreviewBody").innerHTML = wsDialogHead("dlgPreviewTitle", title) + html;
}

// ---- settings ----
function wsShow(id, visible) { $(id).classList.toggle("hidden", !visible); }
let settingsScope = "personal";
let timePolicyVersion = 0;
function wsInvalidateSettings() {
  ++timePolicyVersion;
  $("timePolicyFields").disabled = true; $("saveTimePolicy").disabled = true;
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
  for (const id of ["setWorkingHours", "setTimePolicy", "setInactivity", "setPlan"]) $("settingsTeamPanel").appendChild($(id));
  $(team ? "teamDeliverySlot" : "personalDeliverySlot").appendChild($("setDelivery"));
  $("emailTitle").textContent = "Timesheet delivery";
  $("emailMsg").textContent = "";
  wsShow("emailEdit", false); wsShow("emailReadonly", true);
  $("emailReadonly").textContent = "Loading delivery settings...";
  wsShow("setWorkingHours", canManage); wsShow("setInactivity", canManage); wsShow("setPlan", canManage);
  wsShow("setTimePolicy", canManage);
  const ownsSingle = ws.mode === "personal" && orgPlanKey === "single" && !!orgId && isManagerRoleC(orgRole);
  wsShow("setTeamCreate", ws.mode === "personal" && (ws.me.operator || ownsSingle));
  wsShow("setOperator", !!ws.me.operator);
  if (team) {
    $("planSummary").textContent = (orgPlanKey === "enterprise" ? "Enterprise" : "Team") + " \u00b7 " + memberCount + (orgCap >= 1000000 ? "" : " of " + orgCap) + " member seats used";
    $("teamHoursSlot").appendChild($("workingHoursEditor"));
    $("hoursTargetField").classList.add("hidden"); $("hoursTarget").value = "";
    loadWorkingHoursEditor(); loadInactivityEditor(); wsLoadTimePolicy();
  } else loadWorkingHoursSummary();
  loadEmailSettings(team || ownsSingle ? { kind: "team", path: "/api/team/settings?organizationId=" + encodeURIComponent(orgId) } : { kind: "personal", path: "/api/settings" });
}
$("settingsPersonalTab").onclick = () => wsSelectSettings("personal");
function wsSyncOvertime() {
  const mode = $("overtimeMode").value;
  $("overtimeThresholdField").hidden = mode === "disabled";
  $("overtimeThreshold").disabled = mode === "disabled";
  $("overtimeThreshold").max = mode === "weekly" ? "168" : "24";
  document.querySelector("label[for='overtimeThreshold']").textContent = "Overtime starts after worked hours per " + (mode === "weekly" ? "week" : "day");
}
$("overtimeMode").onchange = () => {
  $("overtimeThreshold").value = $("overtimeMode").value === "weekly" ? "40" : "8";
  wsSyncOvertime();
};
async function wsLoadTimePolicy() {
  const version = ++timePolicyVersion;
  $("timePolicyFields").disabled = true; $("saveTimePolicy").disabled = true;
  wsFeedback("timePolicyMsg", "Loading lunch and overtime settings...", "loading");
  try {
    const response = await api("/api/team/time-policy?organizationId=" + encodeURIComponent(orgId));
    const data = await response.json();
    if (version !== timePolicyVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not load settings. Reopen Team settings to retry.");
    $("paidLunchMinutes").value = data.policy.paidLunchMinutes;
    $("lunchMinMinutes").value = data.policy.lunchMinMinutes;
    $("lunchMaxMinutes").value = data.policy.lunchMaxMinutes;
    $("longBreakMinutes").value = data.policy.longBreakMinutes;
    $("overtimeMode").value = data.policy.overtime.mode;
    $("overtimeThreshold").value = data.policy.overtime.mode === "disabled" ? "8" : String(data.policy.overtime.thresholdMinutes / 60);
    wsSyncOvertime();
    $("timePolicyFields").disabled = false; $("saveTimePolicy").disabled = false;
    wsFeedback("timePolicyMsg", "");
  } catch (error) { if (version === timePolicyVersion) wsFeedback("timePolicyMsg", error.message || "Could not load settings.", "err"); }
}
$("timePolicyForm").onsubmit = async (event) => {
  event.preventDefault();
  if ($("saveTimePolicy").disabled || settingsScope !== "team" || !wsIsTeam() || !isManagerRoleC(orgRole)) return;
  const version = timePolicyVersion;
  const organization = orgId;
  const mode = $("overtimeMode").value;
  const policy = { paidLunchMinutes: Number($("paidLunchMinutes").value), lunchMinMinutes: Number($("lunchMinMinutes").value), lunchMaxMinutes: Number($("lunchMaxMinutes").value), longBreakMinutes: Number($("longBreakMinutes").value), overtime: mode === "disabled" ? { mode } : { mode, thresholdMinutes: Math.round(Number($("overtimeThreshold").value) * 60) } };
  $("timePolicyFields").disabled = true; $("saveTimePolicy").disabled = true;
  wsFeedback("timePolicyMsg", "Saving...", "loading");
  try {
    const response = await api("/api/team/time-policy?organizationId=" + encodeURIComponent(organization), { method: "POST", body: JSON.stringify(policy) });
    const data = await response.json();
    if (version !== timePolicyVersion) return;
    if (!response.ok) throw new Error(data.error || "Could not save settings.");
    wsFeedback("timePolicyMsg", "Saved. Team timesheets now use these rules.", "ok");
    ++ws.annualVersion; ws.annual = null; ws.annualKey = ""; ws.annualLoading = false;
    ws.memberData = null; ws.memberKey = "";
    await wsLoadOverview(true);
    if (ws.page === "stats") wsLoadYear(true);
  } catch (error) { if (version === timePolicyVersion) wsFeedback("timePolicyMsg", error.message || "Could not save settings.", "err"); }
  finally {
    if (version === timePolicyVersion) { $("timePolicyFields").disabled = false; $("saveTimePolicy").disabled = false; }
  }
};
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
  const version = ws.version;
  const m = wsMember(ws.settingsMember);
  if (!m) return;
  const button = $("memberRemove");
  if (!button.dataset.armed) { button.dataset.armed = "1"; button.textContent = "Confirm removal of " + m.name; return; }
  button.disabled = true;
  try {
    const response = await api("/api/auth/organization/remove-member", { method: "POST", body: JSON.stringify({ memberIdOrEmail: m.email, organizationId: orgId }) });
    const data = await response.json().catch(() => ({}));
    if (version !== ws.version) return;
    if (!response.ok) throw new Error(data.message || data.error || "Could not remove member.");
    ws.expanded.delete(m.id);
    wsCloseDialog("dlgMember");
    if ($("dlgSheet").open && ws.sheetId === m.id) wsCloseDialog("dlgSheet");
    wsLoadOverview(true);
  } catch (error) {
    if (version !== ws.version) return;
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
  const version = ws.version;
  const email = $("inviteEmail").value.trim();
  $("inviteLinkBox").classList.add("hidden");
  if (!email || !$("inviteEmail").checkValidity()) { wsFeedback("inviteMsg", "Enter a valid email to invite."); return; }
  $("inviteBtn").disabled = true;
  try {
    const response = await api("/api/auth/organization/invite-member", { method: "POST", body: JSON.stringify({ email, role: $("inviteRole").value, organizationId: orgId }) });
    const data = await response.json().catch(() => ({}));
    if (version !== ws.version) return;
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
    if (version !== ws.version) return;
    wsFeedback("inviteMsg", error.message || "Could not create invite.");
  } finally { if (version === ws.version) $("inviteBtn").disabled = orgCap < 1000000 && memberCount >= orgCap; }
});
$("copyInvite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("inviteLink").value); wsFeedback("inviteMsg", "Invite link copied. Only share it with the person you invited.", "ok"); }
  catch { $("inviteLink").select(); }
});
async function wsCancelInvite(id, button) {
  const version = ws.version;
  button.disabled = true;
  try {
    const response = await api("/api/auth/organization/cancel-invitation", { method: "POST", body: JSON.stringify({ invitationId: id }) });
    if (!response.ok) throw new Error();
  } catch { if (version !== ws.version) return; wsFeedback("inviteMsg", "Could not cancel that invitation."); button.disabled = false; return; }
  if (version !== ws.version) return;
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

let wsBrush = null;
$("wsMain").addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" || event.button !== 0) return;
  const cell = event.target.closest(".ws-cal button[data-date]");
  if (!cell) return;
  wsBrush = { start: cell.dataset.date, end: cell.dataset.date, x: event.clientX, y: event.clientY, moved: false };
});
document.addEventListener("pointermove", (event) => {
  if (!wsBrush) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(".ws-cal [data-date]");
  if (cell) wsBrush.end = cell.dataset.date;
  wsBrush.moved = wsBrush.moved || Math.hypot(event.clientX - wsBrush.x, event.clientY - wsBrush.y) > 5;
  if (wsBrush.moved) {
    const first = [wsBrush.start, wsBrush.end].sort()[0], last = [wsBrush.start, wsBrush.end].sort()[1];
    document.querySelectorAll(".ws-cal button[data-date]").forEach((cell) => cell.classList.toggle("brushed", cell.dataset.date >= first && cell.dataset.date <= last));
  }
});
document.addEventListener("pointerup", () => {
  if (!wsBrush) return;
  const brush = wsBrush; wsBrush = null;
  if (brush.moved) { ws.suppressClick = true; wsSetWindow(brush.start, brush.end); setTimeout(() => { ws.suppressClick = false; }, 0); }
});
document.addEventListener("pointercancel", () => { wsBrush = null; document.querySelectorAll(".brushed").forEach((cell) => cell.classList.remove("brushed")); });

// ---- events ----
$("wsMain").addEventListener("keydown", (event) => {
  const chart = event.target.closest(".ws-cal");
  if (!chart) return;
  const cells = Array.from(chart.querySelectorAll("button[data-date]")).sort((a, b) => a.dataset.date.localeCompare(b.dataset.date));
  const index = cells.indexOf(event.target);
  const steps = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
  let next;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = cells.length - 1;
  else if (event.key in steps) next = Math.max(0, Math.min(cells.length - 1, index < 0 ? 0 : index + steps[event.key]));
  else return;
  event.preventDefault();
  if (cells[next]) cells[next].focus();
});
$("wsMain").addEventListener("toggle", (event) => {
  const week = event.target.dataset.week;
  if (!week) return;
  if (event.target.open) ws.closedWeeks.delete(week); else ws.closedWeeks.add(week);
}, true);
$("workspace").addEventListener("click", (event) => {
  const el = event.target.closest("[data-action], [data-page]");
  if (!el || !$("workspace").contains(el)) return;
  if (ws.suppressClick) { event.preventDefault(); return; }
  if (el.dataset.page) {
    if (ws.page !== el.dataset.page) { ws.page = el.dataset.page; wsSyncUrl(); wsRender(); wsLoadPage(); }
    return;
  }
  const action = el.dataset.action;
  if (action === "zoom-reset") { ws.window = null; wsRender(); }
  else if (action === "zoom-apply") {
    const start = $("wsZoomStart"), end = $("wsZoomEnd");
    if (start.reportValidity() && end.reportValidity()) wsSetWindow(start.value, end.value);
  } else if (action === "zoom-preset") {
    const end = ws.year === wsToday().y ? wsDataToday() : ws.year + "-12-31";
    const start = new Date(Date.parse(end + "T00:00:00Z") - (Number(el.dataset.days) - 1) * 86400000).toISOString().slice(0, 10);
    wsSetWindow(start < ws.year + "-01-01" ? ws.year + "-01-01" : start, end);
  } else if (action === "year") { ws.year = Number(el.dataset.year); ws.window = null; wsSyncUrl(); wsLoadYear(); }
  else if (action === "reload-year") wsLoadYear(true);
  else if (action === "year-team-day") wsOpenYearTeamDay(el.dataset.date, el);
  else if (action === "toggle-member") {
    if (ws.expanded.has(el.dataset.id)) ws.expanded.delete(el.dataset.id); else ws.expanded.add(el.dataset.id);
    wsRenderRoster();
    const again = document.querySelector("#wsRosterBody [data-key='member:" + el.dataset.id + "']");
    if (again && el.classList.contains("ws-person-toggle")) again.focus({ preventScroll: true });
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
  else if (action === "team-preview") wsOpenTeamPreview(el);
  else if (action === "preview-sheet") {
    document.querySelectorAll("[data-preview-file='" + el.dataset.file + "']").forEach((panel) => { panel.hidden = panel.dataset.previewSheet !== el.dataset.sheet; });
    document.querySelectorAll("[data-action='preview-sheet'][data-file='" + el.dataset.file + "']").forEach((tab) => { tab.setAttribute("aria-selected", String(tab === el)); });
  }
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
$("wsTeam").onchange = () => startWorkspace(ws.me, $("wsTeam").value);

function wsWorkspaceMemberships(me) {
  const memberships = me.orgs || [];
  const primary = wsPrimaryMembership(memberships);
  return memberships.filter((membership) => membership === primary ||
    (membership.plan !== "single" && isManagerRoleC(membership.role)));
}

/** Show the workspace for this account. Called after sign-in passes the access gates. */
async function startWorkspace(me, selectedTeam) {
  ++ws.version; ++ws.overviewVersion;
  for (const frame of [...wsDialogs].reverse()) wsCloseDialog(frame.id);
  wsDialogs.length = 0;
  wsInvalidateSettings();
  ws.day = null; ws.edit = null; ws.send = null; ws.sheetId = ""; ws.sheetDay = "";
  ws.settingsMember = ""; ws.messageTarget = ""; ws.busy = false;
  ws.me = me;
  meEmail = (me.user && me.user.email) || "";
  orgId = ""; orgName = ""; orgRole = ""; orgPlanKey = ""; orgCap = 0; memberCount = 0;
  const params = new URLSearchParams(location.search);
  const memberships = wsWorkspaceMemberships(me);
  const storageKey = "clocked:management-team:" + me.user.id;
  let rememberedTeam = "";
  try { rememberedTeam = localStorage.getItem(storageKey) || ""; } catch {}
  const requestedTeam = selectedTeam || params.get("team") || rememberedTeam;
  const membership = memberships.find((item) => item.organizationId === requestedTeam) || wsPrimaryMembership(me.orgs || []);
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
  try {
    if (wsIsTeam()) localStorage.setItem(storageKey, orgId); else localStorage.removeItem(storageKey);
  } catch {}
  const t = wsToday();
  const month = params.get("month");
  ws.period = month && /^\d{4}-\d{2}$/.test(month) && month <= wsCurrentPeriod() ? month : wsModel.lastCompleteMonth(t);
  ws.page = params.get("view") === "stats" ? "stats" : "timesheets";
  const year = Number(params.get("year"));
  ws.year = Number.isInteger(year) && year >= 2000 && year <= t.y ? year : t.y;
  ws.window = null; ws.closedWeeks = new Set();
  ++ws.annualVersion; ws.annual = null; ws.annualError = ""; ws.annualKey = ""; ws.annualLoading = false;
  ws.query = ""; ws.expanded = new Set(); ws.scope = "all"; ws.overview = null; ws.overviewError = ""; ws.personal = null; ws.personalError = "";
  ws.pending = []; ws.policy = undefined; ws.memberData = null; ws.memberKey = "";
  personalView.clear(true); memberView.clear(true);
  $("wsName").textContent = ws.mode === "personal" ? "Personal account" : orgName;
  const switchable = memberships.length > 1;
  wsShow("wsName", !switchable); wsShow("wsTeamSwitch", switchable);
  $("wsTeam").innerHTML = memberships.map((item) => "<option value='" + wsEsc(item.organizationId) + "'>" +
    wsEsc(item.name) + " · " + (wsRoleTag(item.role) || "Worker") + "</option>").join("");
  $("wsTeam").value = orgId;
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
