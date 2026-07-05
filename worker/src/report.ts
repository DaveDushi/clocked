import type { Env } from "./types";
import {
  formatDateLabel,
  formatHM,
  monthBoundsUtc,
  nextLocalMidnightUtc,
} from "./time";

interface Row {
  start_utc: string;
  end_utc: string;
}

/**
 * Build the tab-separated report body for `period` ("YYYY-MM").
 * One row per session, `Weekday, Month D, YYYY\tHH:MM\tHH:MM`, ordered by
 * start. Sessions are clamped to the month and split at every local midnight
 * so each row stays within a single local day.
 */
export async function buildReportTsv(env: Env, period: string): Promise<string> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT start_utc, end_utc FROM sessions
      WHERE end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(start.toISOString(), end.toISOString())
    .all<Row>();

  const lines: string[] = [];
  for (const r of res.results ?? []) {
    let segStart = new Date(Math.max(Date.parse(r.start_utc), start.getTime()));
    const sessEnd = new Date(Math.min(Date.parse(r.end_utc), end.getTime()));

    while (segStart < sessEnd) {
      const midnight = nextLocalMidnightUtc(segStart, tz);
      const segEnd = midnight < sessEnd ? midnight : sessEnd;
      lines.push(
        `${formatDateLabel(segStart, tz)}\t${formatHM(segStart, tz)}\t${formatHM(segEnd, tz)}`,
      );
      segStart = segEnd;
    }
  }

  return lines.length ? lines.join("\n") + "\n" : "";
}
