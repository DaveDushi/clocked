import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { selectPrimaryMembership } from "../.tmp-test/memberships.js";

const html = await dashboardResponse().text();
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
const membership = (organizationId, role, createdAt) => ({
  id: organizationId, organizationId, name: organizationId, role, createdAt, plan: "team", cap: 50, memberCount: 2,
});
const me = {
  user: { id: "manager", email: "manager@example.test" },
  orgs: [membership("harbor", "owner", "2026-01-01"), membership("orchard", "admin", "2026-01-02"), membership("worker-only", "member", "2026-01-03")],
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", innerHTML: "", classes: new Set(),
      classList: { toggle(name, on) { if (on) $(id).classes.add(name); else $(id).classes.delete(name); }, remove(name) { $(id).classes.delete(name); } },
      setAttribute() {}, appendChild(child) { child.parentNode = this; },
    });
    return elements.get(id);
  };
  const storage = new Map();
  const requests = [];
  const context = {
    $, URL, URLSearchParams, Date, wsPrimaryMembership: selectPrimaryMembership,
    ws: { version: 0, overviewVersion: 0, annualVersion: 0 }, wsDialogs: [],
    location: { href: "https://clocked.test/?month=2026-09", search: "?month=2026-09" },
    history: { replaceState(_, __, path) { const url = new URL(path, "https://clocked.test"); context.location.href = url.href; context.location.search = url.search; } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    wsModel: { lastCompleteMonth: () => "2026-09", initials: () => "MA" },
    personalView: { clear() {} }, memberView: { clear() {} },
    wsCloseDialog() {}, wsRender() {}, wsRefreshSheet() {}, wsRenderBottom() {}, wsRenderPending() {},
    wsToday: () => ({ y: 2026, m: 10, d: 22 }), wsCurrentPeriod: () => "2026-10",
    wsShow: (id, visible) => $(id).classList.toggle("hidden", !visible),
    emailLoadVersion: 0, hoursLoadVersion: 0, inactivityLoadVersion: 0, timePolicyVersion: 0, workerPermissionsVersion: 0,
    api: async (path) => {
      requests.push(path);
      const team = new URL(path, "https://clocked.test").searchParams.get("organizationId");
      return { ok: true, json: async () => path.includes("overview") ? { members: [{ id: team + "-worker" }] } : path.includes("list-invitations") ? [] : { policy: null } };
    },
  };
  runInNewContext(
    between("const wsEsc =", "const wsArrow =") +
    between("function isManagerRoleC(role)", "function roleLabel(role)") +
    between("function wsRoleTag(role)", '/** "Today"') +
    between("async function wsLoadOverview(keep)", "// ---- rendering ----") +
    between("function wsInvalidateSettings()", "function wsSelectSettings(scope)") +
    between("function wsMemberTarget(userId", "function wsOpenDay(") +
    between("function wsDayData()", "function wsSourceLabel(") +
    between("function wsWorkspaceMemberships(me)", "\ninit();") +
    '\nfunction wsIsTeam() { return ws.mode === "team"; }\nfunction wsLoadPage() { return wsLoadOverview(false); }',
    context,
  );
  return { context, $, storage, requests };
}

test("a manager can open and remember either managed team without loading personal tracking", async () => {
  const h = harness();
  await h.context.startWorkspace(me);
  assert.equal(h.context.orgId, "harbor");
  assert.equal(h.$("wsTeamSwitch").classes.has("hidden"), false);
  assert.doesNotMatch(h.$("wsTeam").innerHTML, /worker-only/);
  await h.context.startWorkspace(me, "orchard");
  assert.equal(h.context.orgId, "orchard");
  assert.equal(h.context.ws.mode, "team");
  assert.equal(h.context.ws.overview.members[0].id, "orchard-worker");
  assert.equal(h.context.wsMemberTarget("ben").editUrl, "/api/team/manual-session?organizationId=orchard&userId=ben");
  h.context.ws.day = { userId: "ben", date: "2026-09-01" };
  h.context.ws.memberKey = h.context.wsMemberTarget("ben").key;
  h.context.ws.memberData = { sessions: [{ id: "ben-session" }] };
  assert.equal(h.context.wsDayData().sessions[0].id, "ben-session");
  await h.context.startWorkspace(me, "harbor");
  h.context.ws.day = { userId: "ben", date: "2026-09-01" };
  assert.equal(h.context.wsDayData(), null);
  await h.context.startWorkspace(me, "orchard");
  assert.equal(h.storage.get("clocked:management-team:manager"), "orchard");
  assert.equal(new URL(h.context.location.href).searchParams.get("team"), "orchard");
  assert.ok(h.requests.every((path) => path.startsWith("/api/team/") || path.startsWith("/api/auth/organization/list-invitations?")));
  h.context.location.search = "";
  await h.context.startWorkspace(me);
  assert.equal(h.context.orgId, "orchard");
});

test("invalid, removed and worker-only selections fall back to the primary membership", async () => {
  const h = harness();
  for (const selected of ["unknown", "worker-only"]) {
    await h.context.startWorkspace(me, selected);
    assert.equal(h.context.orgId, "harbor");
  }
  await h.context.startWorkspace(me, "orchard");
  await h.context.startWorkspace({ ...me, orgs: [me.orgs[0]] });
  assert.equal(h.context.orgId, "harbor");
  assert.equal(h.$("wsTeamSwitch").classes.has("hidden"), true);
  await h.context.startWorkspace({ user: { id: "another", email: "another@example.test" }, orgs: [] });
  assert.equal(h.context.orgId, "");
  assert.equal(h.context.ws.mode, "personal");
});

test("a worker in the primary team can manage a second team without changing the primary membership", async () => {
  const h = harness();
  const account = { ...me, orgs: [membership("worker-first", "member", "2026-01-01"), me.orgs[1]] };
  await h.context.startWorkspace(account, "orchard");
  assert.equal(h.context.orgId, "orchard");
  assert.equal(h.context.ws.mode, "team");
  assert.equal(selectPrimaryMembership(account.orgs).organizationId, "worker-first");
});

test("late overview, invitation and policy responses cannot overwrite a newly selected team", async () => {
  const h = harness();
  const oldApi = h.context.api;
  const finish = [];
  h.context.api = (path) => path.includes("organizationId=harbor")
    ? new Promise((resolve) => finish.push(() => resolve({ ok: true, json: async () => path.includes("overview") ? { members: [{ id: "old-worker" }] } : path.includes("list-invitations") ? [{ status: "pending", email: "old@example.test" }] : { policy: { timeout_secs: 900 } } })))
    : oldApi(path);
  const oldWorkspace = h.context.startWorkspace(me, "harbor");
  await h.context.startWorkspace(me, "orchard");
  for (const resolve of finish) resolve();
  await oldWorkspace; await settle();
  assert.equal(h.context.orgId, "orchard");
  assert.equal(h.context.ws.overview.members[0].id, "orchard-worker");
  assert.equal(h.context.ws.pending.length, 0);
  assert.equal(h.context.ws.policy, null);
});
