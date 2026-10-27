import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";

const html = await dashboardResponse().text();
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
const email = between("let emailSettingsContext = null;", "function setSchedule");
const save = between('$("saveEmail").onclick =', "// ---- CSV preview ----");
const scope = between('let settingsScope = "personal";', '$("settingsPersonalTab").onclick');
function harness({ mode = "team", role = "owner", plan = "team", managed = true, api } = {}) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, disabled: false, hidden: false, value: "", checked: false, textContent: "", className: "",
      classes: new Set(),
      classList: { toggle(name, on) { const e = $(id); if (on) e.classes.add(name); else e.classes.delete(name); }, add(name) { $(id).classes.add(name); } },
      appendChild(child) { child.parentId = id; }, setAttribute(key, value) { this[key] = value; },
    });
    return elements.get(id);
  };
  const requests = [];
  const context = {
    $, ws: { mode, me: {} }, orgId: "selected-team", orgRole: role, orgPlanKey: plan, orgCap: 50, memberCount: 5,
    emailMode: "manager", emailLoadVersion: 0, hoursLoadVersion: 0, inactivityLoadVersion: 0,
    wsIsTeam: () => mode === "team",
    wsShow: (id, visible) => $(id).classList.toggle("hidden", !visible),
    fillSendDays() {}, fillTimeZones() {}, loadWorkingHoursEditor() {}, loadInactivityEditor() {}, loadWorkingHoursSummary() {}, wsLoadTimePolicy() {}, wsLoadWorkerPermissions() {},
    renderRecipients(recipients) { context.recipients = recipients; },
    renderEmailReadonly(recipients) { context.readonly = recipients; }, setSchedule(day, time, timezone, frequency) { $("sendFrequency").value = frequency || "monthly"; },
    recipientValues: () => ["payroll@example.test"],
    api: async (path, options) => {
      requests.push({ path, options });
      return api ? api(path, options) : { ok: true, json: async () => ({ managed, recipients: ["payroll@example.test"], sendDay: 1 }) };
    },
  };
  runInNewContext(between("function isManagerRoleC(role)", "function roleLabel(role)") + email + save + scope, context);
  return { context, $, requests, run: (code) => runInNewContext(code, context) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("owner/admin settings separate personal effective delivery from selected team edits", async () => {
  for (const role of ["owner", "admin", "member, admin "]) {
    const h = harness({ role });
    h.run('wsSelectSettings("personal")'); await settle();
    assert.equal(h.$("settingsTeamTab").hidden, false);
    assert.equal(h.$("setDesktop").parentId, "settingsPersonalPanel");
    assert.equal(h.$("setMyHours").parentId, "settingsPersonalPanel");
    assert.equal(h.$("setInactivity").parentId, "settingsTeamPanel");
    assert.equal(h.$("saveEmail").disabled, true);
    await h.$("saveEmail").onclick();
    assert.deepEqual(h.requests.map((r) => r.path), ["/api/settings"]);
    h.run('wsSelectSettings("team")'); await settle();
    assert.equal(h.$("settingsPersonalPanel").hidden, true);
    assert.equal(h.$("setDelivery").parentId, "teamDeliverySlot");
    assert.equal(h.$("saveEmail").disabled, false);
    await h.$("saveEmail").onclick();
    assert.equal(h.requests.at(-1).path, "/api/team/settings?organizationId=selected-team");
    assert.equal(h.requests.at(-1).options.method, "POST");
    assert.equal(h.context.emailMode, "manager");
  }
});

test("workers, solo accounts, single-plan managers and operator-only users cannot select Team settings", async () => {
  for (const [mode, role] of [["worker", "member"], ["personal", ""], ["personal", "owner"], ["team", "notadmin"]]) {
    const h = harness({ mode, role }); h.context.ws.me.operator = true;
    h.run('wsSelectSettings("team")'); await settle();
    assert.equal(h.$("settingsTeamTab").hidden, true);
    assert.equal(h.$("settingsTeamPanel").hidden, true);
    assert.equal(h.$("settingsPersonalPanel").hidden, false);
    assert.equal(h.$("setWorkingHours").classes.has("hidden"), true);
    assert.deepEqual(h.requests.map((r) => r.path), ["/api/settings"]);
  }
});

test("unmanaged solo delivery saves only personal settings", async () => {
  const h = harness({ mode: "personal", role: "", managed: false });
  h.run('wsSelectSettings("personal")'); await settle();
  assert.equal(h.$("saveEmail").disabled, false);
  await h.$("saveEmail").onclick();
  assert.equal(h.requests.at(-1).path, "/api/settings");
  assert.equal(h.requests.at(-1).options.method, "POST");
});

test("legacy single-seat owners can change delivery from Personal settings", async () => {
  for (const role of ["owner", "admin"]) {
    const h = harness({ mode: "personal", role, plan: "single" });
    h.run('wsSelectSettings("personal")'); await settle();
    assert.equal(h.$("settingsTeamTab").hidden, true);
    assert.equal(h.$("settingsPersonalPanel").hidden, false);
    assert.equal(h.$("setDelivery").parentId, "personalDeliverySlot");
    assert.equal(h.$("saveEmail").disabled, false, "the personal account owner controls delivery");
    assert.deepEqual(h.requests.map((r) => r.path), ["/api/team/settings?organizationId=selected-team"]);
    h.$("autoSend").checked = true;
    h.$("sendDay").value = "12";
    h.$("sendTime").value = "09:30";
    h.$("sendTimezone").value = "Europe/Berlin";
    await h.$("saveEmail").onclick();
    assert.equal(h.requests.at(-1).path, "/api/team/settings?organizationId=selected-team");
    assert.equal(h.requests.at(-1).options.method, "POST");
    assert.deepEqual(JSON.parse(h.requests.at(-1).options.body), {
      recipients: ["payroll@example.test"], sendFrequency: "monthly", sendDay: 12, sendTime: "09:30", sendTimezone: "Europe/Berlin",
    });
    assert.equal(h.$("emailMsg").textContent, "Saved.");
  }
});

test("late team loads and saves cannot enable edits or replace feedback in Personal settings", async () => {
  let resolveTeam;
  const teamResponse = new Promise((resolve) => { resolveTeam = resolve; });
  const h = harness({ api: (path) => path.startsWith("/api/team/") ? teamResponse : { ok: true, json: async () => ({ managed: true, recipients: ["personal-effective@example.test"] }) } });
  h.run('wsSelectSettings("team"); wsSelectSettings("personal")'); await settle();
  resolveTeam({ ok: true, json: async () => ({ recipients: ["team@example.test"] }) }); await settle();
  assert.equal(h.$("saveEmail").disabled, true);
  assert.deepEqual(h.context.readonly, ["personal-effective@example.test"]);
  assert.equal(h.context.recipients, undefined);
  let resolveSave;
  h.context.api = async (path, options) => options ? new Promise((resolve) => { resolveSave = resolve; }) : { ok: true, json: async () => ({ managed: true, recipients: ["team@example.test"] }) };
  h.run('wsSelectSettings("team")'); await settle();
  const saving = h.$("saveEmail").onclick();
  h.run('wsSelectSettings("personal")'); await settle();
  resolveSave({ ok: true, json: async () => ({ ok: true }) }); await saving;
  assert.equal(h.$("saveEmail").disabled, true);
  assert.equal(h.$("emailMsg").textContent, "");
});

test("closing settings rejects a pending delivery response", async () => {
  let finish;
  const h = harness({ api: () => new Promise((resolve) => { finish = resolve; }) });
  h.run('wsSelectSettings("team"); wsInvalidateSettings()');
  finish({ ok: true, json: async () => ({ recipients: ["team@example.test"] }) }); await settle();
  assert.equal(h.$("saveEmail").disabled, true);
  assert.equal(h.context.recipients, undefined);
});

test("working-hours saves require Team or Member settings and ignore stale completions", async () => {
  const h = harness();
  h.context.syncWorkingHoursFields = () => {};
  runInNewContext(between("function workingHoursPath()", "function syncWorkingHoursFields()") + between('$("saveWorkingHours").onclick =', "async function loadWorkingHoursSummary()"), h.context);
  h.$("dlgSettings").open = true;
  h.$("saveWorkingHours").disabled = false;
  await h.$("saveWorkingHours").onclick();
  assert.equal(h.requests.length, 0, "Personal settings cannot save team hours even if a control is enabled");
  h.run('wsSelectSettings("team")'); await settle();
  h.$("saveWorkingHours").disabled = false;
  h.$("hoursMode").value = "inherit";
  h.$("hoursTarget").value = "ana";
  let finish;
  const saves = [];
  h.context.api = (path) => { saves.push(path); return new Promise((resolve) => { finish = resolve; }); };
  const saving = h.$("saveWorkingHours").onclick();
  assert.equal(saves[0], "/api/team/working-hours?organizationId=selected-team&userId=ana");
  h.run('wsInvalidateSettings()');
  h.context.orgId = "another-team"; h.$("hoursTarget").value = "ben";
  h.$("workingHoursMsg").textContent = "Current editor";
  finish({ ok: true, json: async () => ({ ok: true }) }); await saving;
  assert.equal(h.$("workingHoursMsg").textContent, "Current editor");
  assert.equal(h.$("saveWorkingHours").disabled, true);
});
