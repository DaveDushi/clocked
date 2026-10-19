import type { Env } from "./types";

export type InactivityPolicy = { timeout_secs: number; warning_secs: number };

export function parseInactivity(value: unknown): InactivityPolicy | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("timeout_secs" in value) || !("warning_secs" in value)) {
    throw new Error("Choose an inactivity limit and warning time.");
  }
  const { timeout_secs, warning_secs } = value;
  if (typeof timeout_secs !== "number" || !Number.isInteger(timeout_secs) || timeout_secs < 60 || timeout_secs > 86400 ||
      typeof warning_secs !== "number" || !Number.isInteger(warning_secs) || warning_secs < 0 || warning_secs >= timeout_secs) {
    throw new Error("Use a limit of 1 to 1440 minutes and a warning shorter than the limit. Zero turns off the warning.");
  }
  return { timeout_secs, warning_secs };
}

async function teamPolicy(env: Env, orgId: string): Promise<InactivityPolicy | null> {
  return env.DB.prepare("SELECT timeout_secs, warning_secs FROM org_inactivity WHERE organizationId = ?")
    .bind(orgId).first<InactivityPolicy>();
}

export async function effectiveInactivity(env: Env, userId: string): Promise<InactivityPolicy | null> {
  const row = await env.DB.prepare(`SELECT i.timeout_secs, i.warning_secs FROM member m
    LEFT JOIN org_inactivity i ON i.organizationId = m.organizationId
    WHERE m.userId = ? ORDER BY m.createdAt, m.id LIMIT 1`)
    .bind(userId).first<{ timeout_secs: number | null; warning_secs: number | null }>();
  return row?.timeout_secs != null && row.warning_secs != null
    ? { timeout_secs: row.timeout_secs, warning_secs: row.warning_secs } : null;
}

export async function handleManagerInactivity(req: Request, env: Env, actorId: string): Promise<Response> {
  const orgId = new URL(req.url).searchParams.get("organizationId") ?? "";
  const manager = await env.DB.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?")
    .bind(orgId, actorId).first<{ role: string }>();
  if (!manager?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (req.method === "POST") {
    let policy: InactivityPolicy | null;
    try {
      const body: unknown = await req.json();
      if (!body || typeof body !== "object" || !("policy" in body)) throw new Error("policy is required");
      policy = parseInactivity(body.policy);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid inactivity policy" }, { status: 400 });
    }
    if (policy === null) {
      await env.DB.prepare("DELETE FROM org_inactivity WHERE organizationId = ?").bind(orgId).run();
    } else {
      await env.DB.prepare(`INSERT INTO org_inactivity (organizationId, timeout_secs, warning_secs) VALUES (?, ?, ?)
        ON CONFLICT(organizationId) DO UPDATE SET timeout_secs = excluded.timeout_secs, warning_secs = excluded.warning_secs`)
        .bind(orgId, policy.timeout_secs, policy.warning_secs).run();
    }
  }
  return Response.json({ policy: await teamPolicy(env, orgId) });
}
