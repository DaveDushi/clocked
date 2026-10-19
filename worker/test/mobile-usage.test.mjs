import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ingestMobileUsage, handleMobileUsage, mobileUsageForPeriod } from "../.tmp-test/mobile-usage.js";
import { generateToken, hashToken, userIdForToken } from "../.tmp-test/tokens.js";
import { buildHoursReport, buildReportCsv } from "../.tmp-test/report.js";
import { sqliteEnv } from "./sqlite-env.mjs";

const selection = "11111111-2222-4333-8444-555555555555";
const otherSelection = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const iosFixture = JSON.parse(readFileSync(new URL("./fixtures/ios-zone-series.json", import.meta.url), "utf8"));
function snapshot(overrides = {}) {
  return { id: "snapshot-1", device_id: "iphone-1", platform: "ios", day: "2026-06-01",
    timezone: "Europe/Berlin", selection_id: selection, duration_seconds: 600, ...overrides };
}
function request(snapshots, headers = {}) {
  return new Request("https://clocked.test/mobile/usage", { method: "POST", headers,
    body: JSON.stringify({ snapshots }) });
}

test("actual iOS timezone series fixture ingests, retries and remains a maximum across series", async (t) => {
  const env = sqliteEnv(t);
  const row = iosFixture.snapshots[0];
  assert.equal(row.selection_id, "0f3a9c2e-1111-4222-8333-944455556666-z31405cd4");
  for (const seconds of [900, 1200, 300]) {
    const response = await ingestMobileUsage(request([{ ...row, duration_seconds: seconds }]), env, "alice");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: [row.id] });
  }
  const secondSeries = { ...row, id: "second-zone", selection_id: row.selection_id.replace(/-z[0-9a-f]{8}$/, "-z1234abcd"), timezone: "America/New_York", duration_seconds: 1000 };
  assert.equal((await ingestMobileUsage(request([secondSeries]), env, "alice")).status, 200);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 2);
  const report = await mobileUsageForPeriod(env, "alice", "2026-06");
  assert.equal(report.largestDeviceSeconds, 1200);
  assert.deepEqual(report.devices, [{ day: row.day, deviceId: row.device_id, durationSeconds: 1200 }]);
  assert.equal((await buildHoursReport(env, "2026-06", "alice")).totalMinutes, 0);
});

test("opaque selection IDs accept legacy bases and optional zone tags within 128 characters", async (t) => {
  const env = sqliteEnv(t);
  const accepted = [selection, `${selection}-z31405cd4`, "a".repeat(32), `${"a".repeat(32)}-z31405cd4`, "a".repeat(128), `${"a".repeat(118)}-z31405cd4`];
  const rejected = [`${"a".repeat(119)}-z31405cd4`, `${selection}-z31405cd`, `${selection}-z31405cd44`, `${selection}-z31405cg4`, `${selection}-z31405cd4-z1234abcd`, "com.example.work", "com.example.work-z31405cd4", "selection-name-z31405cd4"];
  for (const selection_id of accepted) {
    const response = await ingestMobileUsage(request([snapshot({ selection_id })]), env, "alice");
    assert.equal(response.status, 200, selection_id);
  }
  for (const selection_id of rejected) {
    const response = await ingestMobileUsage(request([snapshot({ selection_id })]), env, "alice");
    assert.equal(response.status, 400, selection_id);
    assert.deepEqual((await response.json()).accepted, []);
  }
});

test("duplicate, increasing and stale updates converge to one monotonic snapshot", async (t) => {
  const env = sqliteEnv(t);
  for (const seconds of [600, 600, 1200, 300]) {
    const res = await ingestMobileUsage(request([snapshot({ duration_seconds: seconds })]), env, "alice");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: ["snapshot-1"] });
  }
  assert.deepEqual(env.sqlite.prepare("SELECT duration_seconds FROM mobile_usage").all().map((r) => r.duration_seconds), [1200]);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal((await buildHoursReport(env, "2026-06", "alice")).totalMinutes, 0);
  assert.equal(await buildReportCsv(env, "2026-06", "alice"), "");
});

test("selections and devices use maxima, accounts and days stay separate", async (t) => {
  const env = sqliteEnv(t);
  const res = await ingestMobileUsage(request([
    snapshot(), snapshot({ id: "changed-selection", selection_id: otherSelection, duration_seconds: 900 }),
    snapshot({ id: "second-device", device_id: "iphone-2", duration_seconds: 800 }),
    snapshot({ id: "tomorrow", day: "2026-06-02", duration_seconds: 300 }),
  ]), env, "alice");
  assert.equal(res.status, 200);
  await ingestMobileUsage(request([snapshot({ duration_seconds: 7200 })]), env, "bob");
  const report = await mobileUsageForPeriod(env, "alice", "2026-06");
  assert.equal(report.largestDeviceSeconds, 1200);
  assert.deepEqual(report.days, [{ day: "2026-06-01", durationSeconds: 900 }, { day: "2026-06-02", durationSeconds: 300 }]);
  assert.deepEqual(report.deviceTotals, [{ deviceId: "iphone-1", durationSeconds: 1200 }, { deviceId: "iphone-2", durationSeconds: 800 }]);
  assert.equal((await mobileUsageForPeriod(env, "bob", "2026-06")).largestDeviceSeconds, 7200);
  assert.equal((await mobileUsageForPeriod(env, "alice", "2026-07")).largestDeviceSeconds, 0);
});

test("atomic MAX converges for concurrent requests in either order", async (t) => {
  const env = sqliteEnv(t);
  await Promise.all([100, 500, 200, 0, 400].map((duration_seconds) =>
    ingestMobileUsage(request([snapshot({ duration_seconds })]), env, "alice")));
  assert.equal((await mobileUsageForPeriod(env, "alice", "2026-06")).largestDeviceSeconds, 500);
});

test("timezone cannot relabel an existing selection bucket; rejected rows are not acknowledged", async (t) => {
  const env = sqliteEnv(t);
  await ingestMobileUsage(request([snapshot()]), env, "alice");
  const res = await ingestMobileUsage(request([snapshot({ timezone: "America/New_York", duration_seconds: 1000 })]), env, "alice");
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { accepted: [] });
  const stored = env.sqlite.prepare("SELECT timezone, duration_seconds FROM mobile_usage").get();
  assert.deepEqual({ ...stored }, { timezone: "Europe/Berlin", duration_seconds: 600 });
});

test("validation rejects invalid dates, zones, durations, app identifiers and app details", async (t) => {
  const env = sqliteEnv(t);
  const invalid = [null, 3, {}, snapshot({ platform: "android" }), snapshot({ day: "2026-02-30" }),
    snapshot({ timezone: "Not/AZone" }), snapshot({ timezone: "+01:00" }), snapshot({ duration_seconds: -1 }), snapshot({ duration_seconds: 0.5 }),
    snapshot({ duration_seconds: "600" }), snapshot({ duration_seconds: 90001 }),
    snapshot({ day: "2099-01-01" }), snapshot({ day: "2020-01-01" }), snapshot({ selection_id: "com.example.work" }),
    snapshot({ app: "Mail" }), snapshot({ applications: ["com.example.work"] }), snapshot({ device_id: "<x>" })];
  for (const row of invalid) {
    const res = await ingestMobileUsage(request([row]), env, "alice");
    assert.equal(res.status, 400, JSON.stringify(row));
    assert.deepEqual((await res.json()).accepted, []);
  }
  const partial = await ingestMobileUsage(request([snapshot({ duration_seconds: 0 }), ...invalid]), env, "alice");
  assert.equal(partial.status, 200);
  assert.deepEqual(await partial.json(), { accepted: ["snapshot-1"] });
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 1);
});

test("validation bounds snapshots by actual DST day length and handles month boundaries", async (t) => {
  const env = sqliteEnv(t);
  const spring = snapshot({ day: "2026-03-29", duration_seconds: 82800 });
  assert.equal((await ingestMobileUsage(request([spring]), env, "alice")).status, 200);
  assert.equal((await ingestMobileUsage(request([{ ...spring, duration_seconds: 82801 }]), env, "alice")).status, 400);
  assert.equal((await ingestMobileUsage(request([snapshot({ day: "2025-10-26", duration_seconds: 90000 })]), env, "alice")).status, 200);
  assert.equal((await ingestMobileUsage(request([snapshot({ day: "2026-04-05", timezone: "Pacific/Auckland", duration_seconds: 90000 })]), env, "alice")).status, 200);
  await ingestMobileUsage(request([snapshot({ day: "2026-05-31" }), snapshot({ day: "2026-06-01" })]), env, "alice");
  assert.equal((await mobileUsageForPeriod(env, "alice", "2026-05")).largestDeviceSeconds, 600);
  assert.equal((await mobileUsageForPeriod(env, "alice", "2026-06")).largestDeviceSeconds, 600);
});

test("malformed bodies and bounded batches fail without writes", async (t) => {
  const env = sqliteEnv(t);
  for (const body of ["null", "{}", "{", "[]", '{"snapshots":null}']) {
    assert.equal((await ingestMobileUsage(new Request("https://clocked.test/mobile/usage", { method: "POST", body }), env, "alice")).status, 400);
  }
  assert.equal((await ingestMobileUsage(new Request("https://clocked.test/mobile/usage", {
    method: "POST", body: JSON.stringify({ snapshots: [snapshot()], app: "Mail" }),
  }), env, "alice")).status, 400);
  assert.equal((await ingestMobileUsage(request(Array(501).fill(snapshot())), env, "alice")).status, 413);
  const large = new Request("https://clocked.test/mobile/usage", { method: "POST", body: " ".repeat(512 * 1024 + 1) });
  assert.equal((await ingestMobileUsage(large, env, "alice")).status, 413);
  assert.deepEqual(await (await ingestMobileUsage(request([]), env, "alice")).json(), { accepted: [] });
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 0);
});

async function tokenFor(env, userId) {
  const token = generateToken();
  env.sqlite.prepare("INSERT INTO api_token (token, token_hash, userId, createdAt, id) VALUES (?, ?, ?, ?, ?)")
    .run(`h:${await hashToken(token)}`, await hashToken(token), userId, new Date().toISOString(), crypto.randomUUID());
  return token;
}

test("bearer route enforces authentication, revocation, product access and account ownership", async (t) => {
  const env = sqliteEnv(t);
  for (const authorization of [undefined, "Bearer legacy-global-secret", "Basic clk_whatever", "Bearer clk_unknown"]) {
    assert.equal((await handleMobileUsage(request([snapshot()], authorization ? { authorization } : {}), env)).status, 401);
  }
  const unpaid = await tokenFor(env, "unpaid");
  assert.equal((await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${unpaid}` }), env)).status, 402);
  const alice = await tokenFor(env, "alice");
  assert.equal((await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${alice}` }), env)).status, 200);
  assert.deepEqual(env.sqlite.prepare("SELECT user_id FROM mobile_usage").all().map((r) => r.user_id), ["alice"]);
  env.sqlite.prepare("DELETE FROM api_token WHERE userId = 'alice'").run();
  assert.equal((await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${alice}` }), env)).status, 401);
});

test("durable rate guard blocks requests before ingest", async (t) => {
  const env = sqliteEnv(t);
  env.sqlite.prepare("INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 60, ?)").run("mobile-usage:unknown", Date.now() + 60_000);
  assert.equal((await handleMobileUsage(request([snapshot()]), env)).status, 429);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 0);
  env.sqlite.prepare("DELETE FROM rate_limit").run();
  const token = await tokenFor(env, "alice");
  env.sqlite.prepare("INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 120, ?)").run("mobile-usage:user:alice", Date.now() + 60_000);
  assert.equal((await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${token}` }), env)).status, 429);
});

test("a token revoked after authentication cannot write a snapshot", async (t) => {
  const env = sqliteEnv(t);
  const token = await tokenFor(env, "alice");
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    env.sqlite.prepare("DELETE FROM api_token WHERE userId = 'alice'").run();
    return batch(statements);
  };
  const response = await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${token}` }), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { accepted: [] });
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 0);
});

test("legacy token upgrades preserve identity and cannot recreate a concurrently revoked token", async (t) => {
  const env = sqliteEnv(t);
  const token = generateToken();
  env.sqlite.prepare("INSERT INTO api_token (token, userId, createdAt, id, name) VALUES (?, 'alice', 'original-created', 'original-id', 'Phone')").run(token);
  assert.equal(await userIdForToken(env, token), "alice");
  assert.deepEqual({ ...env.sqlite.prepare("SELECT id, name, createdAt, token_hash FROM api_token").get() }, {
    id: "original-id", name: "Phone", createdAt: "original-created", token_hash: await hashToken(token),
  });
  env.sqlite.prepare("DELETE FROM api_token").run();
  env.sqlite.prepare("INSERT INTO api_token (token, userId, createdAt, id) VALUES (?, 'alice', 'original-created', 'original-id')").run(token);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes("UPDATE api_token SET token =")) env.sqlite.prepare("DELETE FROM api_token").run();
    return prepare(sql);
  };
  const res = await handleMobileUsage(request([snapshot()], { authorization: `Bearer ${token}` }), env);
  assert.equal(res.status, 409);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM api_token").get().n, 0);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_usage").get().n, 0);
});
