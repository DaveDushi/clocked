import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isScheduleDue,
  isValidSendDay,
  isValidSendTime,
  isValidTimeZone,
  periodForSchedule,
} from "../.tmp-test/schedule.js";

test("delivery schedule fields are strictly validated", () => {
  assert.equal(isValidSendDay(0), true);
  assert.equal(isValidSendDay(28), true);
  assert.equal(isValidSendDay(99), true);
  assert.equal(isValidSendDay(29), false);
  assert.equal(isValidSendDay("1"), false);

  assert.equal(isValidSendTime("00:00"), true);
  assert.equal(isValidSendTime("23:59"), true);
  assert.equal(isValidSendTime("9:00"), false);
  assert.equal(isValidSendTime("24:00"), false);

  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Not/A_Timezone"), false);
});

test("a schedule is due at its wall-clock minute in its timezone", () => {
  const schedule = { day: 1, time: "09:30", timezone: "America/New_York" };
  assert.equal(isScheduleDue(schedule, new Date("2026-09-01T13:30:00Z")), true);
  assert.equal(isScheduleDue(schedule, new Date("2026-09-01T13:29:00Z")), false);
  assert.equal(isScheduleDue(schedule, new Date("2026-09-02T13:30:00Z")), false);
  assert.equal(periodForSchedule(schedule, new Date("2026-09-01T13:30:00Z")), "2026-08");
});

test("last-day schedules account for month length and non-hour offsets", () => {
  const schedule = { day: 99, time: "12:45", timezone: "Asia/Kolkata" };
  assert.equal(isScheduleDue(schedule, new Date("2026-02-28T07:15:00Z")), true);
  assert.equal(isScheduleDue(schedule, new Date("2026-02-27T07:15:00Z")), false);
});

test("DST gaps and repeats resolve to one stable instant", () => {
  const spring = { day: 8, time: "02:30", timezone: "America/New_York" };
  assert.equal(isScheduleDue(spring, new Date("2026-03-08T07:30:00Z")), true);

  const fall = { day: 1, time: "01:30", timezone: "America/New_York" };
  assert.equal(isScheduleDue(fall, new Date("2026-11-01T05:30:00Z")), true);
  assert.equal(isScheduleDue(fall, new Date("2026-11-01T06:30:00Z")), false);
});

test("disabled schedules never become due", () => {
  const schedule = { day: 0, time: "06:00", timezone: "UTC" };
  assert.equal(isScheduleDue(schedule, new Date("2026-09-01T06:00:00Z")), false);
});
