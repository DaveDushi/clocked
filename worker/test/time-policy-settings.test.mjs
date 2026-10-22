import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";

const html = await dashboardResponse().text();
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const handlers = script.slice(script.indexOf("function wsSyncOvertime()"), script.indexOf('$("settingsTeamTab").onclick'));
const policy = { paidLunchMinutes: 30, lunchMinMinutes: 20, lunchMaxMinutes: 90, longBreakMinutes: 15, overtime: { mode: "weekly", thresholdMinutes: 2400 } };
function harness(api) {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", disabled: true, hidden: false });
    return elements.get(id);
  };
  const requests = [];
  const context = {
    $, timePolicyVersion: 0, orgId: "team-a", orgRole: "owner", settingsScope: "team",
    ws: { annualVersion: 0, annualKey: "cached", memberData: {} },
    document: { querySelector: () => $("thresholdLabel") },
    wsIsTeam: () => true, isManagerRoleC: () => true,
    wsFeedback(id, text) { $(id).textContent = text; },
    async wsLoadOverview() {}, wsLoadYear() {},
    async api(path, options) { requests.push({ path, options }); return api ? api(path, options) : { ok: true, json: async () => ({ policy }) }; },
  };
  runInNewContext(handlers, context);
  return { $, requests, context };
}
test("manager form restores weekly hours and saves lunch, overtime and long-break limits", async () => {
  const h = harness();
  await h.context.wsLoadTimePolicy();
  assert.equal(h.$("overtimeThreshold").value, "40");
  assert.equal(h.$("overtimeThreshold").max, "168");
  assert.equal(h.$("thresholdLabel").textContent, "Overtime starts after worked hours per week");
  assert.equal(h.$("saveTimePolicy").disabled, false);
  await h.$("timePolicyForm").onsubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(h.requests.at(-1).options.body), policy);
  assert.equal(h.requests.at(-1).path, "/api/team/time-policy?organizationId=team-a");
  assert.equal(h.context.ws.memberData, null);
  assert.equal(h.$("timePolicyMsg").textContent, "Saved. Team timesheets now use these rules.");
  h.$("overtimeMode").value = "daily"; h.$("overtimeMode").onchange();
  assert.equal(h.$("overtimeThreshold").value, "8");
  assert.equal(h.$("overtimeThreshold").max, "24");
  h.$("overtimeMode").value = "disabled"; h.$("overtimeMode").onchange();
  assert.equal(h.$("overtimeThreshold").disabled, true);
  assert.equal(h.$("overtimeThresholdField").hidden, true);
});
test("late policy responses cannot enable controls after switching settings or teams", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness(() => pending);
  const load = h.context.wsLoadTimePolicy();
  h.context.timePolicyVersion++;
  h.context.settingsScope = "personal";
  h.context.orgId = "team-b";
  resolve({ ok: true, json: async () => ({ policy }) });
  await load;
  assert.equal(h.$("saveTimePolicy").disabled, true);
  assert.equal(h.$("timePolicyFields").disabled, true);
  await h.$("timePolicyForm").onsubmit({ preventDefault() {} });
  assert.equal(h.requests.length, 1);
});
