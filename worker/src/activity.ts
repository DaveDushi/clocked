import type { Env } from "./types";
import { getTrackProjects, setTrackProjects } from "./settings";

/** Max day-aggregate rows accepted in a single POST /activity. */
export const MAX_ACTIVITY_ROWS = 2000;

export interface ActivityDayIn {
  day: string;
  app: string;
  project: string;
  secs: number;
}

/**
 * POST /activity — upsert daily app/project aggregates (no titles).
 * Desktop is the source of truth for a (day, app, project) triple; we replace
 * secs with the client's value so re-sync after endpoint change stays correct.
 *
 * Body may also include `track_projects: boolean` so the cloud dashboard and
 * monthly CSV can hide project rollups when the desktop feature flag is off
 * (even if historical activity_day rows remain).
 */
export async function handleActivityIngest(
  req: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const obj = body as { days?: unknown; track_projects?: unknown };
  const trackFlag =
    typeof obj.track_projects === "boolean" ? obj.track_projects : undefined;

  // Preference-only update: desktop turned the flag off (or on with no pending rows).
  if (trackFlag === false) {
    await setTrackProjects(env, userId, false);
    return json({ ok: true, accepted: 0, upserted: 0, track_projects: false });
  }

  const raw = obj.days;
  if (raw === undefined && trackFlag === true) {
    await setTrackProjects(env, userId, true);
    return json({ ok: true, accepted: 0, upserted: 0, track_projects: true });
  }
  if (!Array.isArray(raw)) {
    return json({ error: "days array required" }, 400);
  }
  if (raw.length > MAX_ACTIVITY_ROWS) {
    return json({ error: `too many rows (max ${MAX_ACTIVITY_ROWS})` }, 413);
  }

  // Empty days + track_projects true: just flip the cloud flag so UI can show
  // projects again after a previous disable (no new aggregates yet).
  if (raw.length === 0 && trackFlag === true) {
    await setTrackProjects(env, userId, true);
    return json({ ok: true, accepted: 0, upserted: 0, track_projects: true });
  }

  const valid = raw.filter(isValid);
  if (valid.length === 0) {
    return json({ error: "no valid rows", accepted: 0, upserted: 0 }, 400);
  }

  const now = new Date().toISOString();
  const stmts = valid.map((r) =>
    env.DB.prepare(
      `INSERT INTO activity_day (user_id, day, app, project, secs, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day, app, project) DO UPDATE SET
         secs = excluded.secs,
         updated_at = excluded.updated_at`,
    ).bind(userId, r.day, r.app, r.project, r.secs, now),
  );

  await env.DB.batch(stmts);
  // Ingesting project aggregates implies the feature is on for this account.
  await setTrackProjects(env, userId, true);
  return json({ ok: true, accepted: stmts.length, upserted: stmts.length, track_projects: true });
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_APP = 128;
const MAX_PROJECT = 128;
const MAX_SECS = 60 * 60 * 24 * 2; // 2 days of wall clock for one bucket is absurd but safe
function isValidCalendarDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Labels may be any language; block control chars and HTML-ish junk only. */
function isSafeLabel(s: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[<>]/.test(s)) return false;
  return true;
}

function isValid(s: unknown): s is ActivityDayIn {
  const o = s as Record<string, unknown>;
  if (!o || typeof o.day !== "string" || !DAY_RE.test(o.day) || !isValidCalendarDay(o.day)) {
    return false;
  }
  if (typeof o.app !== "string" || o.app.length === 0 || o.app.length > MAX_APP) return false;
  if (typeof o.project !== "string" || o.project.length === 0 || o.project.length > MAX_PROJECT) {
    return false;
  }
  if (!isSafeLabel(o.app) || !isSafeLabel(o.project)) return false;
  if (typeof o.secs !== "number" || !Number.isFinite(o.secs) || o.secs < 1 || o.secs > MAX_SECS) {
    return false;
  }
  // Reject titles / URLs if a buggy client ever sends them.
  if ("title" in o || "url" in o || "title_raw" in o) return false;
  return true;
}

/**
 * Project totals for a YYYY-MM period (from synced activity_day rows).
 * Returns [] when the desktop feature flag is explicitly off so the dashboard
 * "By project" block and monthly CSV omit projects after the user opts out.
 */
export async function projectTotalsForPeriod(
  env: Env,
  userId: string,
  period: string,
): Promise<{ project: string; minutes: number }[]> {
  // Explicit false = hide. null/true = show if data exists (legacy + opted-in).
  if ((await getTrackProjects(env, userId)) === false) {
    return [];
  }

  const prefix = period; // "YYYY-MM"
  try {
    const res = await env.DB.prepare(
      `SELECT project, SUM(secs) AS total
         FROM activity_day
        WHERE user_id = ? AND day >= ? AND day < ?
        GROUP BY project
        ORDER BY total DESC`,
    )
      .bind(userId, `${prefix}-01`, nextMonthStart(prefix))
      .all<{ project: string; total: number }>();
    return (res.results ?? []).map((r) => ({
      project: r.project,
      minutes: Math.round(Number(r.total) / 60),
    }));
  } catch {
    // Migration not applied yet.
    return [];
  }
}

function nextMonthStart(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (m === 12) return `${y + 1}-01-01`;
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
