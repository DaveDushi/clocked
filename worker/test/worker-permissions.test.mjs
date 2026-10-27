import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { canMutateSessions, getSelfEditPermission, handleWorkerPermissions } from "../.tmp-test/worker-permissions.js";

test("team managers control worker changes, with none by default and separate team settings", async (t) => {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('manager', 'Manager', 'manager@test.dev', 1, 1, 1), ('worker', 'Worker', 'worker@test.dev', 1, 1, 1),
      ('solo', 'Solo', 'solo@test.dev', 1, 1, 1);
    INSERT INTO organization (id, name, slug, metadata, createdAt)
    VALUES ('a', 'A', 'a', '{"plan":"team"}', 1), ('b', 'B', 'b', '{"plan":"team"}', 1);
    INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('manager-a', 'a', 'manager', 'owner', 1), ('worker-a', 'a', 'worker', 'member', 1);`);
  const env = { DB };
  const request = (actor, method, body, org = "a") => handleWorkerPermissions(new Request(
    `https://clocked.test/api/team/worker-permissions?organizationId=${org}`,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  ), env, actor);
  assert.deepEqual(await (await request("manager", "GET")).json(), { permission: "none" });
  assert.equal(await getSelfEditPermission(env, "worker"), "none");
  assert.equal(await getSelfEditPermission(env, "solo"), "full");
  for (const [permission, expected] of [["none", [false, false, false]], ["add_only", [true, false, false]], ["full", [true, true, true]]]) {
    assert.equal((await request("manager", "POST", { permission })).status, 200);
    assert.deepEqual(await (await request("manager", "GET")).json(), { permission });
    const effective = await getSelfEditPermission(env, "worker");
    assert.equal(effective, permission);
    assert.deepEqual(["POST", "PATCH", "DELETE"].map(method => canMutateSessions(effective, method)), expected);
    assert.equal(await getSelfEditPermission(env, "manager"), "full");
    assert.equal((await request("worker", "POST", { permission: "full" })).status, 403);
    assert.equal((await request("manager", "POST", { permission }, "b")).status, 403);
  }
  for (const value of [null, {}, { permission: "bogus" }, { permission: true }]) {
    assert.equal((await request("manager", "POST", value)).status, 400);
    assert.equal(await getSelfEditPermission(env, "worker"), "full");
  }
  assert.equal((await request("worker", "GET")).status, 403);
  assert.equal((await request("manager", "DELETE")).status, 405);
  sqlite.prepare("UPDATE member SET role = 'superadmin' WHERE id = 'manager-a'").run();
  assert.equal((await request("manager", "GET")).status, 403);
});
