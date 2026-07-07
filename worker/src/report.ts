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
 * query and split-at-local-midnight logic as `buildReportCsv`. Dashboard rows
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

/** Quote a CSV field when it contains a comma, quote, or newline (the date
 * label "Monday, June 29, 2026" always needs it), doubling embedded quotes. */
function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Format a minute total as "H:MM" (e.g. 150 -> "2:30"). */
export function formatHours(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** True for Monday–Friday of the local calendar date "YYYY-MM-DD". */
export function isWorkDay(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sun … 6 = Sat
  return dow >= 1 && dow <= 5;
}

/** First clock-in, last clock-out, worked minutes, and between-session breaks
 * (each `"HH:MM-HH:MM"`) for one local day. */
interface DaySpan {
  in: Date;
  out: Date;
  minutes: number;
  breaks: string[];
}

/**
 * Build the CSV report body for `period` ("YYYY-MM"). A clear
 * `Date,Clock In,Clock Out,Breaks,Hours Worked` header leads; then one row per
 * worked day: earliest clock-in, latest clock-out, the gaps between sessions
 * (breaks), and total time actually worked (clock-out minus clock-in, minus the
 * breaks). Sessions are clamped to the month and split at every local midnight
 * so each day is summed in its own local day. A work day (Mon–Fri) with no
 * sessions shows `Vacation`, and a trailing row puts the month's total under the
 * Hours Worked column. Empty months (no sessions at all) still produce no output.
 */
export async function buildReportCsv(env: Env, period: string, userId: string): Promise<string> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT start_utc, end_utc FROM sessions
      WHERE user_id = ? AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
    .all<Row>();

  // Collapse each local day to first clock-in / last clock-out / worked minutes,
  // recording the gap before each later session as a break. Sessions arrive
  // ordered by start, so the first segment seen is the earliest.
  const spanByDate = new Map<string, DaySpan>();
  const labelByDate = new Map<string, string>();
  for (const r of res.results ?? []) {
    let segStart = new Date(Math.max(Date.parse(r.start_utc), start.getTime()));
    const sessEnd = new Date(Math.min(Date.parse(r.end_utc), end.getTime()));

    while (segStart < sessEnd) {
      const midnight = nextLocalMidnightUtc(segStart, tz);
      const segEnd = midnight < sessEnd ? midnight : sessEnd;
      const { y, m, d } = localYMD(segStart, tz);
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const minutes = Math.round((segEnd.getTime() - segStart.getTime()) / 60000);
      const span = spanByDate.get(date);
      if (span) {
        if (segStart > span.out) span.breaks.push(`${formatHM(span.out, tz)}-${formatHM(segStart, tz)}`);
        span.out = segEnd; // later segment → newer clock-out
        span.minutes += minutes;
      } else {
        spanByDate.set(date, { in: segStart, out: segEnd, minutes, breaks: [] });
        labelByDate.set(date, formatDateLabel(segStart, tz));
      }
      segStart = segEnd;
    }
  }

  // No work logged this month → keep the historical empty-report behavior.
  if (spanByDate.size === 0) return "";

  // Expand to calendar days (past months in full, current month through today)
  // so every gap between logged days is visible for vacation marking.
  const seed = [...spanByDate].map(([date, span]) => ({
    date,
    label: labelByDate.get(date) ?? "",
    minutes: span.minutes,
  }));
  const calendarDays = expandCalendarDays(seed, period, localYMD(new Date(), tz)).days;

  const lines = ["Date,Clock In,Clock Out,Breaks,Hours Worked"];
  let totalMinutes = 0;
  for (const day of calendarDays) {
    const span = spanByDate.get(day.date);
    if (span) {
      lines.push(
        `${csvField(day.label)},${formatHM(span.in, tz)},${formatHM(span.out, tz)},${csvField(span.breaks.join("; "))},${formatHours(span.minutes)}`,
      );
      totalMinutes += span.minutes;
    } else if (isWorkDay(day.date)) {
      lines.push(`${csvField(day.label)},Vacation,,,`);
    }
  }

  lines.push(",,,,");
  lines.push(`,,,Total,${formatHours(totalMinutes)}`);
  return lines.join("\n") + "\n";
}
