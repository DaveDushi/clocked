import { makeAuth } from "./auth-server";
import { orgPlan } from "./plans";
import type { Env } from "./types";

/** Write organization.metadata.plan, preserving other metadata keys. */
async function setOrgPlan(env: Env, orgId: string, plan: string, name?: string): Promise<void> {
  const row = await env.DB.prepare("SELECT metadata FROM organization WHERE id = ?")
    .bind(orgId)
    .first<{ metadata: string | null }>();
  let meta: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      /* replace unparseable metadata */
    }
  }
  meta.plan = plan;
  if (name) {
    await env.DB.prepare("UPDATE organization SET metadata = ?, name = ? WHERE id = ?")
      .bind(JSON.stringify(meta), name, orgId)
      .run();
  } else {
    await env.DB.prepare("UPDATE organization SET metadata = ? WHERE id = ?")
      .bind(JSON.stringify(meta), orgId)
      .run();
  }
}

/**
 * Give the user a team they manage. Reuses a team they already own, converts a
 * legacy 1-seat personal org in place, or creates a new org. The org is created
 * through better-auth so the owner membership matches a normal org, then
 * promoted to "team" here because the create hook forces client orgs to 1 seat.
 */
export async function ensureTeamOrg(
  env: Env,
  req: Request,
  user: { id: string; email: string },
  name?: string,
): Promise<string> {
  const owned = await env.DB.prepare(
    `SELECT o.id AS id, o.metadata AS metadata
       FROM member m JOIN organization o ON o.id = m.organizationId
      WHERE m.userId = ? AND m.role LIKE '%owner%'`,
  )
    .bind(user.id)
    .all<{ id: string; metadata: string | null }>();
  const orgs = owned.results ?? [];

  const team = orgs.find((o) => orgPlan(o.metadata) !== "single");
  if (team) return team.id;

  const local = user.email.split("@")[0] || "team";
  const label = ((name && name.trim()) || local + "'s team").slice(0, 80);

  const personal = orgs[0];
  if (personal) {
    await setOrgPlan(env, personal.id, "team", label);
    return personal.id;
  }

  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "team";
  const slug = base + "-" + Math.random().toString(36).slice(2, 6);
  const created = await makeAuth(env).api.createOrganization({
    body: { name: label, slug },
    headers: req.headers,
  });
  const orgId = (created as { id?: string } | null)?.id;
  if (!orgId) throw new Error("could not create team organization");
  await setOrgPlan(env, orgId, "team");
  return orgId;
}
