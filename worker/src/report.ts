import type { Env } from "./types";
import { projectTotalsForPeriod } from "./activity.js";
import { expandCalendarDays } from "./calendar-days.js";
import {
  unionMinutes,
  type TimeInterval,
} from "./session-intervals.js";
import {
  formatDateLabel,
  formatHM,
  localYMD,
  monthBoundsUtc,
  nextLocalMidnightUtc,
} from "./time.js";

interface ZonedTimeInterval extends TimeInterval {
  startTimezone: string;
  endTimezone: string;
}

interface LocalDayIntervals {
  date: string;
  label: string;
  intervals: ZonedTimeInterval[];
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
function splitSessions(
  rows: readonly SessionRow[],
  period: string,
  fallbackTz: string,
): { grouped: Map<string, LocalDayIntervals>; sessions: SessionSegment[] } {
  const sessions: SessionSegment[] = [];
  const byDay = new Map<string, LocalDayIntervals>();
  for (const row of rows) {
    const tz = validTimezoneOr(row.timezone, fallbackTz);
    const { start, end } = monthBoundsUtc(period, tz);
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
      const interval = {
        start: segStart.getTime(),
        end: segEnd.getTime(),
        startTimezone: tz,
        endTimezone: tz,
      };
      if (existing) existing.intervals.push(interval);
      else {
        byDay.set(date, {
          date,
          label: formatDateLabel(segStart, tz),
          intervals: [interval],
        });
      }
      const startMin = localMinutesFromMidnight(segStart, tz);
      const endMinRaw = localMinutesFromMidnight(segEnd, tz);
      const endMin = endMinRaw === 0 && segEnd > segStart ? 1440 : endMinRaw;
      sessions.push({
        id: row.id,
        date,
        start: formatHM(segStart, tz),
        end: formatHM(segEnd, tz),
        minutes: Math.max(0, Math.round((segEnd.getTime() - segStart.getTime()) / 60000)),
        startMs: segStart.getTime(),
        endMs: segEnd.getTime(),
        startMin,
        endMin: Math.max(endMin, startMin + 1),
        start_reason: row.start_reason,
        end_reason: row.end_reason,
        source: row.start_reason === "manual" ? "manual" : "app",
        timezone: tz,
      });
      segStart = segEnd;
    }
  }
  return { grouped: byDay, sessions };
}

/** Query broadly enough to include a local month in every supported timezone;
 * each row is then clamped to its own exact local month. */
function periodQueryBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const padding = 15 * 60 * 60 * 1000;
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - padding),
    end: new Date(Date.UTC(nextY, nextM - 1, 1) + padding),
  };
}

/** Timezone the desktop recorded on local `date` ("YYYY-MM-DD"), i.e. where the
 * user was that work day; `fallback` when no desktop session exists that day. */
export async function timezoneForLocalDate(
  env: Env,
  userId: string,
  date: string,
  fallback: string,
): Promise<string> {
  const [y, m, d] = date.split("-").map(Number);
  const dayStartUtc = Date.UTC(y, m - 1, d);
  const hour = 60 * 60 * 1000;
  const res = await env.DB.prepare(
    `SELECT start_utc, timezone FROM sessions
      WHERE user_id = ? AND timezone IS NOT NULL AND COALESCE(start_reason, '') != 'manual'
        AND start_utc >= ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(
      userId,
      new Date(dayStartUtc - 14 * hour).toISOString(),
      new Date(dayStartUtc + 36 * hour).toISOString(),
    )
    .all<{ start_utc: string; timezone: string }>();
  for (const row of res.results ?? []) {
    const tz = validTimezoneOr(row.timezone, "");
    if (!tz) continue;
    const local = localYMD(new Date(row.start_utc), tz);
    if (`${local.y}-${String(local.m).padStart(2, "0")}-${String(local.d).padStart(2, "0")}` === date) {
      return tz;
    }
  }
  return fallback;
}

function validTimezoneOr(timezone: string | null | undefined, fallback: string): string {
  if (!timezone) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return fallback;
  }
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
  timezone: string;
}

interface SessionRow {
  id: string;
  start_utc: string;
  end_utc: string;
  start_reason: string | null;
  end_reason: string | null;
  timezone: string | null;
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
  inTimezone: string;
  out: Date;
  outTimezone: string;
  minutes: number;
  breaks: string[];
}

function mergeZonedTimeIntervals(intervals: ZonedTimeInterval[]): ZonedTimeInterval[] {
  const sorted = intervals
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ZonedTimeInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else if (interval.end > last.end) {
      last.end = interval.end;
      last.endTimezone = interval.endTimezone;
    }
  }
  return merged;
}

export interface Timesheet {
  report: HoursReport;
  sessions: SessionSegment[];
  projects: Awaited<ReturnType<typeof projectTotalsForPeriod>>;
  csv: string;
}

/** Load one account's month once; all presentations share the same day accounting. */
export async function buildTimesheet({
  env,
  period,
  userId,
  timezone = env.REPORT_TZ,
  includeProjects = true,
  now = new Date(),
}: {
  env: Env;
  period: string;
  userId: string;
  timezone?: string;
  includeProjects?: boolean;
  now?: Date;
}): Promise<Timesheet> {
  const { start, end } = periodQueryBounds(period);

  const res = await env.DB.prepare(
    `SELECT id, start_utc, end_utc, start_reason, end_reason, timezone FROM sessions
      WHERE user_id = ? AND end_utc IS NOT NULL AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
    .all<SessionRow>();

  // Collapse each local day to the union of its sessions. This preserves real
  // gaps while ensuring overlapping sessions from multiple devices count once.
  const spanByDate = new Map<string, DaySpan>();
  const labelByDate = new Map<string, string>();
  const { grouped, sessions } = splitSessions(res.results ?? [], period, timezone);
  for (const { date, label, intervals } of grouped.values()) {
    const merged = mergeZonedTimeIntervals(intervals);
    if (merged.length === 0) continue;
    const breaks: string[] = [];
    for (let i = 1; i < merged.length; i++) {
      const previous = merged[i - 1];
      const current = merged[i];
      if (current.start - previous.end >= MIN_BREAK_MS) {
        breaks.push(
          `${formatHM(new Date(previous.end), previous.endTimezone)}-${formatHM(new Date(current.start), current.startTimezone)}`,
        );
      }
    }
    spanByDate.set(date, {
      in: new Date(merged[0].start),
      inTimezone: merged[0].startTimezone,
      out: new Date(merged[merged.length - 1].end),
      outTimezone: merged[merged.length - 1].endTimezone,
      minutes: unionMinutes(merged),
      breaks,
    });
    labelByDate.set(date, label);
  }

  // Expand to calendar days (past months in full, current month through today)
  // so every gap between logged days is visible for vacation marking.
  const seed = [...spanByDate].map(([date, span]) => ({
    date,
    label: labelByDate.get(date) ?? "",
    minutes: span.minutes,
  }));
  const expanded = expandCalendarDays(
    seed.sort((a, b) => a.date.localeCompare(b.date)), period, localYMD(now, timezone),
  );
  // Monthly totals include recorded days even when calendar expansion hides them.
  const report: HoursReport = {
    period,
    tz: timezone,
    days: expanded.days,
    activeDays: expanded.activeDays,
    totalMinutes: seed.reduce((sum, day) => sum + day.minutes, 0),
  };
  const projects = includeProjects ? await projectTotalsForPeriod(env, userId, period) : [];
  return { report, sessions, projects, csv: renderCsv(expanded.days, spanByDate, projects) };
}

function renderCsv(
  calendarDays: DayHours[],
  spanByDate: Map<string, DaySpan>,
  projects: Timesheet["projects"],
): string {
  if (spanByDate.size === 0) return "";

  const lines = ["Date,Clock In,Clock Out,Breaks,Hours Worked"];
  let totalMinutes = 0;
  for (const day of calendarDays) {
    const span = spanByDate.get(day.date);
    if (span) {
      lines.push(
        `${csvField(day.label)},${formatHM(span.in, span.inTimezone)},${formatHM(span.out, span.outTimezone)},${csvField(span.breaks.join("; "))},${formatHours(span.minutes)}`,
      );
      totalMinutes += span.minutes;
    } else if (isWorkDay(day.date)) {
      lines.push(`${csvField(day.label)},Vacation,,,`);
    }
  }

  lines.push(",,,,");
  lines.push(`,,,Total,${formatHours(totalMinutes)}`);

  // Optional project summary from synced app aggregates (no titles/URLs).
  if (projects.length > 0) {
    lines.push("");
    lines.push("Project,Hours");
    for (const p of projects) {
      lines.push(`${csvField(p.project)},${formatHours(p.minutes)}`);
    }
  }

  return lines.join("\n") + "\n";
}
