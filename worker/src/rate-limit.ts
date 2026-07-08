// Rate limiting: in-memory (per isolate, unit tests / soft prefilter) plus
// D1-backed durable counters that hold across Cloudflare isolates.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Prune occasionally so long-lived isolates don't grow unbounded. */
function prune(now: number): void {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * In-memory fixed window. Not global across isolates — use
 * `rateLimitAllowDurable` for production abuse paths.
 */
export function rateLimitAllow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}

/**
 * D1-backed fixed window shared across isolates. Fail-closed on DB errors
 * (prefer blocking abuse over unlimited traffic).
 */
export async function rateLimitAllowDurable(
  db: D1Database,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const resetAt = now + windowMs;
  try {
    await db
      .prepare(
        `INSERT INTO rate_limit (key, count, reset_at) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limit.reset_at <= ?3 THEN 1 ELSE rate_limit.count + 1 END,
           reset_at = CASE WHEN rate_limit.reset_at <= ?3 THEN ?2 ELSE rate_limit.reset_at END`,
      )
      .bind(key, resetAt, now)
      .run();
    const row = await db
      .prepare(`SELECT count FROM rate_limit WHERE key = ?`)
      .bind(key)
      .first<{ count: number }>();
    return (row?.count ?? 1) <= max;
  } catch (e) {
    console.error("rateLimitAllowDurable error:", String((e as Error)?.message ?? e));
    return false;
  }
}

/** Client IP from CF / standard proxy headers, else "unknown". */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
