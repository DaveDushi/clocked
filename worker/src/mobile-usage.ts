import { userHasProductAccess } from "./access.js";
import { clientIp, rateLimitAllowDurable } from "./rate-limit.js";
import { isValidTimeZone } from "./schedule.js";
import { isValidCalendarDate } from "./security.js";
import { hashToken, userIdForToken } from "./tokens.js";
import { localYMD, wallToUtc } from "./time.js";
import type { Env } from "./types";

export const MAX_MOBILE_SNAPSHOTS = 500;
const MAX_BODY_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SELECTION_ID = /^(?:[a-f0-9]{32,128}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:-z[a-f0-9]{8})?$/i;
const SNAPSHOT_FIELDS = new Set(["id", "device_id", "platform", "day", "timezone", "selection_id", "duration_seconds"]);

interface Snapshot {
  id: string;
  device_id: string;
  platform: "ios";
  day: string;
  timezone: string;
  selection_id: string;
  duration_seconds: number;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  if (Object.keys(value).some((key) => !SNAPSHOT_FIELDS.has(key))) return false;
  if (!("id" in value) || typeof value.id !== "string" || !ID.test(value.id) ||
      !("device_id" in value) || typeof value.device_id !== "string" || !ID.test(value.device_id) ||
      !("selection_id" in value) || typeof value.selection_id !== "string" || value.selection_id.length > 128 || !SELECTION_ID.test(value.selection_id) ||
      !("platform" in value) || value.platform !== "ios" ||
      !("day" in value) || typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      !("timezone" in value) || !isValidTimeZone(value.timezone) || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value.timezone) ||
      !("duration_seconds" in value) || typeof value.duration_seconds !== "number" ||
      !Number.isSafeInteger(value.duration_seconds) || value.duration_seconds < 0) return false;
  const [y, m, d] = value.day.split("-").map(Number);
  if (!isValidCalendarDate(y, m, d)) return false;
  const start = wallToUtc(y, m, d, 0, 0, 0, value.timezone);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, value.timezone);
  const daySeconds = (end.getTime() - start.getTime()) / 1000;
  if (value.duration_seconds > Math.min(90000, daySeconds)) return false;
  const today = localYMD(new Date(), value.timezone);
  const todayDay = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
  return value.day <= todayDay && start.getTime() >= Date.now() - 3 * 366 * 86400_000;
}

/** Same account-token, product-access and durable rate guards as /sessions. */
export async function handleMobileUsage(req: Request, env: Env): Promise<Response> {
  if (!(await rateLimitAllowDurable(env.DB, `mobile-usage:${clientIp(req)}`, 60, 60_000))) {
    return json({ error: "too many requests" }, 429);
  }
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+clk_/i.test(authorization)) return json({ error: "unauthorized" }, 401);
  const userId = await userIdForToken(env, authorization.replace(/^Bearer\s+/i, ""));
  if (!userId) return json({ error: "unauthorized" }, 401);
  if (!(await userHasProductAccess(env, userId))) return json({ error: "subscription required" }, 402);
  if (!(await rateLimitAllowDurable(env.DB, `mobile-usage:user:${userId}`, 120, 60_000))) {
    return json({ error: "too many requests" }, 429);
  }
  return ingestMobileUsage(req, env, userId, await hashToken(authorization.replace(/^Bearer\s+/i, "")));
}

/** IDs are acknowledgement labels; the account/device/day/selection tuple is identity. */
export async function ingestMobileUsage(req: Request, env: Env, userId: string, tokenHash: string | null = null): Promise<Response> {
  const reader = req.body?.getReader();
  if (!reader) return json({ error: "snapshots array required" }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: "body too large" }, 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (typeof body !== "object" || body === null || !("snapshots" in body) || !Array.isArray(body.snapshots)) {
    return json({ error: "snapshots array required" }, 400);
  }
  if (Object.keys(body).some((key) => key !== "snapshots")) return json({ error: "unexpected fields" }, 400);
  if (body.snapshots.length > MAX_MOBILE_SNAPSHOTS) return json({ error: "too many snapshots (max 500)" }, 413);
  if (body.snapshots.length === 0) return json({ accepted: [] });
  const valid = body.snapshots.filter(isSnapshot);
  if (valid.length === 0) return json({ error: "no valid snapshots", accepted: [] }, 400);
  const now = new Date().toISOString();
  const results = await env.DB.batch(valid.map((s) => env.DB.prepare(
    `INSERT INTO mobile_usage (user_id, device_id, day, selection_id, platform, timezone, duration_seconds, updated_at)
     SELECT ?, ?, ?, ?, 'ios', ?, ?, ?
     WHERE (? IS NULL OR EXISTS (SELECT 1 FROM api_token WHERE userId = ? AND token_hash = ?))
     ON CONFLICT(user_id, device_id, day, selection_id) DO UPDATE SET
       duration_seconds = MAX(mobile_usage.duration_seconds, excluded.duration_seconds),
       updated_at = CASE WHEN excluded.duration_seconds > mobile_usage.duration_seconds
                         THEN excluded.updated_at ELSE mobile_usage.updated_at END
     WHERE mobile_usage.timezone = excluded.timezone
     RETURNING day`,
  ).bind(userId, s.device_id, s.day, s.selection_id, s.timezone, s.duration_seconds, now, tokenHash, userId, tokenHash)));
  const accepted = valid.filter((_, i) => results[i].results.length > 0).map((s) => s.id);
  return json({ accepted: [...new Set(accepted)] }, accepted.length ? 200 : 409);
}

export async function mobileUsageForPeriod(env: Env, userId: string, period: string) {
  const res = await env.DB.prepare(
    `SELECT day, device_id, MAX(duration_seconds) AS duration_seconds
       FROM mobile_usage WHERE user_id = ? AND day >= ? AND day < ?
      GROUP BY day, device_id ORDER BY day, device_id`,
  ).bind(userId, `${period}-01`, `${period}-32`).all<{ day: string; device_id: string; duration_seconds: number }>();
  const days = new Map<string, number>();
  const deviceTotals = new Map<string, number>();
  for (const row of res.results) {
    days.set(row.day, Math.max(days.get(row.day) ?? 0, row.duration_seconds));
    deviceTotals.set(row.device_id, (deviceTotals.get(row.device_id) ?? 0) + row.duration_seconds);
  }
  return {
    period,
    // A summary of one device's month, never a sum across devices or selections.
    largestDeviceSeconds: Math.max(0, ...deviceTotals.values()),
    deviceTotals: [...deviceTotals].map(([deviceId, durationSeconds]) => ({ deviceId, durationSeconds })),
    days: [...days].map(([day, durationSeconds]) => ({ day, durationSeconds })),
    devices: res.results.map((row) => ({ day: row.day, deviceId: row.device_id, durationSeconds: row.duration_seconds })),
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
