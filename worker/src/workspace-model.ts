// Pure helpers for the signed-in workspace. Serialized into the dashboard like
// createTimesheetView, so the factory must keep every dependency inside it and
// use object methods (bundler name helpers would otherwise leak in).
export function createWorkspaceModel() {
  const CAUSES: Record<string, string> = {
    idle: "Idle timeout",
    lock: "Screen locked",
    suspend: "Computer asleep",
    shutdown: "Computer shut down",
    quit: "App closed",
    crash: "App stopped unexpectedly",
    manual: "Manual clock-out",
    entry: "End of entered time",
  };
  const REASONS: Record<string, string> = {
    start: "app start", resume: "wake", unlock: "unlock", active: "activity",
    call: "call", manual: "manual", idle: "idle", lock: "lock",
    suspend: "sleep", shutdown: "shutdown", quit: "quit", crash: "crash", app: "app",
  };
  const WORK_SHADES = ["#f5dfbd", "#dfb77c", "#bc8849", "#955d2b", "#663b1c"];
  const WORK_LEVELS = ["Under 2 hours", "2 to under 4 hours", "4 to under 6 hours", "6 to under 8 hours", "8 hours or more"];

  const model = {
    WORK_SHADES,
    WORK_LEVELS,

    pad(n: number): string { return String(n).padStart(2, "0"); },

    /** 450 -> "7h 30m". */
    duration(minutes: number): string {
      const total = Math.max(0, Math.round(minutes || 0));
      return Math.floor(total / 60) + "h " + model.pad(total % 60) + "m";
    },

    /** Under an hour as minutes only: 45 -> "45m". */
    shortDuration(minutes: number): string {
      const total = Math.max(0, Math.round(minutes || 0));
      return total < 60 ? total + "m" : model.duration(total);
    },

    rate(value: number): string { return (Math.round((value || 0) * 10) / 10).toFixed(1); },

    period(y: number, m: number): string { return y + "-" + model.pad(m); },

    shiftPeriod(period: string, delta: number): string {
      const [y, m] = period.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1 + delta, 1));
      return model.period(date.getUTCFullYear(), date.getUTCMonth() + 1);
    },

    /** The default reporting month: the last one that has fully ended. */
    lastCompleteMonth(today: { y: number; m: number }): string {
      return model.shiftPeriod(model.period(today.y, today.m), -1);
    },

    monthLabel(period: string): string {
      const [y, m] = period.split("-").map(Number);
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })
        .format(new Date(Date.UTC(y, m - 1, 1)));
    },

    /** Current month first (in progress), then `count - 1` earlier months. */
    monthOptions(today: { y: number; m: number }, count: number, selected: string) {
      const current = model.period(today.y, today.m);
      const options = [];
      for (let i = 0; i < count; i++) {
        const value = model.shiftPeriod(current, -i);
        options.push({ value, label: model.monthLabel(value) + (i === 0 ? " · in progress" : ""), current: i === 0 });
      }
      if (selected && selected < current && !options.some((o) => o.value === selected)) {
        options.push({ value: selected, label: model.monthLabel(selected), current: false });
      }
      return options;
    },

    dayLabel(date: string, long = false): string {
      const [y, m, d] = date.split("-").map(Number);
      return new Intl.DateTimeFormat("en-US", long
        ? { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }
        : { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
        .format(new Date(Date.UTC(y, m - 1, d)));
    },

    daysInMonth(period: string): number {
      const [y, m] = period.split("-").map(Number);
      return new Date(Date.UTC(y, m, 0)).getUTCDate();
    },

    /** Dates shown for a month: all of a past month, or day 1 through `today` for the current one. */
    visibleDates(period: string, today: string): string[] {
      const last = today.slice(0, 7) === period ? Number(today.slice(8, 10))
        : period < today.slice(0, 7) ? model.daysInMonth(period) : 0;
      const dates = [];
      for (let d = 1; d <= last; d++) dates.push(period + "-" + model.pad(d));
      return dates;
    },

    causeLabel(cause: string): string { return CAUSES[cause] || "Reason not recorded"; },

    reasonLabel(reason: string | null): string {
      const key = String(reason || "").toLowerCase();
      return REASONS[key] || key || "not recorded";
    },

    minutesOf(clock: string): number {
      const [h, m] = clock.split(":").map(Number);
      return h * 60 + m;
    },

    /**
     * The sessions and breaks of one recorded day in time order. Sessions keep
     * their own times (overlaps included); breaks come from the server's merged
     * day so overlapping devices never invent a gap.
     */
    dayEntries(
      sessions: { id: string; date: string; startMin: number; endMin: number; startMs: number; endMs: number }[],
      day: { date: string; breaks: { start: string; end: string; minutes: number; cause: string }[] } | null,
    ) {
      const own = sessions.filter((s) => s.date === (day ? day.date : ""))
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      const entries: { kind: "session" | "break"; at: number; session?: typeof own[number]; overlaps?: boolean; gap?: { start: string; end: string; minutes: number; cause: string } }[] = own.map((session) => ({
        kind: "session" as const,
        at: session.startMin,
        session,
        overlaps: own.some((other) => other !== session && other.startMs < session.endMs && session.startMs < other.endMs),
      }));
      for (const gap of day ? day.breaks : []) entries.push({ kind: "break", at: model.minutesOf(gap.start), gap });
      return entries.sort((a, b) => a.at - b.at || (a.kind === "break" ? 1 : 0) - (b.kind === "break" ? 1 : 0));
    },

    /** Worked-time shade: 0 = lightest (under 2h) to 4 = darkest (8h or more). */
    workedLevel(minutes: number): number {
      return minutes < 120 ? 0 : minutes < 240 ? 1 : minutes < 360 ? 2 : minutes < 480 ? 3 : 4;
    },

    /** Break-grid opacity: recorded zero-break days stay faint, 120 minutes or more is strongest. */
    breakStrength(minutes: number): number {
      return minutes <= 0 ? 0.05 : Math.min(0.22 + (minutes / 120) * 0.68, 0.9);
    },

    /** Monday-first month grid: week columns, weekday rows. */
    calendar(period: string) {
      const [y, m] = period.split("-").map(Number);
      const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
      const last = model.daysInMonth(period);
      return { offset, last, weeks: Math.ceil((offset + last) / 7) };
    },

    sortMembers<T extends { name: string; stats: { recordedDays: number; avgBreakMinutes: number; breaksPerDay: number } }>(members: T[], sort: string): T[] {
      return [...members].sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        // People without recorded days have no rate to compare; keep them last.
        if (!a.stats.recordedDays || !b.stats.recordedDays) return (b.stats.recordedDays ? 1 : 0) - (a.stats.recordedDays ? 1 : 0) || a.name.localeCompare(b.name);
        const key = sort === "breaks" ? "breaksPerDay" : "avgBreakMinutes";
        return b.stats[key] - a.stats[key] || a.name.localeCompare(b.name);
      });
    },

    median(values: number[]): number | null {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },

    /** Facts shown next to a member before sending. Only recorded data, never a judgment. */
    sendFacts(member: { stats: { recordedDays: number }; enteredSessions: number }, referenceDays: number | null): string[] {
      const facts = [];
      if (member.enteredSessions > 0) {
        facts.push(member.enteredSessions + " session" + (member.enteredSessions === 1 ? "" : "s") + " entered or edited in the dashboard");
      }
      if (referenceDays != null && member.stats.recordedDays < referenceDays) {
        facts.push(member.stats.recordedDays + " recorded day" + (member.stats.recordedDays === 1 ? "" : "s") + " · team median " + referenceDays);
      }
      return facts;
    },

    /** Local date and time of an instant in `timezone`, for edit forms. */
    zonedParts(iso: string, timezone: string): { date: string; time: string } {
      const parts: Record<string, string> = {};
      for (const part of new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(new Date(iso))) parts[part.type] = part.value;
      return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute };
    },

    /** Whether `next` is the calendar day after `date` ("YYYY-MM-DD"). */
    isNextDay(date: string, next: string): boolean {
      const [y, m, d] = date.split("-").map(Number);
      const following = new Date(Date.UTC(y, m - 1, d + 1));
      return next === following.getUTCFullYear() + "-" + model.pad(following.getUTCMonth() + 1) + "-" + model.pad(following.getUTCDate());
    },

    initials(name: string): string {
      const words = String(name || "").replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
      return ((words[0] || "?")[0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
    },
  };
  return model;
}
