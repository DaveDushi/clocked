import type { Env } from "./types";

export type WorkingHours =
  | { mode: "disabled" }
  | { mode: "scheduled"; start: string; end: string; days: number[] };

type EffectiveHours = {
  schedule: WorkingHours | null;
  source: "personal" | "team" | "member";
  organizationName: string | null;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** null means inherit. Disabled explicitly turns off the after-hours prompt. */
export function parseWorkingHours(value: unknown): WorkingHours | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("mode" in value)) {
    throw new Error("Choose personal hours, a schedule, or no after-hours prompt.");
  }
  if (value.mode === "disabled") return { mode: "disabled" };
  if (value.mode !== "scheduled" || !("start" in value) || !("end" in value) || !("days" in value)) {
    throw new Error("Invalid working-hours schedule.");
  }
  const { start, end, days } = value;
  if (typeof start !== "string" || !TIME.test(start) || typeof end !== "string" || !TIME.test(end) || start === end) {
    throw new Error("Choose different start and end times in HH:MM format.");
  }
  if (!Array.isArray(days) || days.length < 1 || days.length > 7 ||
      !days.every((day: unknown): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7) ||
      new Set(days).size !== days.length) {
    throw new Error("Choose at least one working day, Monday through Sunday.");
  }
  return { mode: "scheduled", start, end, days: [...days].sort((a, b) => a - b) };
}

function storedHours(raw: string | null): WorkingHours | null {
  return raw === null ? null : parseWorkingHours(JSON.parse(raw));
}

/** Match report ownership: the earliest membership supplies the desktop policy. */
export async function effectiveWorkingHours(env: Env, userId: string): Promise<EffectiveHours> {
  const row = await env.DB.prepare(
    `SELECT o.name, oh.schedule AS team_schedule, mh.schedule AS member_schedule
       FROM member m JOIN organization o ON o.id = m.organizationId
       LEFT JOIN org_working_hours oh ON oh.organizationId = m.organizationId
       LEFT JOIN member_working_hours mh ON mh.membershipId = m.id
      WHERE m.userId = ? ORDER BY m.createdAt, m.id LIMIT 1`,
  ).bind(userId).first<{ name: string; team_schedule: string | null; member_schedule: string | null }>();
  if (!row) return { schedule: null, source: "personal", organizationName: null };
  const override = storedHours(row.member_schedule);
  const team = storedHours(row.team_schedule);
  return {
    schedule: override ?? team,
    source: override ? "member" : team ? "team" : "personal",
    organizationName: row.name,
  };
}

/** Called only after cookie authentication; authorization stays beside the writes. */
export async function handleManagerWorkingHours(req: Request, env: Env, actorId: string): Promise<Response> {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("organizationId") ?? "";
  const targetId = url.searchParams.get("userId");
  const manager = await env.DB.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?")
    .bind(orgId, actorId).first<{ role: string }>();
  if (!manager?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const member = targetId === null ? null : await env.DB.prepare("SELECT id FROM member WHERE organizationId = ? AND userId = ?")
    .bind(orgId, targetId).first<{ id: string }>();
  if (targetId !== null && !member) return Response.json({ error: "user is not in your organization" }, { status: 403 });

  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (req.method === "POST") {
    let schedule: WorkingHours | null;
    try {
      const body: unknown = await req.json();
      if (!body || typeof body !== "object" || !("schedule" in body)) throw new Error("schedule is required");
      schedule = parseWorkingHours(body.schedule);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, { status: 400 });
    }
    if (member) {
      if (schedule === null) {
        await env.DB.prepare("DELETE FROM member_working_hours WHERE membershipId = ?").bind(member.id).run();
      } else {
        await env.DB.prepare(`INSERT INTO member_working_hours (membershipId, schedule) VALUES (?, ?)
          ON CONFLICT(membershipId) DO UPDATE SET schedule = excluded.schedule`)
          .bind(member.id, JSON.stringify(schedule)).run();
      }
    } else if (schedule === null) {
      await env.DB.prepare("DELETE FROM org_working_hours WHERE organizationId = ?").bind(orgId).run();
    } else {
      await env.DB.prepare(`INSERT INTO org_working_hours (organizationId, schedule) VALUES (?, ?)
        ON CONFLICT(organizationId) DO UPDATE SET schedule = excluded.schedule`)
        .bind(orgId, JSON.stringify(schedule)).run();
    }
  }
  const row = member
    ? await env.DB.prepare("SELECT schedule FROM member_working_hours WHERE membershipId = ?").bind(member.id).first<{ schedule: string }>()
    : await env.DB.prepare("SELECT schedule FROM org_working_hours WHERE organizationId = ?").bind(orgId).first<{ schedule: string }>();
  return Response.json({ schedule: storedHours(row?.schedule ?? null) });
}
