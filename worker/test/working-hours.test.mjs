import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { effectiveWorkingHours, handleManagerWorkingHours, parseWorkingHours } from "../.tmp-test/working-hours.js";
import { orgIdForUser } from "../.tmp-test/settings.js";
import { listDeliveries } from "../.tmp-test/delivery.js";

const teamHours = { mode: "scheduled", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
const partTime = { mode: "scheduled", start: "10:00", end: "14:00", days: [1, 3, 5] };

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  for (const id of ["owner", "worker", "outsider", "otherOwner", "solo"]) {
    sqlite.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)`)
      .run(id, id, id + "@example.test");
  }
  sqlite.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('a', 'Acme', 'acme', 1), ('b', 'Other', 'other', 1);
    UPDATE organization SET metadata = '{"plan":"team"}';
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
    ('ma', 'a', 'owner', 'owner', 1), ('mw', 'a', 'worker', 'member', 1),
    ('mb', 'b', 'otherOwner', 'owner', 1), ('mx', 'b', 'outsider', 'member', 1);`);
  const env = { DB };
  const request = (actor, schedule, target = "", org = "a", method = "POST") => handleManagerWorkingHours(
    new Request(`https://example.test/api/team/working-hours?organizationId=${org}${target ? "&userId=" + target : ""}`, {
      method, ...(method === "POST" ? { body: JSON.stringify({ schedule }) } : {}),
    }), env, actor,
  );
  return { env, sqlite, request };
}

test("team defaults, per-person override, reset and disabled prompt round-trip through real SQL", async (t) => {
  const { env, request } = fixture(t);
  assert.equal((await request("owner", teamHours)).status, 200);
  assert.deepEqual(await effectiveWorkingHours(env, "worker"), { schedule: teamHours, source: "team", organizationName: "Acme" });
  assert.equal((await request("owner", partTime, "worker")).status, 200);
  assert.deepEqual(await effectiveWorkingHours(env, "worker"), { schedule: partTime, source: "member", organizationName: "Acme" });
  await request("owner", { mode: "disabled" });
  assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, partTime);
  await request("owner", null, "worker");
  assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, { mode: "disabled" });
  await request("owner", null);
  assert.deepEqual(await effectiveWorkingHours(env, "worker"), { schedule: null, source: "personal", organizationName: "Acme" });
  assert.deepEqual(await effectiveWorkingHours(env, "solo"), { schedule: null, source: "personal", organizationName: null });
});

test("members and managers of another team cannot read or change schedules", async (t) => {
  const { request, env } = fixture(t);
  for (const actor of ["worker", "outsider", "otherOwner", "solo"]) {
    assert.equal((await request(actor, teamHours)).status, 403);
    assert.equal((await request(actor, null, "worker", "a", "GET")).status, 403);
  }
  assert.equal((await request("owner", partTime, "outsider")).status, 403);
  assert.equal((await request("owner", partTime, "worker", "b")).status, 403);
  assert.equal((await effectiveWorkingHours(env, "worker")).schedule, null);
});

test("invalid schedules fail without replacing the assigned schedule", async (t) => {
  const { request, env } = fixture(t);
  await request("owner", teamHours);
  for (const schedule of [{}, { ...teamHours, start: "25:00" }, { ...teamHours, end: "09:00" },
    { ...teamHours, days: [] }, { ...teamHours, days: [0] }, { ...teamHours, days: [1, 1] },
    { ...teamHours, days: ["1"] }, { ...teamHours, days: [1.5] }]) {
    assert.equal((await request("owner", schedule)).status, 400);
    assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, teamHours);
  }
  assert.deepEqual(parseWorkingHours({ ...teamHours, days: [5, 1] }).days, [1, 5]);
});

test("removing a membership clears its override and rejoining inherits the team", async (t) => {
  const { env, sqlite, request } = fixture(t);
  await request("owner", teamHours);
  await request("owner", partTime, "worker");
  sqlite.exec("DELETE FROM member WHERE id = 'mw'");
  assert.equal((await effectiveWorkingHours(env, "worker")).schedule, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member_working_hours").get().n, 0);
  sqlite.exec("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('new', 'a', 'worker', 'member', 2)");
  assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, teamHours);
});

test("earliest membership wins consistently when a person belongs to multiple teams", async (t) => {
  const { env, sqlite, request } = fixture(t);
  await request("owner", teamHours);
  await request("otherOwner", partTime, "", "b");
  sqlite.exec("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('second', 'b', 'worker', 'member', 2)");
  assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, teamHours);
});

test("tied membership dates select the same team for working hours and report delivery", async (t) => {
  const { env, sqlite, request } = fixture(t);
  await request("owner", teamHours);
  await request("otherOwner", partTime, "", "b");
  sqlite.exec(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('aa', 'b', 'worker', 'member', 1);
    INSERT INTO org_settings (organizationId, send_day, send_time, send_timezone) VALUES
    ('a', 5, '06:00', 'UTC'), ('b', 12, '08:00', 'Europe/Berlin');`);
  assert.deepEqual((await effectiveWorkingHours(env, "worker")).schedule, partTime);
  assert.equal(await orgIdForUser(env, "worker"), "b");
  assert.deepEqual((await listDeliveries(env)).find((user) => user.id === "worker").schedule,
    { day: 12, time: "08:00", timezone: "Europe/Berlin" });
});
