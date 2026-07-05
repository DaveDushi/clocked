import type { Env } from "./types";
import {
  formatDateLabel,
  formatHM,
  localYMD,
  monthBoundsUtc,
  nextLocalMidnightUtc,
} from "./time";

interface Row {
  start_utc: string;
  end_utc: string;
}

export interface DayHours {
  date: string; // "YYYY-MM-DD" (local)
  label: string; // e.g. "Monday, June 29, 2026"
  minutes: number;
}

export interface HoursReport {
  period: string; // "YYYY-MM"
  tz: string;
  days: DayHours[];
  totalMinutes: number;
}

/**
 * Structured per-local-day totals for `period` ("YYYY-MM"), reusing the same
 * query and split-at-local-midnight logic as `buildReportTsv`. Days with no
 * time are omitted; `days` is ordered ascending by date.
 */
export async function buildHoursReport(env: Env, period: string): Promise<HoursReport> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT start_utc, end_utc FROM sessions
      WHERE end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(start.toISOString(), end.toISOString())
    .all<Row>();

  const byDay = new Map<string, DayHours>();
  for (const r of res.results ?? []) {
    let segStart = new Date(Math.max(Date.parse(r.start_utc), start.getTime()));
    const sessEnd = new Date(Math.min(Date.parse(r.end_utc), end.getTime()));

    while (segStart < sessEnd) {
      const midnight = nextLocalMidnightUtc(segStart, tz);
      const segEnd = midnight < sessEnd ? midnight : sessEnd;
      const { y, m, d } = localYMD(segStart, tz);
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const minutes = Math.round((segEnd.getTime() - segStart.getTime()) / 60000);
      const existing = byDay.get(date);
      if (existing) existing.minutes += minutes;
      else byDay.set(date, { date, label: formatDateLabel(segStart, tz), minutes });
      segStart = segEnd;
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0);
  return { period, tz, days, totalMinutes };
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
