import { isValidTimeZone } from "./schedule.js";
import type { Env, SessionIn } from "./types";

/** Max sessions accepted in a single POST /sessions (DoS / cost guard). */
export const MAX_SESSIONS_PER_REQUEST = 500;
/** Reject sessions that claim to start more than this far in the future. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
/** Reject sessions older than this (bad client clocks / junk). */
const MAX_AGE_MS = 3 * 365 * 24 * 60 * 60 * 1000;

const KNOWN_REASONS = new Set([
  "start",
  "resume",
  "unlock",
  "active",
  "call",
  "manual",
  "idle",
  "lock",
  "suspend",
  "shutdown",
  "quit",
  "crash",
  "app",
]);

/** Keep report reasons short and token-like (mirrors security.sanitizeSessionReason). */
function sanitizeSessionReason(raw: unknown): string | null {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().slice(0, 32);
  if (!s) return null;
  if (KNOWN_REASONS.has(s)) return s;
  if (/^[a-z][a-z0-9_]{0,31}$/.test(s)) return s;
  return null;
}

/**
 * POST /sessions — validate and upsert synced sessions (idempotent by id).
 * `userId` is the account resolved from the Bearer token; sessions are attributed
 * to it (null only for the legacy global-token path).
 *
 * Ownership: an existing row is only updated when `user_id` is null (legacy) or
 * already equals the caller — never reassigned across accounts.
 *
 * Returns `accepted` ids so the desktop client only marks those as synced.
 */
export async function handleIngest(
  req: Request,
  env: Env,
  userId: string | null,
  tokenHash: string | null = null,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const raw = typeof body === "object" && body !== null && "sessions" in body ? body.sessions : undefined;
  if (!Array.isArray(raw)) {
    return json({ error: "sessions array required" }, 400);
  }
  if (raw.length > MAX_SESSIONS_PER_REQUEST) {
    return json(
      { error: `too many sessions (max ${MAX_SESSIONS_PER_REQUEST})` },
      413,
    );
  }

  const valid = raw.filter(isValid);
  if (valid.length === 0) {
    // Do not return a soft 200 that would let the client mark junk as synced.
    return json({ error: "no valid sessions", accepted: [], upserted: 0 }, 400);
  }

  // SQL guards apply at write time, including when another isolate wins a race.
  const statements = valid.map((s) => env.DB.prepare(
    `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, timezone, user_id)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM session_deletions WHERE id = ?)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM api_token WHERE userId = ? AND token_hash = ?))
     ON CONFLICT(id) DO UPDATE SET
       start_utc = excluded.start_utc,
       end_utc = excluded.end_utc,
       start_reason = excluded.start_reason,
       end_reason = excluded.end_reason,
       timezone = COALESCE(excluded.timezone, sessions.timezone),
       user_id = COALESCE(sessions.user_id, excluded.user_id)
     WHERE sessions.user_id IS NULL OR sessions.user_id = excluded.user_id
     RETURNING id`,
  ).bind(
    s.id, new Date(s.start_utc).toISOString(), new Date(s.end_utc).toISOString(),
    sanitizeSessionReason(s.start_reason), sanitizeSessionReason(s.end_reason),
    isValidTimeZone(s.timezone) ? s.timezone : null, userId, s.id, tokenHash, userId, tokenHash,
  ));
  const writeCount = statements.length;
  for (let i = 0; i < valid.length; i += 80) {
    const ids = valid.slice(i, i + 80).map((s) => s.id);
    statements.push(env.DB.prepare(
      `SELECT id FROM session_deletions WHERE user_id IS ? AND id IN (${ids.map(() => "?").join(",")})`,
    ).bind(userId, ...ids));
  }
  // Both the writes and tombstone acknowledgements run in one transaction.
  const results = await env.DB.batch<{ id: string }>(statements);
  const accepted = [...new Set(results.flatMap((r) => r.results.map((row) => row.id)))];
  const upserted = results.slice(0, writeCount).reduce((sum, r) => sum + r.results.length, 0);
  return json(accepted.length
    ? { ok: true, upserted, accepted }
    : { error: "no sessions accepted", accepted: [], upserted: 0 }, accepted.length ? 200 : 409);
}

/** Tombstone and delete atomically so an in-flight sync cannot resurrect a row. */
export async function deleteSession(env: Env, userId: string, id: string): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO session_deletions (id, user_id, deleted_at)
       SELECT id, user_id, ? FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL`,
    ).bind(new Date().toISOString(), id, userId),
    env.DB.prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL`).bind(id, userId),
  ]);
  return results[1].meta.changes > 0;
}

const MAX_REASON_LEN = 64;
const MAX_ID_LEN = 128;
/** Reject absurd multi-year spans (likely bad client data). */
const MAX_DURATION_MS = 1000 * 60 * 60 * 24 * 40; // 40 days
/** Desktop uses UUID v4; accept UUID-ish ids (with optional common prefixes). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Validate the written calendar date before applying its RFC3339 offset.
 * Date.parse alone normalizes impossible dates such as February 30. */
function rfc3339Milliseconds(raw: string): number | null {
  if (raw.length > 128) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] ||
      hour > 23 || minute > 59 || second > 59 ||
      Number(match[9] ?? 0) > 23 || Number(match[10] ?? 0) > 59) return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isValid(s: unknown): s is SessionIn {
  if (typeof s !== "object" || s === null) return false;
  const o = s;
  if (
    !("id" in o) || !("start_utc" in o) || !("end_utc" in o) ||
    typeof o.id !== "string" ||
    typeof o.start_utc !== "string" ||
    typeof o.end_utc !== "string"
  ) {
    return false;
  }
  if (o.id.length === 0 || o.id.length > MAX_ID_LEN || !ID_RE.test(o.id)) return false;
  const start = rfc3339Milliseconds(o.start_utc);
  const end = rfc3339Milliseconds(o.end_utc);
  if (start === null || end === null || end <= start) return false;
  if (end - start > MAX_DURATION_MS) return false;
  const now = Date.now();
  if (end > now + MAX_FUTURE_MS) return false;
  if (end < now - MAX_AGE_MS) return false;
  if (
    "start_reason" in o && o.start_reason != null &&
    (typeof o.start_reason !== "string" || o.start_reason.length > MAX_REASON_LEN)
  ) {
    return false;
  }
  if (
    "end_reason" in o && o.end_reason != null &&
    (typeof o.end_reason !== "string" || o.end_reason.length > MAX_REASON_LEN)
  ) {
    return false;
  }
  if ("timezone" in o && o.timezone != null && typeof o.timezone !== "string") return false;
  return true;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
