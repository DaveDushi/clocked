import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "./helpers/database.mjs";
import { DEFAULT_TIME_POLICY, handleManagerTimePolicy } from "../.tmp-test/time-policy.js";
import { buildTimesheet, summarizeMonth } from "../.tmp-test/report.js";
import { buildTeamOverview } from "../.tmp-test/team-overview.js";
import { buildAndSendReport } from "../.tmp-test/email.js";

const policy = { ...DEFAULT_TIME_POLICY, paidLunchMinutes: 30, longBreakMinutes: 15, overtime: { mode: "daily", thresholdMinutes: 480 } };
function rows(date, spans) {
  return spans.map(([start, end], i) => ({ id: date + i, user_id: "worker", start_utc: `${date}T${start}:00Z`, end_utc: `${date}T${end}:00Z`, timezone: "UTC", start_reason: "unlock", end_reason: "lock", edited_by: null, replaces_id: null }));
}
test("one continuous lunch counts once; small breaks stay unpaid and other long breaks are flagged", () => {
  const result = summarizeMonth(rows("2026-09-01", [["08:00", "10:00"], ["10:10", "12:00"], ["12:45", "15:00"], ["15:20", "18:00"]]), "2026-09", "UTC", new Date("2026-10-01"), policy);
  const day = result.recordedDays[0];
  assert.equal(day.recordedMinutes, 525);
  assert.equal(day.minutes, 555);
  assert.equal(day.paidLunchMinutes, 30);
  assert.equal(day.overtimeMinutes, 75);
  assert.equal(day.longBreakCount, 1);
  assert.deepEqual(day.breaks.map(b => [b.minutes, !!b.lunch, !!b.flagged]), [[10, false, false], [45, true, false], [20, false, true]]);
  const small = summarizeMonth(rows("2026-09-01", [["08:00", "10:00"], ["10:10", "12:00"], ["12:10", "15:00"], ["15:10", "18:00"]]), "2026-09", "UTC", new Date(), policy);
  assert.equal(small.report.paidLunchMinutes, 0);
  assert.equal(small.report.totalMinutes, 570);
});

test("weekly overtime carries across months and resets on Monday; lunch is included", () => {
  const sessions = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"].flatMap(date => rows(date, [["08:00", "12:00"], ["12:30", "17:00"]]));
  const weekly = { ...policy, overtime: { mode: "weekly", thresholdMinutes: 2400 } };
  const result = summarizeMonth(sessions, "2026-09", "UTC", new Date("2026-10-01"), weekly);
  assert.deepEqual(result.recordedDays.map(d => [d.date, d.minutes, d.overtimeMinutes]), [
    ["2026-09-01", 540, 0], ["2026-09-02", 540, 0], ["2026-09-03", 540, 0], ["2026-09-04", 540, 300], ["2026-09-07", 540, 0],
  ]);
  assert.equal(result.report.totalMinutes, 2700);
  assert.equal(result.report.overtimeMinutes, 300);
  assert.equal(result.report.paidLunchMinutes, 150);
});

test("no break or overlapping devices never invent lunch; only the longest qualifying gap is lunch", () => {
  const continuous = summarizeMonth(rows("2026-09-01", [["08:00", "17:00"], ["10:00", "14:00"]]), "2026-09", "UTC", new Date(), policy);
  assert.equal(continuous.report.totalMinutes, 540);
  assert.equal(continuous.report.paidLunchMinutes, 0);
  const day = summarizeMonth(rows("2026-09-01", [["08:00", "10:00"], ["10:30", "12:00"], ["13:00", "14:00"], ["16:00", "17:00"]]), "2026-09", "UTC", new Date(), policy).recordedDays[0];
  assert.deepEqual(day.breaks.map(b => [b.minutes, !!b.lunch, !!b.flagged]), [[30, false, true], [60, true, false], [120, false, true]]);
});

test("manager settings persist, isolate teams, validate atomically and agree across overview and CSV", async t => {
  const { DB, sqlite } = testDatabase(); t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES
    ('boss','Boss','boss@test',1,1,1), ('worker','Worker','worker@test',1,1,1), ('other','Other','other@test',1,1,1);
    INSERT INTO organization(id,name,slug,metadata,createdAt) VALUES ('a','A','a','{"plan":"team"}',1), ('b','B','b','{"plan":"team"}',1);
    INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES ('boss-a','a','boss','owner',1), ('worker-a','a','worker','member',1), ('other-b','b','other','owner',1);`);
  const env = { DB, REPORT_TZ: "UTC" };
  const request = (actor, body, method = "POST") => handleManagerTimePolicy(new Request("https://test/api/team/time-policy?organizationId=a", { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), env, actor);
  assert.deepEqual((await (await request("boss", null, "GET")).json()).policy, DEFAULT_TIME_POLICY);
  for (const actor of ["worker", "other"]) for (const method of ["GET", "POST"]) assert.equal((await request(actor, policy, method)).status, 403);
  assert.equal((await request("boss", policy, "DELETE")).status, 405);
  assert.deepEqual((await (await request("boss", policy)).json()).policy, policy);
  for (const invalid of [{ ...policy, paidLunchMinutes: -1 }, { ...policy, lunchMinMinutes: 100 }, { ...policy, longBreakMinutes: "20" }, { ...policy, overtime: { mode: "daily", thresholdMinutes: 1500 } }]) assert.equal((await request("boss", invalid)).status, 400);
  assert.deepEqual((await (await request("boss", null, "GET")).json()).policy, policy);
  for (const row of rows("2026-09-01", [["08:00", "12:00"], ["12:30", "18:00"]])) sqlite.prepare("INSERT INTO sessions (id,user_id,start_utc,end_utc,timezone) VALUES (?,?,?,?,?)").run(row.id, row.user_id, row.start_utc, row.end_utc, "UTC");
  const sheet = await buildTimesheet({ env, userId: "worker", organizationId: "a", period: "2026-09", scope: { kind: "team", since: "1970-01-01T00:00:00Z" } });
  assert.equal(sheet.report.totalMinutes, 600);
  assert.equal(sheet.report.overtimeMinutes, 120);
  assert.match(sheet.csv, /Hours Worked,Paid Lunch,Regular Hours,Overtime/);
  assert.match(sheet.csv, /18:00,12:00-12:30,10:00,0:30,8:00,2:00/);
  const overview = await buildTeamOverview(env, "a", "2026-09", "UTC");
  const worker = overview.members.find(m => m.id === "worker");
  assert.equal(worker.stats.workedMinutes, 600);
  assert.equal(worker.days[0].overtimeMinutes, 120);
  const personal = await buildTimesheet({ env, userId: "worker", period: "2026-09", scope: { kind: "personal" } });
  assert.equal(personal.report.totalMinutes, 570);
  assert.equal(personal.report.paidLunchMinutes, undefined);

  const sent = [];
  const emailEnv = { ...env, MAIL_FROM: "reports@test", EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(message) { sent.push(message); return { messageId: "test" }; } } };
  assert.equal((await buildAndSendReport(emailEnv, "2026-09", { force: true, userId: "worker", organizationId: "a", to: ["boss@test"] })).ok, true);
  assert.match(sent[0].text, /Includes 0:30 paid lunch. Regular hours: 8:00. Overtime: 2:00/);
  assert.equal(Buffer.from(sent[0].attachments[0].content).toString("utf8"), sheet.csv);

  const weekly = { ...policy, overtime: { mode: "weekly", thresholdMinutes: 600 } };
  await request("boss", weekly);
  sqlite.prepare("INSERT INTO sessions (id,user_id,start_utc,end_utc,timezone) VALUES (?,?,?,?,?)").run("monday", "worker", "2026-08-31T08:00:00Z", "2026-08-31T18:00:00Z", "UTC");
  const weeklySheet = await buildTimesheet({ env, userId: "worker", organizationId: "a", period: "2026-09", scope: { kind: "team", since: "1970-01-01T00:00:00Z" } });
  assert.equal(weeklySheet.report.totalMinutes, 600);
  assert.equal(weeklySheet.report.overtimeMinutes, 600);
  assert.equal((await buildTeamOverview(env, "a", "2026-09", "UTC")).members.find(m => m.id === "worker").days[0].overtimeMinutes, 600);
  assert.deepEqual((await (await request("boss", { ...policy, paidLunchMinutes: 0, longBreakMinutes: 0, overtime: { mode: "disabled" } })).json()).policy.overtime, { mode: "disabled" });
});
