import { sessionInScope, type SessionScope } from "./team-scope.js";
import { buildTimesheet, timezoneForLocalDate, validTimezoneOr } from "./report.js";
import { isValidCalendarDate, parsePeriodParam } from "./security.js";
import { previousMonthPeriod, wallToUtc } from "./time.js";
import type { Env } from "./types";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function json(obj: unknown, status = 200): Response {
  return Response.json(obj, { status });
}

interface Entry {
  date: string;
  start: string;
  end: string;
  overnight: boolean;
}

function parseEntry(body: Record<string, unknown>): Entry | null {
  const date = typeof body.date === "string" ? body.date : "";
  const start = typeof body.start === "string" ? body.start : "";
  const end = typeof body.end === "string" ? body.end : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    return null;
  }
  const [y, m, d] = date.split("-").map(Number);
  const [sh, smi] = start.split(":").map(Number);
  const [eh, emi] = end.split(":").map(Number);
  if (!isValidCalendarDate(y, m, d) || sh > 23 || eh > 23 || smi > 59 || emi > 59) return null;
  return { date, start, end, overnight: body.overnight === true };
}

/** Wall-clock entry in `timezone` to UTC bounds. Overnight entries end on the next local day. */
function entryBounds(entry: Entry, timezone: string): { start: Date; end: Date } | string {
  const [y, m, d] = entry.date.split("-").map(Number);
  const [sh, smi] = entry.start.split(":").map(Number);
  const [eh, emi] = entry.end.split(":").map(Number);
  if (!entry.overnight && eh * 60 + emi <= sh * 60 + smi) return "clock-out must be after clock-in";
  const start = wallToUtc(y, m, d, sh, smi, 0, timezone);
  const endDay = new Date(Date.UTC(y, m - 1, d + (entry.overnight ? 1 : 0)));
  const end = wallToUtc(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), eh, emi, 0, timezone);
  if (!(end.getTime() > start.getTime())) return "clock-out must be after clock-in";
  if (end.getTime() - start.getTime() > DAY_MS) return "session too long";
  return { start, end };
}

/**
 * List, add, edit, or remove one account's sessions. Callers authorize `actorId`
 * to change `userId`'s timesheet.
 *
 * DELETE removes any closed session the account owns and tombstones its id so a
 * desktop re-sync cannot bring it back. PATCH applies the same rule to the edited
 * session and stores the new times as a dashboard entry that records who made it
 * and which session it replaced. Recorded sessions are never rewritten in place,
 * because the desktop would overwrite them on its next upload.
 */
export async function handleManualSession(
  req: Request,
  url: URL,
  env: Env,
  userId: string,
  actorId: string,
  timezone: string,
  scope: SessionScope,
): Promise<Response> {
  if (req.method === "GET") {
    const raw = url.searchParams.get("period");
    const period = raw ? parsePeriodParam(raw) : previousMonthPeriod(new Date(), timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const { sessions: entries } = await buildTimesheet({
      env, period, userId, timezone, includeProjects: false, scope,
    });
    return json({ entries });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (req.method === "DELETE") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!SESSION_ID.test(id)) return json({ error: "id required" }, 400);
    const original = await env.DB.prepare("SELECT start_utc FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL")
      .bind(id, userId).first<{ start_utc: string }>();
    if (!original || !sessionInScope(original.start_utc, scope)) return json({ error: "not found" }, 404);
    // Any owned closed session — managers use this to drop bad desktop clockings.
    const res = await env.DB.prepare(
      `DELETE FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL`,
    )
      .bind(id, userId)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    // Tombstone so a later desktop re-sync of the same id cannot resurrect it.
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO session_deletions (id, user_id, deleted_at) VALUES (?, ?, ?)`,
      )
        .bind(id, userId, new Date().toISOString())
        .run();
    } catch {
      /* table may not exist until migration applied — delete still succeeded */
    }
    return json({ ok: true });
  }

  if (req.method === "POST") {
    const entry = parseEntry(body);
    if (!entry) return json({ error: "invalid date or time" }, 400);
    const dayTimezone = await timezoneForLocalDate(env, userId, entry.date, timezone);
    const bounds = entryBounds(entry, dayTimezone);
    if (typeof bounds === "string") return json({ error: bounds }, 400);
    if (!sessionInScope(bounds.start.toISOString(), scope)) return json({ error: "session predates team membership" }, 403);
    await env.DB.prepare(
      `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, timezone, user_id, edited_by)
       VALUES (?, ?, ?, 'manual', 'manual', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), bounds.start.toISOString(), bounds.end.toISOString(), dayTimezone, userId, actorId)
      .run();
    return json({ ok: true });
  }

  if (req.method === "PATCH") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!SESSION_ID.test(id)) return json({ error: "id required" }, 400);
    const entry = parseEntry(body);
    if (!entry) return json({ error: "invalid date or time" }, 400);
    const original = await env.DB.prepare(
      `SELECT id, timezone, replaces_id, start_utc FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL`,
    )
      .bind(id, userId)
      .first<{ id: string; timezone: string | null; replaces_id: string | null; start_utc: string }>();
    if (!original || !sessionInScope(original.start_utc, scope)) return json({ error: "not found" }, 404);
    // Keep the timezone the session is shown in, so the edited times mean what the form showed.
    const sessionTimezone = validTimezoneOr(original.timezone, timezone);
    const bounds = entryBounds(entry, sessionTimezone);
    if (typeof bounds === "string") return json({ error: bounds }, 400);
    if (!sessionInScope(bounds.start.toISOString(), scope)) return json({ error: "session predates team membership" }, 403);
    const replacement = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`).bind(id, userId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO session_deletions (id, user_id, deleted_at) VALUES (?, ?, ?)`,
      ).bind(id, userId, new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, timezone, user_id, edited_by, replaces_id)
         VALUES (?, ?, ?, 'manual', 'manual', ?, ?, ?, ?)`,
      ).bind(
        replacement, bounds.start.toISOString(), bounds.end.toISOString(), sessionTimezone,
        userId, actorId, original.replaces_id ?? original.id,
      ),
    ]);
    return json({ ok: true, id: replacement });
  }

  return json({ error: "method not allowed" }, 405);
}
