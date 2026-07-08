import type { Env, SessionIn } from "./types";

/** Max sessions accepted in a single POST /sessions (DoS / cost guard). */
export const MAX_SESSIONS_PER_REQUEST = 500;

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
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const raw = (body as { sessions?: unknown })?.sessions;
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
    return json({ error: "no valid sessions", accepted: [] as string[], upserted: 0 }, 400);
  }

  // Bulk ownership lookup (avoid N+1).
  const ownerById = new Map<string, string | null>();
  const deletedIds = new Set<string>();
  const chunk = 80;
  for (let i = 0; i < valid.length; i += chunk) {
    const slice = valid.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT id, user_id FROM sessions WHERE id IN (${placeholders})`,
    )
      .bind(...slice.map((s) => s.id))
      .all<{ id: string; user_id: string | null }>();
    for (const row of res.results ?? []) {
      ownerById.set(row.id, row.user_id);
    }
    // Manager/user deletions must not be resurrected by a later desktop sync.
    try {
      const del = await env.DB.prepare(
        `SELECT id FROM session_deletions WHERE id IN (${placeholders})`,
      )
        .bind(...slice.map((s) => s.id))
        .all<{ id: string }>();
      for (const row of del.results ?? []) deletedIds.add(row.id);
    } catch {
      /* migration 0010 not applied yet */
    }
  }

  const accepted: string[] = [];
  const stmts: D1PreparedStatement[] = [];

  for (const s of valid) {
    if (deletedIds.has(s.id)) {
      // Count as accepted so the desktop marks it synced and stops retrying.
      accepted.push(s.id);
      continue;
    }
    if (ownerById.has(s.id)) {
      const owner = ownerById.get(s.id) ?? null;
      // Block cross-account takeover; allow update when unattributed or same owner.
      if (owner != null && userId != null && owner !== userId) continue;
      if (owner != null && userId == null) continue; // legacy global token cannot steal
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           start_utc    = excluded.start_utc,
           end_utc      = excluded.end_utc,
           start_reason = excluded.start_reason,
           end_reason   = excluded.end_reason,
           user_id      = COALESCE(sessions.user_id, excluded.user_id)`,
      ).bind(
        s.id,
        s.start_utc,
        s.end_utc,
        s.start_reason ?? null,
        s.end_reason ?? null,
        userId,
      ),
    );
    accepted.push(s.id);
  }

  if (stmts.length === 0) {
    // All rejected, or only tombstoned (still return accepted so client settles).
    if (accepted.length > 0) {
      return json({ ok: true, upserted: 0, accepted });
    }
    return json({ error: "no sessions accepted", accepted: [], upserted: 0 }, 409);
  }

  await env.DB.batch(stmts);

  return json({ ok: true, upserted: stmts.length, accepted });
}

const MAX_REASON_LEN = 64;
const MAX_ID_LEN = 128;
/** Reject absurd multi-year spans (likely bad client data). */
const MAX_DURATION_MS = 1000 * 60 * 60 * 24 * 40; // 40 days

function isValid(s: unknown): s is SessionIn {
  const o = s as Record<string, unknown>;
  if (
    !o ||
    typeof o.id !== "string" ||
    typeof o.start_utc !== "string" ||
    typeof o.end_utc !== "string"
  ) {
    return false;
  }
  if (o.id.length === 0 || o.id.length > MAX_ID_LEN) return false;
  const start = Date.parse(o.start_utc);
  const end = Date.parse(o.end_utc);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return false;
  if (end - start > MAX_DURATION_MS) return false;
  if (
    o.start_reason != null &&
    (typeof o.start_reason !== "string" || o.start_reason.length > MAX_REASON_LEN)
  ) {
    return false;
  }
  if (
    o.end_reason != null &&
    (typeof o.end_reason !== "string" || o.end_reason.length > MAX_REASON_LEN)
  ) {
    return false;
  }
  return true;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
