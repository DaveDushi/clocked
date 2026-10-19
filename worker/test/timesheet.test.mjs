import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheet } from "../.tmp-test/report.js";
import { buildAndSendReport } from "../.tmp-test/email.js";
import { testDatabase } from "./helpers/database.mjs";

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  sqlite.exec("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('alice', 'Alice', 'alice@example.test', 1, 1, 1)");
  const insert = sqlite.prepare(`INSERT INTO sessions
    (id, user_id, start_utc, end_utc, timezone, start_reason, end_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  return {
    env: { DB, REPORT_TZ: "UTC" },
    sqlite,
    session(id, start, end, timezone = "UTC", userId = "alice", reason = "unlock") {
      insert.run(id, userId, start, end, timezone, reason, "lock");
    },
  };
}

test("one timesheet keeps overlapping timeline entries and counts worked time once", async (t) => {
  const { env, session } = fixture(t);
  session("laptop", "2026-09-01T09:00:00.000Z", "2026-09-01T12:00:00.000Z");
  session("desktop", "2026-09-01T10:00:00.000Z", "2026-09-01T13:00:00.000Z");
  session("manual", "2026-09-01T13:01:00.000Z", "2026-09-01T14:00:00.000Z", "UTC", "alice", "manual");
  session("evening", "2026-09-01T14:02:00.000Z", "2026-09-01T15:00:00.000Z");
  const { report, sessions, csv } = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.equal(report.totalMinutes, 357);
  assert.equal(report.days[0].minutes, 357);
  assert.equal(report.activeDays, 1);
  assert.deepEqual(sessions.map(({ id, minutes, source }) => ({ id, minutes, source })), [
    { id: "laptop", minutes: 180, source: "app" },
    { id: "desktop", minutes: 180, source: "app" },
    { id: "manual", minutes: 59, source: "manual" },
    { id: "evening", minutes: 58, source: "app" },
  ]);
  assert.match(csv, /Tuesday, September 1, 2026",09:00,15:00,14:00-14:02,5:57/);
  assert.match(csv, /Wednesday, September 2, 2026",Vacation,,,/);
  assert.match(csv, /,,,Total,5:57\n/);
});

test("real month selection filters ownership and clips local month edges", async (t) => {
  const { env, session } = fixture(t);
  session("west", "2026-10-01T06:30:00.000Z", "2026-10-01T07:30:00.000Z", "America/Los_Angeles");
  session("east", "2026-08-31T09:30:00.000Z", "2026-08-31T10:30:00.000Z", "Pacific/Kiritimati");
  session("fallback", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z", "Unknown/Timezone");
  session("other", "2026-09-02T00:00:00.000Z", "2026-09-02T10:00:00.000Z", "UTC", "bob");
  assert.throws(() => session("open", "2026-09-02T00:00:00.000Z", null), /NOT NULL/);
  session("outside", "2026-08-01T00:00:00.000Z", "2026-08-01T10:00:00.000Z");
  const { report, sessions, csv } = await buildTimesheet({
    env, period: "2026-09", userId: "alice", timezone: "Asia/Tokyo",
  });
  assert.equal(report.totalMinutes, 120);
  assert.deepEqual(sessions.map(({ id, date, start, end, minutes, timezone }) => ({ id, date, start, end, minutes, timezone })), [
    { id: "east", date: "2026-09-01", start: "00:00", end: "00:30", minutes: 30, timezone: "Pacific/Kiritimati" },
    { id: "fallback", date: "2026-09-02", start: "09:00", end: "10:00", minutes: 60, timezone: "Asia/Tokyo" },
    { id: "west", date: "2026-09-30", start: "23:30", end: "00:00", minutes: 30, timezone: "America/Los_Angeles" },
  ]);
  assert.match(csv, /,,,Total,2:00\n/);
});

test("midnight and daylight-saving slices retain elapsed time and timeline metadata", async (t) => {
  const { env, session } = fixture(t);
  session("midnight", "2026-10-23T21:30:00.000Z", "2026-10-23T22:30:00.000Z", "Europe/Berlin");
  session("repeat", "2026-10-25T00:30:00.000Z", "2026-10-25T02:30:00.000Z", "Europe/Berlin");
  const { report, sessions } = await buildTimesheet({
    env, period: "2026-10", userId: "alice", now: new Date("2026-11-01T12:00:00Z"),
  });
  assert.equal(report.totalMinutes, 180);
  assert.deepEqual(sessions.map(({ date, start, end, minutes }) => ({ date, start, end, minutes })), [
    { date: "2026-10-23", start: "23:30", end: "00:00", minutes: 30 },
    { date: "2026-10-24", start: "00:00", end: "00:30", minutes: 30 },
    { date: "2026-10-25", start: "02:30", end: "03:30", minutes: 120 },
  ]);
  assert.equal(sessions[0].endMin, 1440);
  assert.equal(sessions[1].id, "midnight");
  assert.equal(sessions[2].startMs, Date.parse("2026-10-25T00:30:00Z"));
  assert.equal(sessions[2].end_reason, "lock");
});

test("spring daylight-saving gaps use elapsed minutes rather than wall-clock differences", async (t) => {
  const { env, session } = fixture(t);
  session("gap", "2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z", "Europe/Berlin");
  const { report, sessions, csv } = await buildTimesheet({ env, period: "2026-03", userId: "alice" });
  assert.equal(report.totalMinutes, 60);
  assert.equal(sessions[0].start, "01:30");
  assert.equal(sessions[0].end, "03:30");
  assert.match(csv, /Sunday, March 29, 2026",01:30,03:30,,1:00/);
});

test("daily rounding follows the union while timeline entries keep individual durations", async (t) => {
  const { env, session } = fixture(t);
  session("first", "2026-09-01T09:00:00.000Z", "2026-09-01T09:00:20.000Z");
  session("second", "2026-09-01T09:01:00.000Z", "2026-09-01T09:01:20.000Z");
  session("zero", "2026-09-02T09:00:00.000Z", "2026-09-02T09:00:10.000Z");
  const { report, sessions, csv } = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.deepEqual(sessions.map((s) => s.minutes), [0, 0, 0]);
  assert.equal(report.days[0].minutes, 1);
  assert.equal(report.days[1].minutes, 0);
  assert.equal(report.totalMinutes, 1);
  assert.equal(report.activeDays, 2);
  assert.match(csv, /Wednesday, September 2, 2026",09:00,09:00,,0:00/);
});

test("current and future calendars preserve totals for hidden recorded dates", async (t) => {
  const { env, session } = fixture(t);
  session("today", "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
  session("later", "2026-09-20T09:00:00.000Z", "2026-09-20T11:00:00.000Z");
  const current = await buildTimesheet({
    env, period: "2026-09", userId: "alice", now: new Date("2026-09-02T12:00:00Z"),
  });
  assert.equal(current.report.days.length, 2);
  assert.equal(current.report.totalMinutes, 180);
  assert.equal(current.report.activeDays, 2);
  assert.equal(current.sessions.length, 2);
  assert.match(current.csv, /,,,Total,1:00\n/);
  assert.doesNotMatch(current.csv, /September 20/);
  const future = await buildTimesheet({
    env, period: "2026-09", userId: "alice", now: new Date("2026-08-01T12:00:00Z"),
  });
  assert.deepEqual(future.report.days, []);
  assert.equal(future.report.totalMinutes, 180);
  assert.equal(future.csv, "Date,Clock In,Clock Out,Breaks,Hours Worked\n,,,,\n,,,Total,0:00\n");
});

test("empty months have calendar rows but no CSV, even with project activity", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO activity_day VALUES ('alice', '2026-09-01', 'editor', 'Work', 60, '2026-09-01')");
  const { report, sessions, csv, projects } = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.equal(report.days.length, 30);
  assert.equal(report.activeDays, 0);
  assert.equal(report.totalMinutes, 0);
  assert.deepEqual(sessions, []);
  assert.equal(csv, "");
  assert.deepEqual(projects, [{ project: "Work", minutes: 1 }]);
});

test("project rollups round summed activity separately and respect opt-out", async (t) => {
  const { env, sqlite, session } = fixture(t);
  session("work", "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
  sqlite.exec(`INSERT INTO activity_day VALUES
    ('alice', '2026-09-01', 'editor', 'Work', 20, '2026-09-01'),
    ('alice', '2026-09-01', 'browser', 'Work', 20, '2026-09-01'),
    ('bob', '2026-09-01', 'browser', 'Other', 600, '2026-09-01'),
    ('alice', '2026-10-01', 'editor', 'Outside', 600, '2026-10-01')`);
  const sheet = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.deepEqual(sheet.projects, [{ project: "Work", minutes: 1 }]);
  assert.equal(sheet.report.totalMinutes, 60);
  assert.match(sheet.csv, /Project,Hours\nWork,0:01\n$/);
  sqlite.exec("INSERT INTO user_settings (userId, track_projects) VALUES ('alice', 0)");
  const hidden = await buildTimesheet({ env, period: "2026-09", userId: "alice" });
  assert.deepEqual(hidden.projects, []);
  assert.doesNotMatch(hidden.csv, /Project,Hours/);
});

test("email body and attachment reuse one session selection and one project rollup", async (t) => {
  const { env, session } = fixture(t);
  session("work", "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  t.mock.method(env.DB, "prepare", (sql) => { queries.push(sql); return prepare(sql); });
  const messages = [];
  const result = await buildAndSendReport({
    ...env, MAIL_FROM: "reports@example.test", EMAIL_PROVIDER: "cloudflare",
    EMAIL: { async send(message) { messages.push(message); return { messageId: "fixture" }; } },
  }, "2026-09", { force: true, userId: "alice", to: ["alice@example.test"] });
  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].html, /1:00/);
  assert.match(Buffer.from(messages[0].attachments[0].content, "base64").toString("utf8"), /,,,Total,1:00\n/);
  assert.equal(queries.filter((sql) => sql.includes("FROM sessions")).length, 1);
  assert.equal(queries.filter((sql) => sql.includes("FROM activity_day")).length, 1);
});
