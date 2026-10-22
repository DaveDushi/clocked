import assert from "node:assert/strict";
import { test } from "node:test";
import { Script, runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";
import { createWorkspaceModel } from "../.tmp-test/workspace-model.js";
import { dashboardResponse } from "../.tmp-test/dashboard.js";

const model = createWorkspaceModel();

test("year charts include every date once and preserve leap days and Sunday alignment", () => {
  const regular = model.yearCalendar(2026);
  assert.equal(regular.dates.filter(Boolean).length, 365);
  assert.equal(regular.dates[4], "2026-01-01");
  assert.equal(regular.dates.filter(Boolean).at(-1), "2026-12-31");
  const leap = model.yearCalendar(2024);
  assert.equal(new Set(leap.dates.filter(Boolean)).size, 366);
  assert.ok(leap.dates.includes("2024-02-29"));
  assert.equal(regular.months.length, 12);
});

test("zoomed calendars show only the chosen dates including a one-day window", () => {
  assert.deepEqual(model.yearCalendar(2026, "2026-09-30", "2026-10-02").dates.filter(Boolean), ["2026-09-30", "2026-10-01", "2026-10-02"]);
  const day = model.yearCalendar(2024, "2024-02-29", "2024-02-29");
  assert.equal(day.weeks, 1);
  assert.deepEqual(day.dates.filter(Boolean), ["2024-02-29"]);
  assert.deepEqual(day.months.map((month) => month.label), ["Feb"]);
});

test("weekly ledger and range totals sum their days and weight daily averages by recorded days", () => {
  const days = [
    { date: "2026-09-07", minutes: 480, breakMinutes: 30, breakCount: 1 },
    { date: "2026-09-06", minutes: 120, breakMinutes: 0, breakCount: 0 },
    { date: "2026-09-08", minutes: 360, breakMinutes: 60, breakCount: 2 },
  ];
  const weeks = model.weekGroups(days);
  assert.deepEqual(weeks.map((week) => [week.start, week.minutes, week.breakMinutes]), [["2026-08-31", 120, 0], ["2026-09-07", 840, 90]]);
  assert.deepEqual(model.statsForDays(days), { workedMinutes: 960, breakMinutes: 90, breakCount: 3, recordedDays: 3, avgBreakMinutes: 30, breaksPerDay: 1 });
  assert.deepEqual(model.statsForDays([]), { workedMinutes: 0, breakMinutes: 0, breakCount: 0, recordedDays: 0, avgBreakMinutes: 0, breaksPerDay: 0 });
});

test("the default reporting month is the last complete month and months stay real", () => {
  assert.equal(model.lastCompleteMonth({ y: 2026, m: 10 }), "2026-09");
  assert.equal(model.lastCompleteMonth({ y: 2026, m: 1 }), "2025-12");
  const options = model.monthOptions({ y: 2026, m: 10 }, 3, "2026-09");
  assert.deepEqual(options.map((o) => [o.value, o.label, o.current]), [
    ["2026-10", "October 2026 · in progress", true],
    ["2026-09", "September 2026", false],
    ["2026-08", "August 2026", false],
  ]);
  assert.equal(model.monthOptions({ y: 2026, m: 10 }, 3, "2024-02").at(-1).value, "2024-02");
  assert.deepEqual(model.visibleDates("2026-10", "2026-10-03"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(model.visibleDates("2026-09", "2026-10-03").length, 30);
  assert.deepEqual(model.visibleDates("2026-11", "2026-10-03"), []);
});

test("day entries order sessions and server breaks, flag overlaps and keep other days out", () => {
  const at = (h, m) => Date.UTC(2026, 8, 1, h, m);
  const session = (id, date, s, e) => ({ id, date, startMin: s[0] * 60 + s[1], endMin: e[0] * 60 + e[1], startMs: at(...s), endMs: at(...e) });
  const sessions = [
    session("late", "2026-09-01", [13, 0], [17, 0]),
    session("desk", "2026-09-01", [10, 0], [12, 0]),
    session("laptop", "2026-09-01", [9, 0], [11, 0]),
    session("other-day", "2026-09-02", [9, 0], [10, 0]),
  ];
  const day = { date: "2026-09-01", breaks: [{ start: "12:00", end: "13:00", minutes: 60, cause: "suspend" }] };
  const entries = model.dayEntries(sessions, day);
  assert.deepEqual(entries.map((e) => e.kind === "break" ? "break:" + e.gap.cause : e.session.id + (e.overlaps ? "*" : "")), [
    "laptop*", "desk*", "break:suspend", "late",
  ]);
  assert.deepEqual(model.dayEntries(sessions, null), []);
});

test("labels state recorded reasons only and say when no reason was recorded", () => {
  assert.equal(model.causeLabel("idle"), "Idle timeout");
  assert.equal(model.causeLabel("suspend"), "Computer asleep");
  assert.equal(model.causeLabel("manual"), "Manual clock-out");
  assert.equal(model.causeLabel("unknown"), "Reason not recorded");
  assert.equal(model.causeLabel("anything-else"), "Reason not recorded");
});

test("worked-time shades get brighter with more worked time and break strength never vanishes", () => {
  assert.deepEqual([0, 119, 120, 239, 240, 359, 360, 479, 480, 900].map(model.workedLevel), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const luminance = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const shades = model.WORK_SHADES.map(luminance);
  assert.ok(shades.every((value, i) => i === 0 || value > shades[i - 1]), "each level is brighter than the one before");
  assert.ok(model.breakStrength(0) > 0 && model.breakStrength(0) < model.breakStrength(1));
  assert.equal(model.breakStrength(500), 0.9);
  assert.deepEqual(model.calendar("2026-09"), { offset: 1, last: 30, weeks: 5 });
  assert.deepEqual(model.calendar("2026-03"), { offset: 6, last: 31, weeks: 6 });
});

test("member sorting normalizes by recorded days and keeps people without days last", () => {
  const member = (name, days, avg, rate) => ({ name, stats: { recordedDays: days, avgBreakMinutes: avg, breaksPerDay: rate } });
  const members = [member("Ana", 20, 30, 1), member("Ben", 2, 45, 3), member("Cy", 0, 0, 0), member("Dee", 10, 30, 2)];
  assert.deepEqual(model.sortMembers(members, "average").map((m) => m.name), ["Ben", "Ana", "Dee", "Cy"]);
  assert.deepEqual(model.sortMembers(members, "breaks").map((m) => m.name), ["Ben", "Dee", "Ana", "Cy"]);
  assert.deepEqual(model.sortMembers(members, "name").map((m) => m.name), ["Ana", "Ben", "Cy", "Dee"]);
});

test("send review facts come only from recorded data", () => {
  assert.deepEqual(model.sendFacts({ stats: { recordedDays: 20 }, enteredSessions: 0 }, 20), []);
  assert.deepEqual(model.sendFacts({ stats: { recordedDays: 12 }, enteredSessions: 2 }, 20), [
    "2 sessions entered or edited in the dashboard", "12 recorded days · team median 20",
  ]);
  assert.deepEqual(model.sendFacts({ stats: { recordedDays: 1 }, enteredSessions: 1 }, null), ["1 session entered or edited in the dashboard"]);
});

test("edit forms read stored session bounds in the session timezone", () => {
  assert.deepEqual(model.zonedParts("2026-09-04T20:30:00.000Z", "Europe/Berlin"), { date: "2026-09-04", time: "22:30" });
  assert.deepEqual(model.zonedParts("2026-09-04T23:15:00.000Z", "Europe/Berlin"), { date: "2026-09-05", time: "01:15" });
  assert.equal(model.isNextDay("2026-09-30", "2026-10-01"), true);
  assert.equal(model.isNextDay("2026-09-04", "2026-09-06"), false);
  assert.equal(model.duration(450), "7h 30m");
  assert.equal(model.shortDuration(45), "45m");
  assert.equal(model.rate(1 / 3), "0.3");
});

test("overtime labels follow the configured rule for monthly and annual team views", async () => {
  const html = await dashboardResponse().text();
  const labelFunction = html.match(/function wsOvertimeLabel\(days\) \{[\s\S]*?\n\}/)[0];
  const ws = { page: "timesheets", overview: { overtimeMode: "disabled" }, annual: null };
  const label = runInNewContext("(" + labelFunction + ")", { ws, wsModel: model });
  const paidLunchDay = [{ paidLunchMinutes: 30, overtimeMinutes: 0 }];
  assert.equal(label(paidLunchDay), "Off");
  ws.overview.overtimeMode = "daily";
  assert.equal(label(paidLunchDay), "0h 00m");
  assert.equal(label([{ overtimeMinutes: 45 }, { overtimeMinutes: 30 }]), "1h 15m");
  ws.page = "stats";
  ws.annual = { overtimeMode: "disabled" };
  assert.equal(label(paidLunchDay), "Off");
  ws.annual.overtimeMode = "weekly";
  ws.overview = null;
  assert.equal(label([]), "0h 00m");
  assert.equal(label([{ overtimeMinutes: 90 }]), "1h 30m");
});

test("the shipped workspace script parses and its model survives bundler name preservation", async () => {
  const html = await dashboardResponse().text();
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new Script(script);
  assert.match(html, /data-page="timesheets"/);
  assert.match(html, /data-page="stats"/);
  assert.doesNotMatch(html, /Preview as|SAMPLE DATA|Form Studio/);
  const { code } = await transformWithEsbuild(createWorkspaceModel.toString(), "workspace-model.js", { keepNames: true, target: "es2022" });
  const bundled = runInNewContext(code + "; createWorkspaceModel");
  const embedded = runInNewContext("(" + bundled.toString() + ")")();
  assert.equal(embedded.duration(61), "1h 01m");
  assert.equal(embedded.dayEntries([], null).length, 0);
});
