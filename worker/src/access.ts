import { isPaidBillingStatusWithGrace } from "./plans.js";
import type { Env } from "./types";

export interface AccessRow {
  source: "complimentary" | "billing";
  status: string | null;
  updatedAt: number | null;
}

/** Evaluate access rows separately so grace-period behavior is easy to test. */
export function accessRowsGrantAccess(
  rows: AccessRow[],
  nowMs: number = Date.now(),
): boolean {
  return rows.some(
    (row) =>
      row.source === "complimentary" ||
      isPaidBillingStatusWithGrace(row.status, row.updatedAt, nowMs),
  );
}

/**
 * True when the user has a paid organization or their current account email is
 * on the complimentary-access list. Email matching is case-insensitive, and a
 * grant may exist before the user signs up.
 */
export async function userHasProductAccess(env: Env, userId: string): Promise<boolean> {
  if (!userId) return false;

  // Return both possible access sources in one D1 round trip. Billing status is
  // evaluated in JS because past_due has a finite grace window.
  const res = await env.DB.prepare(
    `SELECT 'complimentary' AS source, NULL AS status, NULL AS updatedAt
       FROM complimentary_access c
       JOIN user u ON c.email = lower(trim(u.email))
      WHERE u.id = ?
      UNION ALL
     SELECT 'billing' AS source, b.status AS status, b.updatedAt AS updatedAt
       FROM member m
       JOIN org_billing b ON b.organizationId = m.organizationId
      WHERE m.userId = ?
        AND b.status IN ('active', 'trialing', 'past_due')`,
  )
    .bind(userId, userId)
    .all<AccessRow>();

  return accessRowsGrantAccess(res.results ?? []);
}
