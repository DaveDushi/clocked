import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReportPeriod, reportDateBounds, reportBoundsUtc, reportPeriodTitle } from "../.tmp-test/time.js";
import { summarizeMonth } from "../.tmp-test/report.js";

test("calendar months include leap days and roll December into the next year", () => {
  assert.deepEqual(parseReportPeriod("2024-02"), { kind: "month", start: "2024-02-01", end: "2024-03-01" });
  assert.deepEqual(reportDateBounds("2026-12"), { start: "2026-12-01", end: "2027-01-01" });
  assert.equal(reportPeriodTitle("2024-02"), "February 2024");
  assert.equal(summarizeMonth([], "2024-02", "UTC", new Date("2024-03-01")).report.days.length, 29);
});

test("seven-day periods keep all calendar dates when crossing a year", () => {
  assert.deepEqual(parseReportPeriod("2026-12-28"), { kind: "week", start: "2026-12-28", end: "2027-01-04" });
  assert.equal(reportPeriodTitle("2026-12-28"), "2026-12-28 to 2027-01-03");
  assert.deepEqual(summarizeMonth([], "2026-12-28", "UTC", new Date("2026-12-29")).report.days.map(day => day.date), [
    "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
  ]);
});

test("monthly calendar expansion still stops today and hides future months", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  assert.deepEqual(summarizeMonth([], "2026-09", "UTC", now).report.days.map(day => day.date), [
    "2026-09-01", "2026-09-02", "2026-09-03",
  ]);
  assert.deepEqual(summarizeMonth([], "2026-10", "UTC", now).report.days, []);
});

test("month and week bounds follow local midnight through daylight saving", () => {
  const month = reportBoundsUtc("2026-03", "Europe/Berlin");
  assert.equal(month.start.toISOString(), "2026-02-28T23:00:00.000Z");
  assert.equal(month.end.toISOString(), "2026-03-31T22:00:00.000Z");
  const week = reportBoundsUtc("2026-03-23", "Europe/Berlin");
  assert.equal(week.start.toISOString(), "2026-03-22T23:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-03-29T22:00:00.000Z");
});
