import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportCsv, timezoneForLocalDate } from "../.tmp-test/report.js";

function envWithSessions(sessions) {
  return {
    REPORT_TZ: "UTC",
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("FROM sessions")) return { results: sessions };
            return { results: [] };
          },
          async first() {
            return { track_projects: 0 };
          },
        };
      },
    },
  };
}

test("CSV report uses the explicitly supplied user timezone", async () => {
  const env = envWithSessions([
    {
      start_utc: "2026-09-01T00:30:00.000Z",
      end_utc: "2026-09-01T02:00:00.000Z",
      timezone: null,
    },
  ]);

  const csv = await buildReportCsv(env, "2026-09", "user-1", "Asia/Jerusalem");

  assert.match(csv, /Tuesday, September 1, 2026.*03:30,05:00/);
  assert.doesNotMatch(csv, /00:30,02:00/);
});

test("CSV renders travel days in the timezone captured on each session", async () => {
  const env = envWithSessions([
    {
      start_utc: "2026-09-01T13:00:00.000Z",
      end_utc: "2026-09-01T14:00:00.000Z",
      timezone: "America/New_York",
    },
    {
      start_utc: "2026-09-10T13:00:00.000Z",
      end_utc: "2026-09-10T14:00:00.000Z",
      timezone: "Asia/Jerusalem",
    },
  ]);

  const csv = await buildReportCsv(env, "2026-09", "traveler", "UTC");

  assert.match(csv, /Tuesday, September 1, 2026.*09:00,10:00/);
  assert.match(csv, /Thursday, September 10, 2026.*16:00,17:00/);
});

test("manual entries use where the desktop was on that local day", async () => {
  const env = envWithSessions([
    // 2026-09-02 03:00Z is still Sep 1 in New York, so it must not count for Sep 2.
    { start_utc: "2026-09-02T03:00:00.000Z", timezone: "America/New_York" },
    { start_utc: "2026-09-02T13:00:00.000Z", timezone: "America/New_York" },
  ]);

  assert.equal(
    await timezoneForLocalDate(env, "traveler", "2026-09-02", "Asia/Jerusalem"),
    "America/New_York",
  );
  assert.equal(
    await timezoneForLocalDate(env, "traveler", "2026-09-03", "Asia/Jerusalem"),
    "Asia/Jerusalem",
  );
});
