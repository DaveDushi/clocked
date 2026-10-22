//! Timezone helpers built only on `Intl` (no external date library).
//! All conversions use the report timezone (IANA name in REPORT_TZ).

/** Offset (local - UTC) in ms for the given instant in `tz`. */
export function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in `tz` to the corresponding UTC instant. */
export function wallToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

export function localYMD(date: Date, tz: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}

export function isFirstOfMonth(date: Date, tz: string): boolean {
  return localYMD(date, tz).d === 1;
}

/** "YYYY-MM" of the calendar month before `date`'s local month. */
export function previousMonthPeriod(date: Date, tz: string): string {
  const { y, m } = localYMD(date, tz);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/** UTC bounds `[start, end)` for the local calendar month `period` ("YYYY-MM"). */
export function monthBoundsUtc(period: string, tz: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  const start = wallToUtc(y, m, 1, 0, 0, 0, tz);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = wallToUtc(ny, nm, 1, 0, 0, 0, tz);
  return { start, end };
}

/** The next local midnight (as a UTC instant) strictly after `date`. */
export function nextLocalMidnightUtc(date: Date, tz: string): Date {
  const { y, m, d } = localYMD(date, tz);
  const guess = Date.UTC(y, m - 1, d + 1, 0, 0, 0); // Date.UTC rolls over month/year
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

const labelFmt = (tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const timeFmt = (tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });

/** e.g. "Monday, June 29, 2026" */
export function formatDateLabel(date: Date, tz: string): string {
  return labelFmt(tz).format(date);
}

/** e.g. "10:00" (24-hour) */
export function formatHM(date: Date, tz: string): string {
  return timeFmt(tz).format(date);
}

export type ReportPeriod = {
  kind: "month" | "week";
  start: string;
  end: string;
};

/** Interpret a validated YYYY-MM month or YYYY-MM-DD seven-day start once.
 * Calendar dates use an exclusive end, independently of the report timezone. */
export function parseReportPeriod(period: string): ReportPeriod {
  const [y, m, d] = period.split("-").map(Number);
  const kind = d === undefined ? "month" : "week";
  const start = new Date(Date.UTC(y, m - 1, d ?? 1));
  const end = kind === "month" ? new Date(Date.UTC(y, m, 1)) : new Date(Date.UTC(y, m - 1, d + 7));
  return { kind, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function reportDateBounds(period: string): { start: string; end: string } {
  const { start, end } = parseReportPeriod(period);
  return { start, end };
}

export function reportPeriodTitle(period: string): string {
  const { kind, start, end } = parseReportPeriod(period);
  if (kind === "week") {
    const last = new Date(Date.parse(end + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    return `${start} to ${last}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(start + "T00:00:00Z"));
}

export function reportBoundsUtc(period: string, timezone: string): { start: Date; end: Date } {
  const dates = reportDateBounds(period);
  const convert = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return wallToUtc(y, m, d, 0, 0, 0, timezone);
  };
  return { start: convert(dates.start), end: convert(dates.end) };
}
