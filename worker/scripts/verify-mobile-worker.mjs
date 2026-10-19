import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const iosFixture = JSON.parse(readFileSync(new URL("../test/fixtures/ios-zone-series.json", import.meta.url), "utf8"));
// Exercise the production bundle, actual workerd D1, and cookie/bearer routes.
const secret = randomBytes(48).toString("hex");
const origin = "https://clocked.test";
const mf = new Miniflare({
  modules: ["index.js", ...readdirSync(new URL("../dist/clocked/assets/", import.meta.url))
    .filter((name) => name.endsWith(".js")).map((name) => `assets/${name}`)]
    .map((name) => ({ type: "ESModule", path: fileURLToPath(new URL(`../dist/clocked/${name}`, import.meta.url)) })),
  compatibilityDate: "2026-07-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  bindings: { REPORT_TZ: "Europe/Berlin", BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret },
});
try {
  const db = await mf.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(name, migrations), "utf8").replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s));
    await db.batch(statements);
  }
  const cookies = {};
  const tokens = {};
  for (const user of ["alice", "bob"]) {
    const now = Date.now();
    const token = `clk_${randomBytes(24).toString("base64url")}`;
    tokens[user] = token;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const login = randomBytes(24).toString("hex");
    const signature = createHmac("sha256", secret).update(login).digest("base64");
    cookies[user] = `__Secure-better-auth.session_token=${encodeURIComponent(`${login}.${signature}`)}`;
    await db.batch([
      db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)").bind(user, user, `${user}@example.test`, now, now),
      db.prepare("INSERT INTO complimentary_access (email, createdAt) VALUES (?, ?)").bind(`${user}@example.test`, now),
      db.prepare("INSERT INTO api_token (token, token_hash, userId, createdAt, id) VALUES (?, ?, ?, ?, ?)").bind(`h:${tokenHash}`, tokenHash, user, new Date().toISOString(), user),
      db.prepare("INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").bind(user, login, user, now + 86400_000, now, now),
    ]);
  }
  async function post(path, user, body) {
    return mf.dispatchFetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async function hours(user, query = "") {
    const res = await mf.dispatchFetch(origin + "/api/hours?period=2026-06" + query, { headers: { cookie: cookies[user] } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "no-store");
    return res.json();
  }
  const desktop = { id: "runtime-desktop", start_utc: "2026-06-01T07:00:00.123456789+00:00", end_utc: "2026-06-01T10:00:00.123456789+00:00", timezone: "Europe/Berlin", start_reason: "app", end_reason: "app" };
  const android = { ...desktop, id: "runtime-android", start_utc: "2026-06-01T08:00:00Z", end_utc: "2026-06-01T11:00:00Z" };
  assert.equal((await post("/sessions", "alice", { sessions: [desktop, android, android] })).status, 200);
  const storedDesktop = await db.prepare("SELECT start_utc, end_utc FROM sessions WHERE id = ?").bind(desktop.id).first();
  assert.deepEqual(storedDesktop, { start_utc: "2026-06-01T07:00:00.123Z", end_utc: "2026-06-01T10:00:00.123Z" });
  const snap = iosFixture.snapshots[0];
  const responses = await Promise.all([900, 300, 1200, 600].map((duration_seconds) => post("/mobile/usage", "alice", { snapshots: [{ ...snap, duration_seconds }] })));
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200]);
  for (const res of responses) assert.deepEqual(await res.json(), { accepted: [snap.id] });
  const storedSeries = await db.prepare("SELECT selection_id, duration_seconds FROM mobile_usage WHERE user_id = ? AND device_id = ?")
    .bind("alice", snap.device_id).first();
  assert.deepEqual(storedSeries, { selection_id: "0f3a9c2e-1111-4222-8333-944455556666-z31405cd4", duration_seconds: 1200 });
  await post("/mobile/usage", "alice", { snapshots: [
    { ...snap, id: "another-zone", selection_id: "0f3a9c2e-1111-4222-8333-944455556666-z1234abcd", timezone: "America/New_York", duration_seconds: 1000 },
    { ...snap, id: "another-device", device_id: "iphone-two", duration_seconds: 800 },
  ] });
  await post("/mobile/usage", "bob", { snapshots: [{ ...snap, duration_seconds: 7200 }] });
  const alice = await hours("alice", "&userId=bob");
  assert.equal(alice.totalMinutes, 240);
  assert.equal(alice.days.find((d) => d.date === "2026-06-01").minutes, 240);
  assert.equal(alice.screenTime.largestDeviceSeconds, 1200);
  assert.equal(alice.screenTime.devices.length, 2);
  const bob = await hours("bob");
  assert.equal(bob.totalMinutes, 0);
  assert.equal(bob.screenTime.largestDeviceSeconds, 7200);
  const preview = await mf.dispatchFetch(origin + "/preview?period=2026-06", { headers: { cookie: cookies.alice } });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /,,,Total,4:00/);
  const exported = await mf.dispatchFetch(origin + "/api/export", { headers: { cookie: cookies.alice } });
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).screenTime.length, 3);
  const deleted = await mf.dispatchFetch(origin + "/api/manual-session", { method: "DELETE", headers: { cookie: cookies.alice, origin, "content-type": "application/json" }, body: JSON.stringify({ id: android.id }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const retry = await post("/sessions", "alice", { sessions: [android] });
  assert.deepEqual((await retry.json()).accepted, [android.id]);
  assert.equal((await hours("alice")).totalMinutes, 180);
  const wiped = await mf.dispatchFetch(origin + "/api/account/delete", { method: "POST", headers: { cookie: cookies.alice, origin, "content-type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }) });
  assert.equal(wiped.status, 200, await wiped.clone().text());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mobile_usage WHERE user_id = 'alice'").first()).n, 0);
  assert.equal((await post("/mobile/usage", "alice", { snapshots: [snap] })).status, 401);
  assert.equal((await hours("bob")).screenTime.largestDeviceSeconds, 7200);
  console.log("Production workerd/D1 verification passed: authenticated routes, concurrent snapshots, account isolation, 240-minute interval union, CSV, export, deletion, retries, token revocation.");
} finally {
  await mf.dispose();
}
