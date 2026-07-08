// Pricing tiers (see the landing page). "single" is a paid solo plan modelled as
// a 1-seat personal organization, so all billing is org-scoped. team/teamplus map
// to a hard member cap enforced by better-auth's membershipLimit and surfaced in
// the dashboard. Enterprise is effectively unlimited and is sales-provisioned
// (not offered in the self-serve create form). A canceled/lapsed subscription is
// reverted to "single" — the smallest tier — by the Stripe webhook.
export const PLAN_CAPS: Record<string, number> = {
  single: 1,
  team: 5,
  teamplus: 30,
  enterprise: 1_000_000,
};

/** Member cap for a plan key; defaults to the most restrictive self-serve tier
 * (team = 5) for unknown/missing plans so a cap is never accidentally unlimited. */
export function planCap(plan: string | null | undefined): number {
  return (plan && PLAN_CAPS[plan]) || PLAN_CAPS.team;
}

/** Human label for a plan key. */
export function planLabel(plan: string | null | undefined): string {
  return plan === "single"
    ? "Single"
    : plan === "teamplus"
      ? "Team+"
      : plan === "enterprise"
        ? "Enterprise"
        : "Team";
}

/** Extract the plan key from an org's `metadata` (a JSON string or object),
 * defaulting to "team". */
export function orgPlan(metadata: unknown): string {
  try {
    const o = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const p = o && (o as { plan?: unknown }).plan;
    return typeof p === "string" && PLAN_CAPS[p] ? p : "team";
  } catch {
    return "team";
  }
}
