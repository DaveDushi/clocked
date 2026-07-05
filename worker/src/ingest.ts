import type { Env, SessionIn } from "./types";

/** POST /sessions — validate and upsert synced sessions (idempotent by id). */
export async function handleIngest(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const raw = (body as { sessions?: unknown })?.sessions;
  const sessions = Array.isArray(raw) ? raw : [];
  const valid = sessions.filter(isValid);
  if (valid.length === 0) {
    return json({ ok: true, upserted: 0 });
  }

  const stmt = env.DB.prepare(
    `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       start_utc    = excluded.start_utc,
       end_utc      = excluded.end_utc,
       start_reason = excluded.start_reason,
       end_reason   = excluded.end_reason`,
  );
  await env.DB.batch(
    valid.map((s) =>
      stmt.bind(s.id, s.start_utc, s.end_utc, s.start_reason ?? null, s.end_reason ?? null),
    ),
  );

  return json({ ok: true, upserted: valid.length });
}

function isValid(s: unknown): s is SessionIn {
  const o = s as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === "string" &&
    typeof o.start_utc === "string" &&
    typeof o.end_utc === "string" &&
    !Number.isNaN(Date.parse(o.start_utc)) &&
    !Number.isNaN(Date.parse(o.end_utc)) &&
    Date.parse(o.end_utc) > Date.parse(o.start_utc)
  );
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
