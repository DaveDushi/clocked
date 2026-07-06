export interface CalendarDayHours {
  date: string;
  label: string;
  minutes: number;
}

export interface CalendarDaysResult {
  days: CalendarDayHours[];
  activeDays: number;
}

export interface CalendarToday {
  y: number;
  m: number;
  d: number;
}

/**
 * Expand sparse worked-day totals into calendar rows for the dashboard.
 *
 * Past months show every day in the month. The current month shows day 1
 * through today, so the UI can scroll to "today + the previous week". Future
 * months remain empty.
 */
export function expandCalendarDays(
  days: CalendarDayHours[],
  period: string,
  today: Date | CalendarToday = new Date(),
): CalendarDaysResult {
  const [year, month] = period.split("-").map(Number);
  const t =
    today instanceof Date
      ? { y: today.getUTCFullYear(), m: today.getUTCMonth() + 1, d: today.getUTCDate() }
      : today;
  const currentPeriod = `${t.y}-${String(t.m).padStart(2, "0")}`;

  let lastDay = 0;
  if (period < currentPeriod) lastDay = daysInMonth(year, month);
  else if (period === currentPeriod) lastDay = t.d;

  const byDate = new Map(days.map((day) => [day.date, day]));
  const expanded: CalendarDayHours[] = [];
  for (let day = 1; day <= lastDay; day++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    expanded.push(byDate.get(date) ?? { date, label: formatUtcDateLabel(year, month, day), minutes: 0 });
  }

  return { days: expanded, activeDays: days.length };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatUtcDateLabel(year: number, month: number, day: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
