// Pricing tiers (see the landing page). "single" is a paid solo plan modelled as
// a 1-seat personal organization, so all billing is org-scoped. team/teamplus map
// to a hard member cap enforced by better-auth's membershipLimit and surfaced in
// the dashboard. Enterprise is sales-provisioned only (never from client metadata).
// A canceled/lapsed subscription is reverted to "single" by the Stripe webhook.
//
// Unpaid orgs (no active subscription) always get a 1-seat floor regardless of
// any client-supplied metadata.plan — plan elevation is Stripe-webhook-only.

import type { Env } from "./types";

export const PLAN_CAPS: Record<string, number> = {
  single: 1,
  team: 5,
  teamplus: 30,
  enterprise: 1_000_000,
};

/** Self-serve plans a client may request at checkout (not org-create metadata). */
export const SELF_SERVE_PLANS = ["single", "team", "teamplus"] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * How long `past_due` still grants paid access after the last billing update.
 * Matches a typical Stripe dunning window; after this, access is revoked until
 * payment succeeds (webhook moves status back to `active`).
 */
export const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** Member cap for a plan key; unknown → single (1), never unlimited by accident. */
export function planCap(plan: string | null | undefined): number {
  if (plan && PLAN_CAPS[plan] != null) return PLAN_CAPS[plan];
  return PLAN_CAPS.single;
}

/** Human label for a plan key. */
export function planLabel(plan: string | null | undefined): string {
  return plan === "teamplus"
    ? "Team+"
    : plan === "enterprise"
      ? "Enterprise"
      : plan === "team"
        ? "Team"
        : "Single";
}

/**
 * Extract the plan key from an org's `metadata` (JSON string or object).
 * Defaults to "single" (1 seat) — never to a multi-seat free tier.
 * Enterprise is only accepted if already stored (sales/webhook); clients cannot
 * escalate to it via create/update of metadata in our hooks.
 */
export function orgPlan(metadata: unknown): string {
  try {
    const o = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const p = o && (o as { plan?: unknown }).plan;
    if (typeof p === "string" && PLAN_CAPS[p]) return p;
  } catch {
    /* fall through */
  }
  return "single";
}

/**
 * True when Stripe status grants paid entitlements (without grace window).
 * Prefer {@link isPaidBillingStatusWithGrace} when `updatedAt` is available so
 * long-running `past_due` does not grant forever.
 */
export function isPaidBillingStatus(status: string | null | undefined): boolean {
  return !!status && PAID_STATUSES.has(status);
}

/**
 * Paid check with a finite grace for `past_due`.
 * `updatedAtMs` is org_billing.updatedAt (ms epoch) from the last webhook.
 * Missing `updatedAt` while past_due → still allowed (legacy rows) for one grace
 * period only if we treat "now" as the anchor — we fail closed after grace from 0.
 */
export function isPaidBillingStatusWithGrace(
  status: string | null | undefined,
  updatedAtMs: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!status) return false;
  if (status === "active" || status === "trialing") return true;
  if (status === "past_due") {
    const at = typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs) ? updatedAtMs : nowMs;
    return nowMs - at <= PAST_DUE_GRACE_MS;
  }
  return false;
}

/**
 * Authoritative seat cap for an org: unpaid → 1 (owner only).
 * Paid → cap of the billing plan (fallback metadata plan).
 */
export async function effectiveMemberCap(env: Env, orgId: string): Promise<number> {
  if (!orgId) return 1;
  const billing = await env.DB.prepare(
    "SELECT status, plan, updatedAt FROM org_billing WHERE organizationId = ?",
  )
    .bind(orgId)
    .first<{ status: string | null; plan: string | null; updatedAt: number | null }>();

  if (!isPaidBillingStatusWithGrace(billing?.status, billing?.updatedAt)) return 1;

  if (billing?.plan && PLAN_CAPS[billing.plan]) return planCap(billing.plan);

  const row = await env.DB.prepare("SELECT metadata FROM organization WHERE id = ?")
    .bind(orgId)
    .first<{ metadata: string | null }>();
  return planCap(orgPlan(row?.metadata));
}

/**
 * Plan key for UI/API: paid subscription plan, else "single" (unpaid floor).
 * Does not trust client-written multi-seat metadata when unpaid.
 */
export async function effectiveOrgPlan(env: Env, orgId: string, metadata: string | null): Promise<string> {
  const billing = await env.DB.prepare(
    "SELECT status, plan, updatedAt FROM org_billing WHERE organizationId = ?",
  )
    .bind(orgId)
    .first<{ status: string | null; plan: string | null; updatedAt: number | null }>();

  if (
    isPaidBillingStatusWithGrace(billing?.status, billing?.updatedAt) &&
    billing?.plan &&
    PLAN_CAPS[billing.plan]
  ) {
    return billing.plan;
  }
  // Unpaid: always single for entitlements, even if metadata was tampered.
  if (!isPaidBillingStatusWithGrace(billing?.status, billing?.updatedAt)) return "single";
  return orgPlan(metadata);
}
