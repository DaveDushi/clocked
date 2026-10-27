import assert from "node:assert/strict";

// Uses the isolated, authenticated Worker fixture in verify-working-hours.mjs.
export async function verifyWorkerPermissions(base, cookies) {
  const request = (actor, path, method = "GET", body) => fetch(base + path, {
    method, headers: { cookie: cookies[actor], origin: base, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const settings = "/api/team/worker-permissions?organizationId=acme";
  const entry = { date: "2026-09-15", start: "09:00", end: "10:00" };
  assert.equal((await request("employee", settings, "POST", { permission: "full" })).status, 403);
  assert.equal((await request("other-manager", settings, "POST", { permission: "full" })).status, 403);
  assert.deepEqual(await (await request("manager", settings)).json(), { permission: "none" });
  for (const permission of ["full", "add_only", "none"]) {
    assert.equal((await request("manager", settings, "POST", { permission })).status, 200);
    const me = await (await request("employee", "/api/me")).json();
    assert.equal(me.editPermission, permission);
    assert.equal(me.canAddTimes, permission !== "none");
    assert.equal(me.canEditTimes, permission === "full");
    assert.equal((await request("employee", "/api/manual-session", "POST", entry)).status, permission === "none" ? 403 : 200);
    const sessions = await (await request("employee", "/api/manual-session?period=2026-09")).json();
    const id = sessions.entries[0].id;
    const edit = await request("employee", "/api/manual-session", "PATCH", { ...entry, id, end: "11:00" });
    assert.equal(edit.status, permission === "full" ? 200 : 403);
    const replacementId = edit.ok ? (await edit.json()).id : id;
    assert.equal((await request("employee", "/api/manual-session", "DELETE", { id: replacementId })).status,
      permission === "full" ? 200 : 403);
    // A worker cannot use the manager route or another worker's ID to bypass restrictions.
    assert.equal((await request("employee", "/api/team/manual-session?organizationId=acme&userId=manager", "POST", entry)).status, 403);
    assert.equal((await request("manager", "/api/team/manual-session?organizationId=acme&userId=employee", "POST", entry)).status, 200);
  }
  // Leave the original default for subsequent verification and browser inspection.
  assert.equal((await request("manager", settings, "POST", { permission: "none" })).status, 200);
  console.log("PASS: worker permissions persist and enforce add/edit/delete through real authenticated API requests.");
}
