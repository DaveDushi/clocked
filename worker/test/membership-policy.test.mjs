import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { orgIdForUser } from "../.tmp-test/settings.js";
import { getEffectiveDelivery, listDeliveries, handleDeliverySettings } from "../.tmp-test/delivery.js";
import { effectiveWorkingHours } from "../.tmp-test/working-hours.js";
import { effectiveInactivity } from "../.tmp-test/inactivity.js";
import { getPrimaryMembership, selectPrimaryMembership } from "../.tmp-test/memberships.js";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { runInNewContext } from "node:vm";

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES
    ('legacy','Legacy','legacy@example.test',1,1,1), ('manager','Manager','manager@example.test',1,1,1);
    INSERT INTO organization (id,name,slug,createdAt,metadata) VALUES
    ('personal','Personal','personal',1,'{"plan":"single"}'), ('team','Team','team',2,'{"plan":"team"}');
    INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES
    ('legacy-owner','personal','legacy','owner',1), ('joined-team','team','legacy','member',2),
    ('manager-team','team','manager','owner',1);
    INSERT INTO org_settings (organizationId,mail_to,send_day,send_time,send_timezone) VALUES
    ('personal','personal@example.test',1,'06:00','UTC'), ('team','team@example.test',12,'09:30','Europe/Berlin');
    INSERT INTO org_working_hours (organizationId,schedule) VALUES
    ('personal','{"mode":"disabled"}'), ('team','{"mode":"scheduled","start":"09:00","end":"17:00","days":[1,2,3,4,5]}');
    INSERT INTO org_inactivity (organizationId,timeout_secs,warning_secs) VALUES
    ('personal',900,60), ('team',1800,120);`);
  return { env: { DB }, sqlite };
}

test("a legacy personal owner joining a team uses the team for all effective settings", async (t) => {
  const { env } = fixture(t);
  assert.equal(await orgIdForUser(env, "legacy"), "team");
  const expected = { recipients: ["team@example.test"], schedule: { day: 12, time: "09:30", timezone: "Europe/Berlin" }, managed: true };
  assert.deepEqual(await getEffectiveDelivery(env, { userId: "legacy", email: "legacy@example.test" }), expected);
  assert.deepEqual((await listDeliveries(env)).find((d) => d.id === "legacy"), { id: "legacy", email: "legacy@example.test", ...expected });
  assert.deepEqual(await effectiveWorkingHours(env, "legacy"), { schedule: { mode: "scheduled", start: "09:00", end: "17:00", days: [1,2,3,4,5] }, source: "team", organizationName: "Team" });
  assert.deepEqual(await effectiveInactivity(env, "legacy"), { timeout_secs: 1800, warning_secs: 120 });
  const response = await handleDeliverySettings(new Request("https://example.test/api/settings", { method: "POST", body: JSON.stringify({ recipients: ["changed@example.test"] }) }), env, { kind: "personal", userId: "legacy", email: "legacy@example.test" });
  assert.equal(response.status, 403);
});

test("leaving the real team restores legacy personal settings", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec("DELETE FROM member WHERE id = 'joined-team'");
  assert.equal(await orgIdForUser(env, "legacy"), "personal");
  assert.deepEqual((await getEffectiveDelivery(env, { userId: "legacy", email: "legacy@example.test" })).recipients, ["personal@example.test"]);
  assert.deepEqual((await effectiveWorkingHours(env, "legacy")).schedule, { mode: "disabled" });
  assert.deepEqual(await effectiveInactivity(env, "legacy"), { timeout_secs: 900, warning_secs: 60 });
});

test("real teams keep earliest membership and id ties across SQL and the serialized client", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec(`INSERT INTO organization (id,name,slug,createdAt,metadata) VALUES
    ('other','Other','other',1,'{"plan":"enterprise"}');
    INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES
    ('aa','other','legacy','owner',2);`);
  assert.equal((await getPrimaryMembership(env, "legacy")).organizationId, "other");
  const memberships = [
    { id: "legacy-owner", plan: "single", role: "owner", createdAt: "1970-01-01T00:00:00.001Z" },
    { id: "joined-team", plan: "team", role: "member", createdAt: "1970-01-01T00:00:00.002Z" },
    { id: "aa", plan: "enterprise", role: "owner", createdAt: "1970-01-01T00:00:00.002Z" },
  ];
  assert.equal(selectPrimaryMembership(memberships).id, "aa");
  const html = await dashboardResponse().text();
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const selector = script.slice(script.indexOf("const wsPrimaryMembership ="), script.indexOf("const ws ="));
  assert.equal(runInNewContext(selector + "; wsPrimaryMembership(memberships).id", { memberships }), "aa");
  assert.equal(runInNewContext(selector + "; wsPrimaryMembership(memberships.slice(0,2)).role", { memberships }), "member");
});

test("membership dates normalize numeric milliseconds and SQL timestamps before client selection", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec(`UPDATE member SET createdAt = '2026-10-20 09:00:00' WHERE id = 'joined-team'`);
  assert.equal((await getPrimaryMembership(env, "legacy")).createdAt, "2026-10-20T09:00:00.000Z");
});
