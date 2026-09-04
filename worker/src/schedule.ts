import { localYMD, previousMonthPeriod, wallToUtc } from "./time.js";

/** Defaults preserve the original once-daily 06:00 UTC report trigger. */
export const DEFAULT_SEND_TIME = "06:00";
export const DEFAULT_SEND_TIMEZONE = "UTC";
export const SEND_DAY_LAST = 99;

export interface SendSchedule {
  /** 0 disables automatic delivery; 99 means the last day of the month. */
  day: number;
  /** 24-hour wall-clock time in HH:MM form. */
  time: string;
  /** IANA timezone name (UTC is also accepted). */
  timezone: string;
}

export function isValidSendDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 || value === SEND_DAY_LAST || (value >= 1 && value <= 28))
  );
}

export function isValidSendTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for the one cron minute represented by `now` in the schedule timezone.
 * Converting the configured wall time to UTC gives DST gaps/repeats one stable
 * instant: a skipped spring time rolls forward, and a repeated fall time occurs once.
 */
export function isScheduleDue(schedule: SendSchedule, now: Date): boolean {
  if (schedule.day === 0) return false;
  const { y, m, d } = localYMD(now, schedule.timezone);
  const target =
    schedule.day === SEND_DAY_LAST
      ? new Date(Date.UTC(y, m, 0)).getUTCDate()
      : schedule.day;
  if (d !== target) return false;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const due = wallToUtc(y, m, d, hour, minute, 0, schedule.timezone);
  return Math.floor(due.getTime() / 60_000) === Math.floor(now.getTime() / 60_000);
}

/** The report remains for the prior local calendar month, matching existing behavior. */
export function periodForSchedule(schedule: SendSchedule, now: Date): string {
  return previousMonthPeriod(now, schedule.timezone);
}
