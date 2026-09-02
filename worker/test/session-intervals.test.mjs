import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeTimeIntervals,
  unionMinutes,
} from "../.tmp-test/session-intervals.js";

const minute = 60_000;

test("overlapping laptop sessions count elapsed time only once", () => {
  const intervals = [
    { start: 9 * 60 * minute, end: 12 * 60 * minute },
    { start: 10 * 60 * minute, end: 13 * 60 * minute },
  ];

  assert.deepEqual(mergeTimeIntervals(intervals), [
    { start: 9 * 60 * minute, end: 13 * 60 * minute },
  ]);
  assert.equal(unionMinutes(intervals), 4 * 60);
});

test("nested, adjacent, and unordered sessions merge without regressing the end", () => {
  const intervals = [
    { start: 12 * minute, end: 15 * minute },
    { start: 0, end: 10 * minute },
    { start: 2 * minute, end: 5 * minute },
    { start: 10 * minute, end: 12 * minute },
  ];

  assert.deepEqual(mergeTimeIntervals(intervals), [
    { start: 0, end: 15 * minute },
  ]);
});

test("real gaps remain separate and invalid intervals are ignored", () => {
  const intervals = [
    { start: 0, end: 30 * minute },
    { start: 45 * minute, end: 75 * minute },
    { start: 20, end: 20 },
    { start: Number.NaN, end: 100 },
  ];

  assert.deepEqual(mergeTimeIntervals(intervals), [
    { start: 0, end: 30 * minute },
    { start: 45 * minute, end: 75 * minute },
  ]);
  assert.equal(unionMinutes(intervals), 60);
});
