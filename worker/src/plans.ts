// Seat caps. clocked is free: every verified account gets the full product. The
// only distinction left is how many members an organization may hold, enforced
// by better-auth's membershipLimit and surfaced in the dashboard.
//
// organization.metadata.plan marks the org kind. "single" is a legacy 1-seat
// personal org (from the old paid Solo plan) and is also what client-created orgs
// are forced to, so seats can only grow through POST /api/team/create.
// "enterprise" is operator-provisioned only.

import type { Env } from "./types";

/** Members per team. Free, but bounded so invites can't be used to spam. */
export const TEAM_SEAT_CAP = 50;

const PLAN_CAPS: Record<string, number> = {
  single: 1,
  team: TEAM_SEAT_CAP,
  enterprise: 1_000_000,
};

/** Member cap for a plan key; unknown → single (1), never unlimited by accident. */
export function planCap(plan: string | null | undefined): number {
  if (plan && PLAN_CAPS[plan] != null) return PLAN_CAPS[plan];
  return PLAN_CAPS.single;
}

/** Human label for a plan key. */
export function planLabel(plan: string | null | undefined): string {
  return plan === "enterprise" ? "Enterprise" : plan === "team" ? "Team" : "Solo";
}

/**
 * Extract the plan key from an org's `metadata` (JSON string or object).
 * Former paid tiers (teamplus) read as "team". Defaults to "single".
 */
export function orgPlan(metadata: unknown): string {
  try {
    const o = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const p = o && (o as { plan?: unknown }).plan;
    if (p === "teamplus") return "team";
    if (typeof p === "string" && PLAN_CAPS[p]) return p;
  } catch {
    /* fall through */
  }
  return "single";
}

/** Authoritative seat cap for an org, from its stored metadata. */
export async function effectiveMemberCap(env: Env, orgId: string): Promise<number> {
  if (!orgId) return 1;
  const row = await env.DB.prepare("SELECT metadata FROM organization WHERE id = ?")
    .bind(orgId)
    .first<{ metadata: string | null }>();
  return planCap(orgPlan(row?.metadata));
}
