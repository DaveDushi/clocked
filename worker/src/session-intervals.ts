export interface TimeInterval {
  start: number;
  end: number;
}

/**
 * Return the union of a set of half-open time intervals. Inputs may be
 * unordered; invalid/empty intervals are ignored. Adjacent intervals are
 * joined because there is no untracked time between them.
 */
export function mergeTimeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = intervals
    .filter(
      (x) =>
        Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start,
    )
    .map((x) => ({ start: x.start, end: x.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TimeInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push(interval);
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

/** Rounded minutes covered by at least one interval. */
export function unionMinutes(intervals: readonly TimeInterval[]): number {
  const milliseconds = mergeTimeIntervals(intervals).reduce(
    (sum, x) => sum + (x.end - x.start),
    0,
  );
  return Math.round(milliseconds / 60_000);
}
