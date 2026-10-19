import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { effectiveInactivity, handleManagerInactivity } from "../.tmp-test/inactivity.js";

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  for (const id of ["owner", "admin", "worker", "outsider", "solo"]) {
    sqlite.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)")
      .run(id, id, id + "@example.test");
  }
  sqlite.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('a', 'Acme', 'acme', 1), ('b', 'Other', 'other', 1);
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
    ('mo', 'a', 'owner', 'owner', 1), ('ma', 'a', 'admin', 'admin', 1),
    ('mw', 'a', 'worker', 'member', 1), ('mx', 'b', 'outsider', 'owner', 1);`);
  const env = { DB };
  const request = (actor, policy, method = "POST", org = "a") => handleManagerInactivity(
    new Request(`https://example.test/api/team/inactivity?organizationId=${org}`, {
      method, ...(method === "POST" ? { body: JSON.stringify({ policy }) } : {}),
    }), env, actor);
  return { request, env, sqlite };
}

test("owners and admins save team limits and warnings; reset restores personal settings", async (t) => {
  const { request, env } = fixture(t);
  assert.deepEqual(await effectiveInactivity(env, "worker"), null);
  const policy = { timeout_secs: 1800, warning_secs: 300 };
  assert.deepEqual(await (await request("owner", policy)).json(), { policy });
  assert.deepEqual(await effectiveInactivity(env, "worker"), policy);
  assert.deepEqual(await (await request("admin", undefined, "GET")).json(), { policy });
  assert.equal((await request("admin", { timeout_secs: 60, warning_secs: 0 })).status, 200);
  assert.deepEqual(await effectiveInactivity(env, "worker"), { timeout_secs: 60, warning_secs: 0 });
  await request("owner", null);
  assert.equal(await effectiveInactivity(env, "worker"), null);
  assert.equal(await effectiveInactivity(env, "solo"), null);
});

test("members and other teams cannot read or change the policy", async (t) => {
  const { request, env } = fixture(t);
  for (const actor of ["worker", "outsider", "solo"]) {
    assert.equal((await request(actor, { timeout_secs: 900, warning_secs: 120 })).status, 403);
    assert.equal((await request(actor, undefined, "GET")).status, 403);
  }
  assert.equal(await effectiveInactivity(env, "worker"), null);
  assert.equal((await request("owner", undefined, "DELETE")).status, 405);
});

test("invalid policies preserve the last assignment", async (t) => {
  const { request, env } = fixture(t);
  const policy = { timeout_secs: 900, warning_secs: 120 };
  await request("owner", policy);
  for (const invalid of [{}, { ...policy, timeout_secs: 0 }, { ...policy, timeout_secs: 86401 },
    { ...policy, timeout_secs: 60.5 }, { ...policy, warning_secs: -1 }, { ...policy, warning_secs: 900 },
    { ...policy, warning_secs: "120" }, { ...policy, warning_secs: 1.5 }]) {
    assert.equal((await request("owner", invalid)).status, 400);
    assert.deepEqual(await effectiveInactivity(env, "worker"), policy);
  }
});

test("earliest membership selects policy and leaving removes the assignment", async (t) => {
  const { request, env, sqlite } = fixture(t);
  await request("owner", { timeout_secs: 900, warning_secs: 120 });
  await request("outsider", { timeout_secs: 600, warning_secs: 60 }, "POST", "b");
  sqlite.exec("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('aa', 'b', 'worker', 'member', 1)");
  assert.deepEqual(await effectiveInactivity(env, "worker"), { timeout_secs: 600, warning_secs: 60 });
  sqlite.exec("DELETE FROM member WHERE userId = 'worker'");
  assert.equal(await effectiveInactivity(env, "worker"), null);
});
