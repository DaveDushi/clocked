import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheet } from "../.tmp-test/report.js";
import { breakStats, median, teamBreakStats } from "../.tmp-test/break-stats.js";
import { handleManualSession } from "../.tmp-test/manual-session.js";
import { handleIngest } from "../.tmp-test/ingest.js";
import { buildTeamOverview, parseSelection, sendTeamTimesheets } from "../.tmp-test/team-overview.js";
import { testDatabase } from "./helpers/database.mjs";

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  const user = sqlite.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)");
  for (const id of ["alice", "bob", "carol", "outsider"]) user.run(id, id[0].toUpperCase() + id.slice(1), id + "@example.test");
  sqlite.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('team', 'Team', 'team', 1), ('other', 'Other', 'other', 1);
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
      ('m1', 'team', 'alice', 'owner', 1), ('m2', 'team', 'bob', 'member', 2), ('m3', 'team', 'carol', 'member', 3),
      ('m4', 'other', 'outsider', 'owner', 4);`);
  const insert = sqlite.prepare(`INSERT INTO sessions (id, user_id, start_utc, end_utc, timezone, start_reason, end_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const emails = [];
  return {
    sqlite,
    emails,
    env: {
      DB, REPORT_TZ: "UTC", MAIL_FROM: "reports@example.test", EMAIL_PROVIDER: "cloudflare",
      EMAIL: { async send(message) { emails.push(message); return { messageId: String(emails.length) }; } },
    },
    session(id, userId, start, end, endReason = "lock", timezone = "UTC", startReason = "unlock") {
      insert.run(id, userId, start, end, timezone, startReason, endReason);
    },
  };
}

const request = (method, body) => new Request("https://clocked.test/api/manual-session", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const url = new URL("https://clocked.test/api/manual-session");

test("breaks are gaps between merged sessions on one local day, labelled by the recorded clock-out", async (t) => {
  const { env, session } = fixture(t);
  session("laptop", "alice", "2026-09-01T09:00:00Z", "2026-09-01T11:00:00Z", "idle");
  session("desktop", "alice", "2026-09-01T10:30:00Z", "2026-09-01T12:00:00Z", "suspend");
  session("after-lunch", "alice", "2026-09-01T12:45:00Z", "2026-09-01T15:00:00Z", "manual");
  session("blip", "alice", "2026-09-01T15:01:00Z", "2026-09-01T16:00:00Z", "quit");
  session("late", "alice", "2026-09-01T16:30:00Z", "2026-09-01T23:30:00Z", "weird_reason");
  // Overnight: the gap from 23:30 to the next morning is not a break.
  session("overnight", "alice", "2026-09-02T01:00:00Z", "2026-09-02T02:00:00Z", "lock");
  session("zero-break", "alice", "2026-09-03T09:00:00Z", "2026-09-03T17:00:00Z", "lock");
  const { recordedDays, report } = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.equal(report.activeDays, 3);
  assert.deepEqual(recordedDays.map(({ date, minutes, start, end, breakMinutes }) => ({ date, minutes, start, end, breakMinutes })), [
    { date: "2026-09-01", minutes: 13 * 60 + 14, start: "09:00", end: "23:30", breakMinutes: 75 },
    { date: "2026-09-02", minutes: 60, start: "01:00", end: "02:00", breakMinutes: 0 },
    { date: "2026-09-03", minutes: 480, start: "09:00", end: "17:00", breakMinutes: 0 },
  ]);
  // The overlap ends with the desktop session (suspend); the one-minute blip is not a break.
  assert.deepEqual(recordedDays[0].breaks, [
    { start: "12:00", end: "12:45", minutes: 45, cause: "suspend" },
    { start: "16:00", end: "16:30", minutes: 30, cause: "quit" },
  ]);
  assert.equal(breakStats(recordedDays).breakCount, 2);
});

test("cross-midnight sessions split by local date and an unrecorded reason stays unknown", async (t) => {
  const { env, session } = fixture(t);
  session("evening", "alice", "2026-09-10T20:00:00Z", "2026-09-11T01:00:00Z", null, "Europe/Berlin");
  session("morning", "alice", "2026-09-11T03:00:00Z", "2026-09-11T04:00:00Z", "lock", "Europe/Berlin");
  const { recordedDays } = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.deepEqual(recordedDays.map(({ date, minutes, breaks }) => ({ date, minutes, breaks })), [
    { date: "2026-09-10", minutes: 120, breaks: [] },
    { date: "2026-09-11", minutes: 240, breaks: [{ start: "03:00", end: "05:00", minutes: 120, cause: "unknown" }] },
  ]);
});

test("stats are normalized per recorded day and empty months do not produce NaN", () => {
  const empty = breakStats([]);
  assert.deepEqual(empty, { workedMinutes: 0, breakMinutes: 0, breakCount: 0, recordedDays: 0, avgBreakMinutes: 0, breaksPerDay: 0 });
  const long = breakStats([
    { minutes: 400, breakMinutes: 30, breaks: [{}] },
    { minutes: 400, breakMinutes: 0, breaks: [] },
    { minutes: 400, breakMinutes: 60, breaks: [{}, {}] },
    { minutes: 400, breakMinutes: 30, breaks: [{}] },
  ]);
  const short = breakStats([{ minutes: 300, breakMinutes: 45, breaks: [{}, {}, {}] }]);
  assert.equal(long.avgBreakMinutes, 30);
  assert.equal(long.breaksPerDay, 1);
  assert.equal(short.avgBreakMinutes, 45);
  assert.equal(short.breaksPerDay, 3);
  const { team, median: reference } = teamBreakStats([long, short, empty]);
  assert.equal(team.recordedDays, 5);
  assert.equal(team.avgBreakMinutes, 33);
  assert.equal(team.breaksPerDay, 7 / 5);
  assert.deepEqual(reference, { avgBreakMinutes: 37.5, breaksPerDay: 2, members: 2 });
  assert.equal(median([]), null);
  assert.deepEqual(teamBreakStats([]).median, { avgBreakMinutes: null, breaksPerDay: null, members: 0 });
});

test("editing a session replaces the chosen session, records who edited it and survives desktop re-sync", async (t) => {
  const { env, session, sqlite } = fixture(t);
  session("recorded-0001", "bob", "2026-09-04T09:00:00Z", "2026-09-04T12:00:00Z", "idle", "Europe/Berlin");
  session("untouched-001", "bob", "2026-09-04T13:00:00Z", "2026-09-04T15:00:00Z", "lock", "Europe/Berlin");
  const edited = await handleManualSession(request("PATCH", { id: "recorded-0001", date: "2026-09-04", start: "10:30", end: "13:45" }), url, env, "bob", "alice", "UTC");
  assert.equal(edited.status, 200);
  const { id } = await edited.json();
  const rows = sqlite.prepare("SELECT id, start_utc, end_utc, start_reason, timezone, edited_by, replaces_id FROM sessions WHERE user_id = 'bob' ORDER BY start_utc").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { id, start_utc: "2026-09-04T08:30:00.000Z", end_utc: "2026-09-04T11:45:00.000Z", start_reason: "manual", timezone: "Europe/Berlin", edited_by: "alice", replaces_id: "recorded-0001" },
    { id: "untouched-001", start_utc: "2026-09-04T13:00:00Z", end_utc: "2026-09-04T15:00:00Z", start_reason: "unlock", timezone: "Europe/Berlin", edited_by: null, replaces_id: null },
  ]);
  const { sessions, recordedDays } = await buildTimesheet({ env, period: "2026-09", userId: "bob" });
  assert.deepEqual(sessions.map(({ start, end, entry, editor }) => ({ start, end, entry, editor })), [
    { start: "10:30", end: "13:45", entry: "edited", editor: "other" },
    { start: "15:00", end: "17:00", entry: null, editor: null },
  ]);
  assert.deepEqual(recordedDays[0].breaks, [{ start: "13:45", end: "15:00", minutes: 75, cause: "entry" }]);

  // A desktop upload of the replaced id is accepted but not restored.
  const resync = await handleIngest(new Request("https://clocked.test/sessions", { method: "POST", body: JSON.stringify({ sessions: [
    { id: "recorded-0001", start_utc: "2026-09-04T09:00:00Z", end_utc: "2026-09-04T12:00:00Z", start_reason: "unlock", end_reason: "idle" },
  ] }) }), env, "bob");
  assert.deepEqual((await resync.json()).accepted, ["recorded-0001"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'recorded-0001'").get().n, 0);

  // Editing the edit keeps pointing at the original recorded session.
  await handleManualSession(request("PATCH", { id, date: "2026-09-04", start: "10:00", end: "13:45" }), url, env, "bob", "bob", "UTC");
  const again = sqlite.prepare("SELECT edited_by, replaces_id FROM sessions WHERE user_id = 'bob' AND start_reason = 'manual'").get();
  assert.deepEqual({ ...again }, { edited_by: "bob", replaces_id: "recorded-0001" });
});

test("session edits validate times, keep cross-midnight sessions whole and never touch other accounts", async (t) => {
  const { env, session, sqlite } = fixture(t);
  session("night-shift-1", "bob", "2026-09-04T20:00:00Z", "2026-09-05T02:00:00Z");
  session("alice-only-01", "alice", "2026-09-04T09:00:00Z", "2026-09-04T10:00:00Z");
  const patch = (body, owner = "bob") => handleManualSession(request("PATCH", body), url, env, owner, "alice", "UTC");
  assert.equal((await patch({ id: "alice-only-01", date: "2026-09-04", start: "09:00", end: "11:00" })).status, 404);
  assert.equal((await patch({ id: "night-shift-1", date: "2026-09-04", start: "22:00", end: "21:00" })).status, 400);
  assert.equal((await patch({ id: "night-shift-1", date: "2026-09-04", start: "20:00", end: "21:00", overnight: true })).status, 400);
  assert.equal((await patch({ id: "night-shift-1", date: "2026-02-30", start: "20:00", end: "21:00" })).status, 400);
  assert.equal((await patch({ id: "night-shift-1", date: "2026-09-04", start: "21:00", end: "03:00", overnight: true })).status, 200);
  const { sessions, report } = await buildTimesheet({ env, period: "2026-09", userId: "bob" });
  assert.deepEqual(sessions.map(({ date, start, end }) => ({ date, start, end })), [
    { date: "2026-09-04", start: "21:00", end: "00:00" },
    { date: "2026-09-05", start: "00:00", end: "03:00" },
  ]);
  assert.equal(sessions[0].sessionStartUtc, "2026-09-04T21:00:00.000Z");
  assert.equal(sessions[1].sessionEndUtc, "2026-09-05T03:00:00.000Z");
  assert.equal(report.totalMinutes, 360);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'alice'").get().n, 1);

  const added = await handleManualSession(request("POST", { date: "2026-09-06", start: "08:00", end: "09:30" }), url, env, "bob", "alice", "UTC");
  assert.equal(added.status, 200);
  const entry = sqlite.prepare("SELECT edited_by, replaces_id, start_reason FROM sessions WHERE start_utc = '2026-09-06T08:00:00.000Z'").get();
  assert.deepEqual({ ...entry }, { edited_by: "alice", replaces_id: null, start_reason: "manual" });
});

test("team overview reports every member once, only from that team, with recorded-day rates", async (t) => {
  const { env, session } = fixture(t);
  session("a1", "alice", "2026-09-01T09:00:00Z", "2026-09-01T12:00:00Z", "idle");
  session("a2", "alice", "2026-09-01T12:30:00Z", "2026-09-01T17:00:00Z");
  session("b1", "bob", "2026-09-02T09:00:00Z", "2026-09-02T17:00:00Z");
  session("o1", "outsider", "2026-09-02T09:00:00Z", "2026-09-02T17:00:00Z");
  await handleManualSession(request("POST", { date: "2026-09-03", start: "09:00", end: "10:00" }), url, env, "bob", "alice", "UTC");
  const overview = await buildTeamOverview(env, "team", "2026-09", "UTC", new Date("2026-10-19T12:00:00Z"));
  assert.equal(overview.today, "2026-10-19");
  assert.deepEqual(overview.members.map(({ id, role, stats, enteredSessions }) => ({ id, role, days: stats.recordedDays, worked: stats.workedMinutes, avg: stats.avgBreakMinutes, enteredSessions })), [
    { id: "alice", role: "owner", days: 1, worked: 450, avg: 30, enteredSessions: 0 },
    { id: "bob", role: "member", days: 2, worked: 540, avg: 0, enteredSessions: 1 },
    { id: "carol", role: "member", days: 0, worked: 0, avg: 0, enteredSessions: 0 },
  ]);
  assert.deepEqual(overview.members[0].days, [
    { date: "2026-09-01", minutes: 450, start: "09:00", end: "17:00", breakMinutes: 30, breakCount: 1 },
  ]);
  assert.equal(overview.team.recordedDays, 3);
  assert.equal(overview.team.avgBreakMinutes, 10);
  assert.deepEqual(overview.median, { avgBreakMinutes: 15, breaksPerDay: 0.5, members: 2 });
});

test("bulk send emails exactly the reviewed members to the team recipients and refuses outsiders", async (t) => {
  const { env, session, emails, sqlite } = fixture(t);
  session("a1", "alice", "2026-09-01T09:00:00Z", "2026-09-01T12:00:00Z");
  sqlite.exec("INSERT INTO org_settings (organizationId, mail_to) VALUES ('team', 'payroll@example.test')");
  assert.equal(parseSelection([]), null);
  assert.equal(parseSelection(["alice", "alice"]), null);
  assert.equal(parseSelection("alice"), null);
  assert.deepEqual(parseSelection(["alice", "bob"]), ["alice", "bob"]);

  const refused = await sendTeamTimesheets(env, "team", "2026-09", ["alice", "outsider"]);
  assert.deepEqual(refused, { ok: false, status: 403, error: "selection includes someone outside your team" });
  assert.equal(emails.length, 0);

  const sent = await sendTeamTimesheets(env, "team", "2026-09", ["alice", "carol"]);
  assert.deepEqual(sent, { ok: true, period: "2026-09", recipients: ["payroll@example.test"],
    results: [{ userId: "alice", ok: true }, { userId: "carol", ok: true }] });
  assert.equal(emails.length, 2);
  assert.ok(emails.every((message) => message.to.length === 1 && message.to[0] === "payroll@example.test"));
  assert.equal(emails[0].attachments.length, 1);
  assert.equal(emails[1].attachments, undefined);
});

test("bulk send falls back to the managers when no team recipient is saved", async (t) => {
  const { env, emails } = fixture(t);
  const sent = await sendTeamTimesheets(env, "team", "2026-09", ["bob"]);
  assert.equal(sent.ok, true);
  assert.deepEqual(emails[0].to, ["alice@example.test"]);
});
