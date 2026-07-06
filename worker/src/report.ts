import type { Env } from "./types";
import { expandCalendarDays } from "./calendar-days";
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
  activeDays: number;
  totalMinutes: number;
}

/**
 * Structured per-local-day totals for `period` ("YYYY-MM"), reusing the same
 * query and split-at-local-midnight logic as `buildReportTsv`. Dashboard rows
 * are expanded to calendar days: past months include every day, current month
 * includes day 1 through today, and future months stay empty.
 */
export async function buildHoursReport(
  env: Env,
  period: string,
  userId: string,
): Promise<HoursReport> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT start_utc, end_utc FROM sessions
      WHERE user_id = ? AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
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
  const expanded = expandCalendarDays(days, period, localYMD(new Date(), tz));
  return { period, tz, days: expanded.days, activeDays: expanded.activeDays, totalMinutes };
}

/**
 * Build the tab-separated report body for `period` ("YYYY-MM").
 * One row per session, `Weekday, Month D, YYYY\tHH:MM\tHH:MM`, ordered by
 * start. Sessions are clamped to the month and split at every local midnight
 * so each row stays within a single local day.
 */
export async function buildReportTsv(env: Env, period: string, userId: string): Promise<string> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT start_utc, end_utc FROM sessions
      WHERE user_id = ? AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
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
