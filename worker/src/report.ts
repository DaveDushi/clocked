import { sessionInScope, type SessionScope } from "./team-scope.js";
import type { Env } from "./types";
import { DEFAULT_TIME_POLICY, getTimePolicy, type TimePolicy } from "./time-policy.js";
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
  parseReportPeriod,
  reportBoundsUtc,
  reportDateBounds,
  nextLocalMidnightUtc,
} from "./time.js";

interface ZonedTimeInterval extends TimeInterval {
  startTimezone: string;
  endTimezone: string;
  /** Why recorded presence stopped at `end`, as stored with the session. */
  endCause: BreakCause;
}

/** Recorded clock-out reason that opened a break. "entry" marks time typed into
 * the dashboard, whose end says nothing about why the person stopped. */
export type BreakCause =
  | "idle" | "lock" | "suspend" | "shutdown" | "quit" | "crash" | "manual" | "entry" | "unknown";

const RECORDED_CAUSES = new Set(["idle", "lock", "suspend", "shutdown", "quit", "crash", "manual"]);

function breakCause(row: SessionRow): BreakCause {
  if (row.edited_by != null) return "entry";
  const reason = (row.end_reason ?? "").toLowerCase();
  return RECORDED_CAUSES.has(reason) ? reason as BreakCause : "unknown";
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
  paidLunchMinutes?: number;
  overtimeMinutes?: number;
}

export interface DayBreak {
  start: string; // "HH:MM" local
  end: string;
  minutes: number;
  cause: BreakCause;
  lunch?: boolean;
  flagged?: boolean;
}

/** A local day with at least one session. Breaks are gaps between the day's
 * merged sessions, so overlapping devices never create or hide a break. */
export interface RecordedDay {
  date: string;
  minutes: number;
  start: string;
  end: string;
  breakMinutes: number;
  breaks: DayBreak[];
  recordedMinutes?: number;
  paidLunchMinutes?: number;
  overtimeMinutes?: number;
  longBreakCount?: number;
}

export interface HoursReport {
  period: string; // YYYY-MM month or YYYY-MM-DD week start
  tz: string;
  days: DayHours[];
  activeDays: number;
  totalMinutes: number;
  paidLunchMinutes?: number;
  overtimeMinutes?: number;
}

/** Clamp sessions to the report period, split at local midnight, and group by day. */
function splitSessions(
  rows: readonly SessionRow[],
  period: string,
  fallbackTz: string,
): { grouped: Map<string, LocalDayIntervals>; sessions: SessionSegment[] } {
  const sessions: SessionSegment[] = [];
  const byDay = new Map<string, LocalDayIntervals>();
  for (const row of rows) {
    const tz = validTimezoneOr(row.timezone, fallbackTz);
    const { start, end } = reportBoundsUtc(period, tz);
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
        endCause: breakCause(row),
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
        sessionStartUtc: new Date(rawStart).toISOString(),
        sessionEndUtc: new Date(rawEnd).toISOString(),
        entry: row.edited_by == null ? null : row.replaces_id == null ? "added" : "edited",
        editor: row.edited_by == null ? null : row.edited_by === row.user_id ? "self" : "other",
      });
      segStart = segEnd;
    }
  }
  return { grouped: byDay, sessions };
}

/** Include the local report period in every supported timezone, then clamp each row. */
export function periodQueryBounds(period: string): { start: Date; end: Date } {
  const dates = reportDateBounds(period);
  const padding = 15 * 60 * 60 * 1000;
  return {
    start: new Date(Date.parse(dates.start + "T00:00:00Z") - padding),
    end: new Date(Date.parse(dates.end + "T00:00:00Z") + padding),
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

export function validTimezoneOr(timezone: string | null | undefined, fallback: string): string {
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
  /** Full session bounds, so an edit starts from the stored session rather
   * than from this day's slice. */
  sessionStartUtc: string;
  sessionEndUtc: string;
  /** Dashboard entries only: added as missing time, or replacing a session. */
  entry: "added" | "edited" | null;
  /** Who entered it: the account owner, or someone else (a team manager). */
  editor: "self" | "other" | null;
}

export interface SessionRow {
  id: string;
  user_id: string | null;
  start_utc: string;
  end_utc: string;
  start_reason: string | null;
  end_reason: string | null;
  timezone: string | null;
  edited_by: string | null;
  replaces_id: string | null;
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
export interface DaySpan {
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
      last.endCause = interval.endCause;
    }
  }
  return merged;
}

function expandWeek(seed: DayHours[], period: string): { days: DayHours[]; activeDays: number } {
  const byDate = new Map(seed.map((day) => [day.date, day]));
  const start = Date.parse(period + "T00:00:00Z");
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start + i * 86400000);
    const key = date.toISOString().slice(0, 10);
    return byDate.get(key) ?? { date: key, label: formatDateLabel(date, "UTC"), minutes: 0 };
  });
  return { days, activeDays: days.filter((day) => day.minutes > 0).length };
}

export interface Timesheet {
  report: HoursReport;
  sessions: SessionSegment[];
  recordedDays: RecordedDay[];
  projects: Awaited<ReturnType<typeof projectTotalsForPeriod>>;
  csv: string;
}

export const SESSION_COLUMNS =
  "id, user_id, start_utc, end_utc, start_reason, end_reason, timezone, edited_by, replaces_id";

export interface MonthSummary {
  report: HoursReport;
  sessions: SessionSegment[];
  recordedDays: RecordedDay[];
  spanByDate: Map<string, DaySpan>;
}

/** Day accounting for one account's closed sessions in a report period. */
export function summarizeMonth(
  rows: readonly SessionRow[],
  period: string,
  timezone: string,
  now: Date = new Date(),
  policy: TimePolicy = DEFAULT_TIME_POLICY,
): MonthSummary {
  // Collapse each local day to the union of its sessions. This preserves real
  // gaps while ensuring overlapping sessions from multiple devices count once.
  const spanByDate = new Map<string, DaySpan>();
  const labelByDate = new Map<string, string>();
  const recordedDays: RecordedDay[] = [];
  const { grouped, sessions } = splitSessions(rows, period, timezone);
  for (const { date, label, intervals } of grouped.values()) {
    const merged = mergeZonedTimeIntervals(intervals);
    if (merged.length === 0) continue;
    const breaks: DayBreak[] = [];
    let breakMs = 0;
    for (let i = 1; i < merged.length; i++) {
      const previous = merged[i - 1];
      const current = merged[i];
      const gap = current.start - previous.end;
      if (gap >= MIN_BREAK_MS) {
        breakMs += gap;
        breaks.push({
          start: formatHM(new Date(previous.end), previous.endTimezone),
          end: formatHM(new Date(current.start), current.startTimezone),
          minutes: Math.round(gap / 60_000),
          cause: previous.endCause,
        });
      }
    }
    const recordedMinutes = unionMinutes(merged);
    const lunch = policy.paidLunchMinutes > 0 ? breaks
      .filter((gap) => gap.minutes >= policy.lunchMinMinutes && gap.minutes <= policy.lunchMaxMinutes)
      .reduce<DayBreak | undefined>((longest, gap) => !longest || gap.minutes > longest.minutes ? gap : longest, undefined) : undefined;
    if (lunch) lunch.lunch = true;
    for (const gap of breaks) {
      if (policy.longBreakMinutes > 0 && gap !== lunch && gap.minutes > policy.longBreakMinutes) gap.flagged = true;
    }
    const paidLunchMinutes = Math.min(policy.paidLunchMinutes, lunch?.minutes ?? 0);
    const span: DaySpan = {
      in: new Date(merged[0].start),
      inTimezone: merged[0].startTimezone,
      out: new Date(merged[merged.length - 1].end),
      outTimezone: merged[merged.length - 1].endTimezone,
      minutes: recordedMinutes + paidLunchMinutes,
      breaks: breaks.map((x) => `${x.start}-${x.end}`),
    };
    spanByDate.set(date, span);
    labelByDate.set(date, label);
    recordedDays.push({
      date,
      minutes: span.minutes,
      start: formatHM(span.in, span.inTimezone),
      end: formatHM(span.out, span.outTimezone),
      breakMinutes: Math.round(breakMs / 60_000),
      breaks,
      ...(policy.longBreakMinutes > 0 ? { longBreakCount: breaks.filter((gap) => gap.flagged).length } : {}),
      ...(policy.paidLunchMinutes > 0 || policy.overtime.mode !== "disabled"
        ? { recordedMinutes, paidLunchMinutes, overtimeMinutes: 0 } : {}),
    });
  }
  recordedDays.sort((a, b) => a.date.localeCompare(b.date));

  if (policy.overtime.mode !== "disabled") {
    const totals = new Map<string, number>();
    if (policy.overtime.mode === "weekly") {
      const first = reportDateBounds(period).start;
      const monday = weekStart(first);
      if (monday < first) {
        const context = summarizeMonth(rows, monday, timezone, now, { ...policy, overtime: { mode: "disabled" } });
        totals.set(monday, context.recordedDays.filter((day) => day.date < first).reduce((sum, day) => sum + day.minutes, 0));
      }
    }
    for (const day of recordedDays) {
      const key = policy.overtime.mode === "daily" ? day.date : weekStart(day.date);
      const before = totals.get(key) ?? 0;
      const threshold = policy.overtime.thresholdMinutes;
      day.overtimeMinutes = Math.max(0, before + day.minutes - threshold) - Math.max(0, before - threshold);
      totals.set(key, before + day.minutes);
    }
  }

  // Expand to calendar days (past months in full, current month through today)
  // so every gap between logged days is visible for vacation marking.
  const seed = recordedDays.map((day) => ({
    date: day.date,
    label: labelByDate.get(day.date) ?? "",
    minutes: day.minutes,
    ...(day.paidLunchMinutes !== undefined ? { paidLunchMinutes: day.paidLunchMinutes, overtimeMinutes: day.overtimeMinutes } : {}),
  }));
  const expanded = parseReportPeriod(period).kind === "week" ? expandWeek(seed, period) : expandCalendarDays(
    seed.sort((a, b) => a.date.localeCompare(b.date)), period, localYMD(now, timezone),
  );
  // Monthly totals include recorded days even when calendar expansion hides them.
  const report: HoursReport = {
    period,
    tz: timezone,
    days: expanded.days,
    activeDays: expanded.activeDays,
    totalMinutes: seed.reduce((sum, day) => sum + day.minutes, 0),
    ...(policy.paidLunchMinutes > 0 || policy.overtime.mode !== "disabled" ? {
      paidLunchMinutes: recordedDays.reduce((sum, day) => sum + (day.paidLunchMinutes ?? 0), 0),
      overtimeMinutes: recordedDays.reduce((sum, day) => sum + (day.overtimeMinutes ?? 0), 0),
    } : {}),
  };
  return { report, sessions, recordedDays, spanByDate };
}

function weekStart(date: string): string {
  const day = new Date(date + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

/** Load one account's month once; all presentations share the same day accounting. */
export async function buildTimesheet({
  env,
  period,
  userId,
  timezone = env.REPORT_TZ,
  includeProjects = true,
  now = new Date(),
  scope,
  organizationId,
}: {
  env: Env;
  period: string;
  userId: string;
  timezone?: string;
  includeProjects?: boolean;
  now?: Date;
  scope: SessionScope;
  organizationId?: string;
}): Promise<Timesheet> {
  const policy = organizationId ? await getTimePolicy(env, organizationId) : DEFAULT_TIME_POLICY;
  const { start, end } = periodQueryBounds(period);
  if (policy.overtime.mode === "weekly") start.setUTCDate(start.getUTCDate() - 6);

  const res = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE user_id = ? AND end_utc IS NOT NULL AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc`,
  )
    .bind(userId, start.toISOString(), end.toISOString())
    .all<SessionRow>();

  const { report, sessions, recordedDays, spanByDate } =
    summarizeMonth((res.results ?? []).filter((row) => sessionInScope(row.start_utc, scope)), period, timezone, now, policy);
  if (scope.kind === "team") {
    const joined = localYMD(new Date(scope.since), timezone);
    const date = `${joined.y}-${String(joined.m).padStart(2, "0")}-${String(joined.d).padStart(2, "0")}`;
    report.days = report.days.filter((day) => day.date >= date);
  }
  // Daily activity aggregates cannot separate personal and team work on the join day.
  const projects = includeProjects && scope.kind === "personal" ? await projectTotalsForPeriod(env, userId, period) : [];
  return { report, sessions, recordedDays, projects, csv: renderCsv(report.days, spanByDate, projects, policy) };
}

function renderCsv(
  calendarDays: DayHours[],
  spanByDate: Map<string, DaySpan>,
  projects: Timesheet["projects"],
  policy: TimePolicy,
): string {
  if (spanByDate.size === 0) return "";

  const breakdown = policy.paidLunchMinutes > 0 || policy.overtime.mode !== "disabled";
  const lines = ["Date,Clock In,Clock Out,Breaks,Hours Worked" + (breakdown ? ",Paid Lunch,Regular Hours,Overtime" : "")];
  let totalMinutes = 0;
  let totalLunch = 0;
  let totalOvertime = 0;
  for (const day of calendarDays) {
    const span = spanByDate.get(day.date);
    if (span) {
      lines.push(
        `${csvField(day.label)},${formatHM(span.in, span.inTimezone)},${formatHM(span.out, span.outTimezone)},${csvField(span.breaks.join("; "))},${formatHours(span.minutes)}` +
          (breakdown ? `,${formatHours(day.paidLunchMinutes ?? 0)},${formatHours(day.minutes - (day.overtimeMinutes ?? 0))},${formatHours(day.overtimeMinutes ?? 0)}` : ""),
      );
      totalMinutes += span.minutes;
      totalLunch += day.paidLunchMinutes ?? 0;
      totalOvertime += day.overtimeMinutes ?? 0;
    } else if (isWorkDay(day.date)) {
      lines.push(`${csvField(day.label)},Vacation,,,` + (breakdown ? ",,," : ""));
    }
  }

  lines.push(breakdown ? ",,,,,,," : ",,,,");
  lines.push(`,,,Total,${formatHours(totalMinutes)}` + (breakdown ? `,${formatHours(totalLunch)},${formatHours(totalMinutes - totalOvertime)},${formatHours(totalOvertime)}` : ""));

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
