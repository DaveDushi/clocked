import assert from "node:assert/strict";
import { test } from "node:test";
import { handleIngest, deleteSession } from "../.tmp-test/ingest.js";
import { buildHoursReport, buildReportCsv, listSessionsForPeriod } from "../.tmp-test/report.js";
import { unionMinutes } from "../.tmp-test/session-intervals.js";
import { sqliteEnv } from "./sqlite-env.mjs";

function session(id, start, end, timezone = "Europe/Berlin") {
  return { id, start_utc: start, end_utc: end, timezone, start_reason: "app", end_reason: "app" };
}
function request(sessions) {
  return new Request("https://clocked.test/sessions", { method: "POST", body: JSON.stringify({ sessions }) });
}
async function ingest(env, sessions, userId = "alice") {
  const res = await handleIngest(request(sessions), env, userId);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return res.json();
}
async function assertReports(env, period, expected, total) {
  const report = await buildHoursReport(env, period, "alice");
  assert.equal(report.totalMinutes, total);
  assert.deepEqual(report.days.filter((d) => d.minutes).map((d) => [d.date, d.minutes]), expected);
  const csv = await buildReportCsv(env, period, "alice");
  assert.match(csv, new RegExp(`,,,Total,${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}\\n`));
  const segments = await listSessionsForPeriod(env, period, "alice");
  for (const [date, minutes] of expected) {
    assert.equal(unionMinutes(segments.filter((s) => s.date === date).map((s) => ({ start: s.startMs, end: s.endMs }))), minutes);
  }
  assert.equal(new Set(segments.map((s) => s.date)).size, expected.length);
}

test("actual ingest and all reports union desktop, Android, duplicates, adjacent and nested intervals", async (t) => {
  const env = sqliteEnv(t);
  const desktop = session("desktop-session", "2026-06-01T07:00:00Z", "2026-06-01T10:00:00Z");
  const android = session("android-session", "2026-06-01T08:00:00Z", "2026-06-01T11:00:00Z");
  await ingest(env, [android, desktop, android,
    session("nested-android", "2026-06-01T08:30:00Z", "2026-06-01T09:00:00Z"),
    session("adjacent-android", "2026-06-01T11:00:00Z", "2026-06-01T11:30:00Z"),
    session("after-real-break", "2026-06-01T12:00:00Z", "2026-06-01T12:30:00Z"),
  ]);
  await ingest(env, [desktop, android]);
  await ingest(env, [session("bob-private-session", "2026-06-01T00:00:00Z", "2026-06-01T20:00:00Z")], "bob");
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'alice'").get().n, 5);
  await assertReports(env, "2026-06", [["2026-06-01", 300]], 300);
  assert.match(await buildReportCsv(env, "2026-06", "alice"), /09:00,14:30,13:30-14:00,5:00/);
});

test("different device timezones cannot duplicate one instant onto two dates or months", async (t) => {
  const env = sqliteEnv(t);
  // Earlier session starts in May in New York. Berlin's overlapping session
  // would otherwise count the same 01:00-02:00Z again in June.
  await ingest(env, [
    session("desktop-new-york", "2026-06-01T00:00:00Z", "2026-06-01T02:00:00Z", "America/New_York"),
    session("android-berlin", "2026-06-01T01:00:00Z", "2026-06-01T03:00:00Z", "Europe/Berlin"),
  ]);
  await assertReports(env, "2026-05", [["2026-05-31", 120]], 120);
  await assertReports(env, "2026-06", [["2026-06-01", 60]], 60);
  // Every raw session stays available for removal, even if wholly overlapped.
  assert.deepEqual(new Set((await listSessionsForPeriod(env, "2026-05", "alice")).map((s) => s.id)), new Set(["desktop-new-york", "android-berlin"]));
});

test("local midnight splits and DST transitions use elapsed UTC duration", async (t) => {
  const env = sqliteEnv(t);
  await ingest(env, [
    session("spring-desktop", "2026-03-28T22:30:00Z", "2026-03-29T02:30:00Z"),
    session("spring-android", "2026-03-28T23:30:00Z", "2026-03-29T03:00:00Z"),
  ]);
  await assertReports(env, "2026-03", [["2026-03-28", 30], ["2026-03-29", 240]], 270);
  await ingest(env, [
    session("fall-desktop", "2025-10-25T22:00:00Z", "2025-10-26T02:00:00Z"),
    session("fall-android", "2025-10-26T00:00:00Z", "2025-10-26T03:00:00Z"),
  ]);
  await assertReports(env, "2025-10", [["2025-10-26", 300]], 300);
});

test("equal starts use deterministic timezone attribution independent of upload order", async (t) => {
  const env = sqliteEnv(t);
  const a = session("same-start-ny", "2026-06-01T01:00:00Z", "2026-06-01T02:00:00Z", "America/New_York");
  const b = session("same-start-berlin", "2026-06-01T01:00:00Z", "2026-06-01T02:00:00Z", "Europe/Berlin");
  await ingest(env, [b, a]);
  await assertReports(env, "2026-05", [["2026-05-31", 60]], 60);
  assert.equal((await buildHoursReport(env, "2026-06", "alice")).totalMinutes, 0);
});

test("Auckland midnight before a DST change uses the offset at local midnight", async (t) => {
  const env = sqliteEnv(t);
  await ingest(env, [session("auckland-dst-session", "2026-04-04T10:30:00Z", "2026-04-04T15:30:00Z", "Pacific/Auckland")]);
  await assertReports(env, "2026-04", [["2026-04-04", 30], ["2026-04-05", 270]], 300);
});

test("SQL ownership guards reject takeover, including two claims before either batch runs", async (t) => {
  const env = sqliteEnv(t);
  const row = session("contended-session", "2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z");
  const responses = await Promise.all([handleIngest(request([row]), env, "alice"), handleIngest(request([{ ...row, end_utc: "2026-06-01T12:00:00Z" }]), env, "bob")]);
  assert.deepEqual(responses.map((r) => r.status), [200, 409]);
  assert.equal((await buildHoursReport(env, "2026-06", "alice")).totalMinutes, 60);
  assert.equal((await buildHoursReport(env, "2026-06", "bob")).totalMinutes, 0);
  assert.equal((await handleIngest(request([row]), env, null)).status, 409);
  assert.equal(await deleteSession(env, "bob", row.id), false);
});

test("atomic deletion wins over retries in either order, and only the owner acknowledges tombstones", async (t) => {
  const env = sqliteEnv(t);
  const row = session("deleted-android", "2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z");
  await ingest(env, [row]);
  await Promise.all([handleIngest(request([row]), env, "alice"), deleteSession(env, "alice", row.id)]);
  const retry = await ingest(env, [row]);
  assert.deepEqual(retry.accepted, [row.id]);
  assert.equal(retry.upserted, 0);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal((await handleIngest(request([row]), env, "bob")).status, 409);
  assert.equal((await handleIngest(request([row]), env, null)).status, 409);
  const second = { ...row, id: "deleted-second-order" };
  await ingest(env, [second]);
  await Promise.all([deleteSession(env, "alice", second.id), handleIngest(request([second]), env, "alice")]);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
});

test("session ingest normalizes UTC precision and rejects rollover dates and future ends", async (t) => {
  const env = sqliteEnv(t);
  const row = session("valid-normalized", "2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z");
  await ingest(env, [row]);
  assert.equal(env.sqlite.prepare("SELECT start_utc FROM sessions").get().start_utc, "2026-06-01T08:00:00.000Z");
  for (const invalid of [null, 1, { ...row, start_utc: "2026-02-30T08:00:00Z", end_utc: "2026-03-03T09:00:00Z" },
    { ...row, start_utc: "2026-06-01T08:00:00" }, { ...row, end_utc: "2099-01-01T00:00:00Z" },
    { ...row, timezone: 123 }]) {
    assert.equal((await handleIngest(request([invalid]), env, "alice")).status, 400);
  }
});

test("a revoked token cannot restore exact sessions after a cloud wipe", async (t) => {
  const env = sqliteEnv(t);
  const row = session("revoked-android", "2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z");
  const response = await handleIngest(request([row]), env, "alice", "revoked-token-hash");
  assert.equal(response.status, 409);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
});

test("Rust RFC3339 UTC timestamps with nanosecond fractions ingest and canonicalize", async (t) => {
  const env = sqliteEnv(t);
  const row = session("rust-nanosecond-session", "2026-10-18T09:00:00.123456789+00:00", "2026-10-18T10:00:00.123456789+00:00", "UTC");
  assert.deepEqual((await ingest(env, [row])).accepted, [row.id]);
  assert.deepEqual({ ...env.sqlite.prepare("SELECT start_utc, end_utc FROM sessions").get() }, {
    start_utc: "2026-10-18T09:00:00.123Z", end_utc: "2026-10-18T10:00:00.123Z",
  });
  await ingest(env, [{ ...row, start_utc: "2026-10-18T09:00:00.123Z", end_utc: "2026-10-18T10:00:00.123Z" }]);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  assert.equal((await buildHoursReport(env, "2026-10", "alice")).totalMinutes, 60);
});

test("RFC3339 precisions and offsets preserve local calendar validity across UTC dates", async (t) => {
  const env = sqliteEnv(t);
  const cases = [
    ["2026-06-01T00:15:00.123456789+02:00", "2026-06-01T01:15:00.123456789+02:00", "2026-05-31T22:15:00.123Z", "2026-05-31T23:15:00.123Z"],
    ["2026-05-31T23:15:00.123456-04:00", "2026-06-01T00:15:00.123456-04:00", "2026-06-01T03:15:00.123Z", "2026-06-01T04:15:00.123Z"],
    ["2026-06-01T08:00:00+00:00", "2026-06-01T09:00:00+00:00", "2026-06-01T08:00:00.000Z", "2026-06-01T09:00:00.000Z"],
    ["2026-06-02T00:15:00.1+05:45", "2026-06-02T01:15:00.1+05:45", "2026-06-01T18:30:00.100Z", "2026-06-01T19:30:00.100Z"],
    ["2024-02-29T00:15:00.000000001+14:00", "2024-02-29T01:15:00.000000001+14:00", "2024-02-28T10:15:00.000Z", "2024-02-28T11:15:00.000Z"],
    ["2026-06-01t08:00:00.123456789z", "2026-06-01t09:00:00.123456789z", "2026-06-01T08:00:00.123Z", "2026-06-01T09:00:00.123Z"],
  ];
  for (const [i, [start, end, expectedStart, expectedEnd]] of cases.entries()) {
    const id = `offset-session-${i}`;
    assert.deepEqual((await ingest(env, [session(id, start, end, "UTC")])).accepted, [id]);
    assert.deepEqual({ ...env.sqlite.prepare("SELECT start_utc, end_utc FROM sessions WHERE id = ?").get(id) }, {
      start_utc: expectedStart, end_utc: expectedEnd,
    });
  }
  await assertReports(env, "2026-05", [["2026-05-31", 60]], 60);
  // The zero-offset and lowercase-Z intervals describe the same hour.
  await assertReports(env, "2026-06", [["2026-06-01", 180]], 180);
});

test("RFC3339 validation rejects invalid local dates, times and numeric offsets", async (t) => {
  const env = sqliteEnv(t);
  const invalid = [
    "2026-02-29T23:30:00.123456789-02:00", "2026-04-31T00:30:00+02:00",
    "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-06-00T00:00:00Z",
    "2026-06-01T24:00:00+00:00", "2026-06-01T08:60:00+00:00", "2026-06-01T08:00:61+00:00",
    "2026-06-01T08:00:00+24:00", "2026-06-01T08:00:00+01:60",
    "2026-06-01T08:00:00+0000", "2026-06-01T08:00:00.", "2026-06-01T08:00:00.Z",
    "2026-06-01 08:00:00Z", "2026-06-01T08:00:00", "2026-06-01T08:00:00Zjunk",
  ];
  for (const start of invalid) {
    const res = await handleIngest(request([session("invalid-rfc3339", start, "2026-06-02T10:00:00Z")]), env, "alice");
    assert.equal(res.status, 400, start);
    assert.deepEqual((await res.json()).accepted, [], start);
  }
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
});
