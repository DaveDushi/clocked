import assert from "node:assert/strict";
import { test } from "node:test";
import { expandCalendarDays } from "../.tmp-test/calendar-days.js";

const sampleDays = [
  { date: "2026-07-04", label: "Saturday, July 4, 2026", minutes: 90 },
];

test("current month expands through today so the current day can be shown", () => {
  const result = expandCalendarDays(sampleDays, "2026-07", new Date("2026-07-06T15:00:00Z"));

  assert.equal(result.activeDays, 1);
  assert.deepEqual(result.days.map((d) => d.date), [
    "2026-07-01",
    "2026-07-02",
    "2026-07-03",
    "2026-07-04",
    "2026-07-05",
    "2026-07-06",
  ]);
  assert.equal(result.days[3].minutes, 90);
  assert.equal(result.days[5].minutes, 0);
});

test("past months expand to the whole month for seven-row scrolling", () => {
  const result = expandCalendarDays([], "2026-06", new Date("2026-07-06T15:00:00Z"));

  assert.equal(result.activeDays, 0);
  assert.equal(result.days.length, 30);
  assert.equal(result.days[0].date, "2026-06-01");
  assert.equal(result.days[29].date, "2026-06-30");
});

test("future months stay empty", () => {
  const result = expandCalendarDays([], "2026-08", new Date("2026-07-06T15:00:00Z"));

  assert.deepEqual(result.days, []);
  assert.equal(result.activeDays, 0);
});
