import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { handleManagerInactivity } from "../.tmp-test/inactivity.js";
import { handleManagerTimePolicy } from "../.tmp-test/time-policy.js";
import { handleManagerWorkingHours } from "../.tmp-test/working-hours.js";

const endpoints = [
  {
    name: "working hours", handle: handleManagerWorkingHours, table: "org_working_hours",
    body: { schedule: { mode: "scheduled", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } },
  },
  {
    name: "inactivity", handle: handleManagerInactivity, table: "org_inactivity",
    body: { policy: { timeout_secs: 900, warning_secs: 60 } },
  },
  {
    name: "time policy", handle: handleManagerTimePolicy, table: "org_time_policy",
    body: { paidLunchMinutes: 30, lunchMinMinutes: 20, lunchMaxMinutes: 90, longBreakMinutes: 15,
      overtime: { mode: "disabled" } },
  },
];

for (const { name, handle, table, body } of endpoints) {
  test(`${name} only permits exact owner/admin roles in the requested organization`, async (t) => {
    const { DB, sqlite } = testDatabase();
    t.after(() => sqlite.close());
    sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('actor', 'Actor', 'actor@example.test', 1, 1, 1);
      INSERT INTO organization (id, name, slug, createdAt)
        VALUES ('a', 'Acme', 'acme', 1), ('b', 'Other', 'other', 1);
      INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES ('membership', 'a', 'actor', 'member', 1);`);
    const request = (method, organizationId = "a", actorId = "actor") => handle(
      new Request(`https://example.test/api/team/settings?organizationId=${organizationId}`, {
        method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }), { DB }, actorId,
    );

    for (const role of ["member", "superadmin", "ownerish", "Admin", "", "member, admin-helper"]) {
      sqlite.prepare("UPDATE member SET role = ?").run(role);
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await request(method);
        assert.equal(response.status, 403, `${role}: ${method}`);
        assert.deepEqual(await response.json(), { error: "forbidden" });
      }
      assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }

    for (const role of ["owner", "admin", "member, admin", " member , owner , admin "]) {
      sqlite.prepare("UPDATE member SET role = ?").run(role);
      assert.equal((await request("POST")).status, 200, role);
      const response = await request("GET");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), name === "time policy" ? { policy: body } : body);
      const unsupported = await request("DELETE");
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get("Allow"), "GET, POST");
      assert.deepEqual(await unsupported.json(), { error: "method not allowed" });
      for (const orgId of ["b", "missing", ""]) {
        for (const method of ["GET", "POST"]) {
          assert.equal((await request(method, orgId)).status, 403);
        }
      }
      assert.equal((await request("GET", "a", "outsider")).status, 403);
    }
  });
}
