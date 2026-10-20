import type { RecordedDay } from "./report";

/**
 * Break comparisons normalized by recorded days. A recorded day has at least one
 * session; days without sessions are excluded, and recorded days without breaks
 * count as zero so a person with few gaps is not hidden by a short month.
 */
export interface BreakStats {
  workedMinutes: number;
  breakMinutes: number;
  breakCount: number;
  recordedDays: number;
  /** Break minutes per recorded day; 0 when there are no recorded days. */
  avgBreakMinutes: number;
  /** Breaks per recorded day; 0 when there are no recorded days. */
  breaksPerDay: number;
}

export interface TeamBreakStats {
  /** Totals across every recorded member-day. */
  team: BreakStats;
  /** Median of each member's own daily rate. Members without recorded days are left out. */
  median: { avgBreakMinutes: number | null; breaksPerDay: number | null; members: number };
}

function rates(worked: number, minutes: number, count: number, days: number): BreakStats {
  return {
    workedMinutes: worked,
    breakMinutes: minutes,
    breakCount: count,
    recordedDays: days,
    avgBreakMinutes: days > 0 ? minutes / days : 0,
    breaksPerDay: days > 0 ? count / days : 0,
  };
}

export function breakStats(days: readonly Pick<RecordedDay, "minutes" | "breakMinutes" | "breaks">[]): BreakStats {
  let worked = 0, minutes = 0, count = 0;
  for (const day of days) {
    worked += day.minutes;
    minutes += day.breakMinutes;
    count += day.breaks.length;
  }
  return rates(worked, minutes, count, days.length);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function teamBreakStats(members: readonly BreakStats[]): TeamBreakStats {
  let worked = 0, minutes = 0, count = 0, days = 0;
  for (const member of members) {
    worked += member.workedMinutes;
    minutes += member.breakMinutes;
    count += member.breakCount;
    days += member.recordedDays;
  }
  const recorded = members.filter((member) => member.recordedDays > 0);
  return {
    team: rates(worked, minutes, count, days),
    median: {
      avgBreakMinutes: median(recorded.map((member) => member.avgBreakMinutes)),
      breaksPerDay: median(recorded.map((member) => member.breaksPerDay)),
      members: recorded.length,
    },
  };
}
