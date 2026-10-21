import { orgPlan } from "./plans.js";
import { getPrimaryMembership, normalizeMembershipDate } from "./memberships.js";
import type { Env } from "./types";

export type SessionScope = { kind: "personal" } | { kind: "team"; since: string };

export function membershipSessionScope(member: { plan: string; role: string; createdAt: string | number }): SessionScope {
  if (member.plan === "single" && member.role.split(",").includes("owner")) return { kind: "personal" };
  try { return { kind: "team", since: normalizeMembershipDate(member.createdAt) }; }
  catch { return { kind: "team", since: "9999-12-31T23:59:59.999Z" }; }
}

export function sessionInScope(startUtc: string, scope: SessionScope): boolean {
  return scope.kind === "personal" || Date.parse(startUtc) >= Date.parse(scope.since);
}

export async function getTeamSessionScope(env: Env, userId: string, organizationId: string): Promise<SessionScope | null> {
  const member = await env.DB.prepare(`SELECT m.role, m.createdAt, o.metadata
    FROM member m JOIN organization o ON o.id = m.organizationId
    WHERE m.userId = ? AND m.organizationId = ?`)
    .bind(userId, organizationId).first<{ role: string; createdAt: string | number; metadata: string | null }>();
  return member ? membershipSessionScope({ ...member, plan: orgPlan(member.metadata) }) : null;
}

export async function getEffectiveSessionScope(env: Env, userId: string): Promise<SessionScope> {
  const member = await getPrimaryMembership(env, userId);
  return member ? membershipSessionScope(member) : { kind: "personal" };
}
