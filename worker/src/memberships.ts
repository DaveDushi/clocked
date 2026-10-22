import type { Env } from "./types";
import { orgPlan } from "./plans.js";

export type PrimaryMembership = {
  id: string;
  organizationId: string;
  role: string;
  name: string;
  plan: string;
  createdAt: string;
};

export function isManagerRole(role: string): boolean {
  return role.split(",").some((role) => {
    const name = role.trim();
    return name === "owner" || name === "admin";
  });
}

export async function isManagerOf(env: Env, userId: string, organizationId: string): Promise<boolean> {
  if (!organizationId) return false;
  const member = await env.DB.prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?")
    .bind(userId, organizationId).first<{ role: string }>();
  return member !== null && isManagerRole(member.role);
}

export function normalizeMembershipDate(value: string | number): string {
  const parsed = typeof value === "number" ? value
    : /^\d+$/.test(value) ? Number(value)
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
      ? value.replace(" ", "T") + "Z" : value;
  return new Date(parsed).toISOString();
}

/** The same selector is embedded in the dashboard, using the API's normalized dates. */
export function selectPrimaryMembership<T extends { id: string; plan: string; createdAt: string }>(memberships: readonly T[]): T | null {
  return memberships.reduce<T | null>((selected, membership) => {
    if (!selected) return membership;
    const team = membership.plan === "team" || membership.plan === "teamplus" || membership.plan === "enterprise";
    const selectedTeam = selected.plan === "team" || selected.plan === "teamplus" || selected.plan === "enterprise";
    if (team !== selectedTeam) return team ? membership : selected;
    if (membership.createdAt !== selected.createdAt) return membership.createdAt < selected.createdAt ? membership : selected;
    return membership.id < selected.id ? membership : selected;
  }, null);
}

/** Queries use member alias m and organization alias o, including bulk cron delivery. */
export const PRIMARY_MEMBERSHIP_ORDER_SQL = `
  CASE WHEN json_valid(o.metadata) THEN
    CASE WHEN json_extract(o.metadata, '$.plan') IN ('team', 'teamplus', 'enterprise') THEN 0 ELSE 1 END
    ELSE 1 END,
  CASE WHEN typeof(m.createdAt) IN ('integer', 'real')
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', m.createdAt / 1000.0, 'unixepoch')
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', m.createdAt) END,
  m.id`;

export async function getPrimaryMembership(env: Env, userId: string): Promise<PrimaryMembership | null> {
  const row = await env.DB.prepare(`
    SELECT m.id, m.organizationId, m.role, m.createdAt, o.name, o.metadata
    FROM member m JOIN organization o ON o.id = m.organizationId
    WHERE m.userId = ? ORDER BY ${PRIMARY_MEMBERSHIP_ORDER_SQL} LIMIT 1
  `).bind(userId).first<Omit<PrimaryMembership, "plan" | "createdAt"> & { metadata: string | null; createdAt: string | number }>();
  if (!row) return null;
  return { id: row.id, organizationId: row.organizationId, role: row.role, name: row.name,
    plan: orgPlan(row.metadata), createdAt: normalizeMembershipDate(row.createdAt) };
}
