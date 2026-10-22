import type { Env } from "./types";
import { getPrimaryMembership, isManagerOf } from "./memberships.js";

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
  const membership = await getPrimaryMembership(env, userId);
  const policy = membership ? await teamPolicy(env, membership.organizationId) : null;
  return policy ? { timeout_secs: policy.timeout_secs, warning_secs: policy.warning_secs } : null;
}

export async function handleManagerInactivity(req: Request, env: Env, actorId: string): Promise<Response> {
  const orgId = new URL(req.url).searchParams.get("organizationId") ?? "";
  if (!(await isManagerOf(env, actorId, orgId))) {
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
