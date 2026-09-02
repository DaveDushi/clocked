import type { Env } from "./types";
import { projectTotalsForPeriod } from "./activity";
import { expandCalendarDays } from "./calendar-days";
import {
  mergeTimeIntervals,
  unionMinutes,
  type TimeInterval,
} from "./session-intervals";
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

interface LocalDayIntervals {
  date: string;
  label: string;
  intervals: TimeInterval[];
}

/** Gaps shorter than this are lock/unlock, suspend/resume, or app-relaunch
 * blips — not real breaks — so they're omitted from the Breaks column. Worked
 * minutes are the union of session intervals and are unaffected either way. */
const MIN_BREAK_MS = 2 * 60 * 1000;

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

/** Clamp sessions to a month, split them at local midnight, and group by day. */
function intervalsByLocalDay(
  rows: readonly Row[],
  start: Date,
  end: Date,
  tz: string,
): Map<string, LocalDayIntervals> {
  const byDay = new Map<string, LocalDayIntervals>();
  for (const row of rows) {
    const rawStart = Date.parse(row.start_utc);
    const rawEnd = Date.parse(row.end_utc);
    if (Number.isNaN(rawStart) || Number.isNaN(rawEnd) || rawEnd <= rawStart) continue;

    let segStart = new Date(Math.max(rawStart, start.getTime()));
    const sessionEnd = new Date(Math.min(rawEnd, end.getTime()));
    while (segStart < sessionEnd) {
      const midnight = nextLocalMidnightUtc(segStart, tz);
      const segEnd = midnight < sessionEnd ? midnight : sessionEnd;
      const { y, m, d } = localYMD(segStart, tz);
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const existing = byDay.get(date);
      const interval = { start: segStart.getTime(), end: segEnd.getTime() };
      if (existing) existing.intervals.push(interval);
      else {
        byDay.set(date, {
          date,
          label: formatDateLabel(segStart, tz),
          intervals: [interval],
        });
      }
      segStart = segEnd;
    }
  }
  return byDay;
}

/** One local-day slice of a closed session for the dashboard timeline. */
export interface SessionSegment {
  /** Session row id (same for every midnight-split slice of one session). */
  id: string;
  date: string; // local "YYYY-MM-DD" of this slice
  start: string; // "HH:MM" local
  end: string;
  minutes: number;
  /** Absolute bounds for overlap-safe totals in the dashboard timeline. */
  startMs: number;
  endMs: number;
  /** Minutes from local midnight (for bar layout). */
  startMin: number;
  endMin: number;
  start_reason: string | null;
  end_reason: string | null;
  source: "manual" | "app";
}

interface SessionRow {
  id: string;
  start_utc: string;
  end_utc: string;
  start_reason: string | null;
  end_reason: string | null;
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

  const grouped = intervalsByLocalDay(res.results ?? [], start, end, tz);
  const days = [...grouped.values()]
    .map(({ date, label, intervals }) => ({
      date,
      label,
      minutes: unionMinutes(intervals),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0);
  const expanded = expandCalendarDays(days, period, localYMD(new Date(), tz));
  return { period, tz, days: expanded.days, activeDays: expanded.activeDays, totalMinutes };
}

/**
 * Closed sessions for `period`, split at local midnight so each segment stays
 * within one day (matches CSV / hours accounting). Used by the dashboard
 * timeline and the manual-session list.
 */
export async function listSessionsForPeriod(
  env: Env,
  period: string,
  userId: string,
): Promise<SessionSegment[]> {
  const tz = env.REPORT_TZ;
  const { start, end } = monthBoundsUtc(period, tz);

  const res = await env.DB.prepare(
    `SELECT id, start_utc, end_utc, start_reason, end_reason FROM sessions
      WHERE user_id = ? AND end_utc IS NOT NULL AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
    .all<SessionRow>();

  const out: SessionSegment[] = [];
  for (const r of res.results ?? []) {
    const sessStart = Date.parse(r.start_utc);
    const sessEnd = Date.parse(r.end_utc);
    if (Number.isNaN(sessStart) || Number.isNaN(sessEnd) || sessEnd <= sessStart) continue;

    let segStart = new Date(Math.max(sessStart, start.getTime()));
    const hardEnd = new Date(Math.min(sessEnd, end.getTime()));
    while (segStart < hardEnd) {
      const midnight = nextLocalMidnightUtc(segStart, tz);
      const segEnd = midnight < hardEnd ? midnight : hardEnd;
      const { y, m, d } = localYMD(segStart, tz);
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const startMin = localMinutesFromMidnight(segStart, tz);
      const endMinRaw = localMinutesFromMidnight(segEnd, tz);
      // Midnight end of a day is 1440, not 0 of the next day.
      const endMin = endMinRaw === 0 && segEnd.getTime() > segStart.getTime() ? 1440 : endMinRaw;
      const minutes = Math.max(0, Math.round((segEnd.getTime() - segStart.getTime()) / 60000));
      const reason = r.start_reason || "app";
      out.push({
        id: r.id,
        date,
        start: formatHM(segStart, tz),
        end: formatHM(segEnd, tz),
        minutes,
        startMs: segStart.getTime(),
        endMs: segEnd.getTime(),
        startMin,
        endMin: Math.max(endMin, startMin + 1),
        start_reason: r.start_reason,
        end_reason: r.end_reason,
        source: reason === "manual" ? "manual" : "app",
      });
      segStart = segEnd;
    }
  }
  return out;
}

/** Local wall-clock minutes since midnight in `tz` (0–1439). */
function localMinutesFromMidnight(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
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
 * breaks). Sessions are clamped to the month, split at every local midnight,
 * and merged so simultaneous devices never double-count time. A work day
 * (Mon–Fri) with no
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

  // Collapse each local day to the union of its sessions. This preserves real
  // gaps while ensuring overlapping sessions from multiple devices count once.
  const spanByDate = new Map<string, DaySpan>();
  const labelByDate = new Map<string, string>();
  const grouped = intervalsByLocalDay(res.results ?? [], start, end, tz);
  for (const { date, label, intervals } of grouped.values()) {
    const merged = mergeTimeIntervals(intervals);
    if (merged.length === 0) continue;
    const breaks: string[] = [];
    for (let i = 1; i < merged.length; i++) {
      const previous = merged[i - 1];
      const current = merged[i];
      if (current.start - previous.end >= MIN_BREAK_MS) {
        breaks.push(
          `${formatHM(new Date(previous.end), tz)}-${formatHM(new Date(current.start), tz)}`,
        );
      }
    }
    spanByDate.set(date, {
      in: new Date(merged[0].start),
      out: new Date(merged[merged.length - 1].end),
      minutes: unionMinutes(merged),
      breaks,
    });
    labelByDate.set(date, label);
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

  // Optional project summary from synced app aggregates (no titles/URLs).
  const projects = await projectTotalsForPeriod(env, userId, period);
  if (projects.length > 0) {
    lines.push("");
    lines.push("Project,Hours");
    for (const p of projects) {
      lines.push(`${csvField(p.project)},${formatHours(p.minutes)}`);
    }
  }

  return lines.join("\n") + "\n";
}
