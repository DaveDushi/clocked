import { orgPlan } from "./plans.js";
import { membershipSessionScope, sessionInScope } from "./team-scope.js";
import { breakStats, teamBreakStats, type BreakStats } from "./break-stats.js";
import { getTeamDelivery } from "./delivery.js";
import { buildAndSendReport } from "./email.js";
import {
  periodQueryBounds,
  SESSION_COLUMNS,
  summarizeMonth,
  type SessionRow,
} from "./report.js";
import { localYMD } from "./time.js";
import type { Env } from "./types";

export interface OverviewDay {
  date: string;
  minutes: number;
  start: string;
  end: string;
  breakMinutes: number;
  breakCount: number;
}

export interface OverviewMember {
  id: string;
  name: string;
  email: string;
  role: string;
  stats: BreakStats;
  days: OverviewDay[];
  /** Sessions entered or edited in the dashboard this month. */
  enteredSessions: number;
}

export interface TeamOverview {
  period: string;
  tz: string;
  /** Local date of "today" in the team timezone; the month is partial while it is inside it. */
  today: string;
  members: OverviewMember[];
  team: BreakStats;
  median: ReturnType<typeof teamBreakStats>["median"];
}

/** Every member's month in one query, using the same day accounting as a single timesheet. */
export async function buildTeamOverview(
  env: Env,
  organizationId: string,
  period: string,
  timezone: string,
  now: Date = new Date(),
): Promise<TeamOverview> {
  const members = await env.DB.prepare(
    `SELECT u.id AS id, u.name AS name, u.email AS email, m.role AS role, m.createdAt, o.metadata
       FROM member m JOIN user u ON u.id = m.userId JOIN organization o ON o.id = m.organizationId
      WHERE m.organizationId = ?
      ORDER BY u.name, u.email`,
  ).bind(organizationId).all<{ id: string; name: string; email: string; role: string; createdAt: string | number; metadata: string | null }>();
  const { start, end } = periodQueryBounds(period);
  const sessions = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS.split(", ").map((column) => "s." + column).join(", ")}
       FROM sessions s JOIN member m ON m.userId = s.user_id AND m.organizationId = ?
      WHERE s.end_utc IS NOT NULL AND s.end_utc > ? AND s.start_utc < ?
      ORDER BY s.start_utc`,
  ).bind(organizationId, start.toISOString(), end.toISOString()).all<SessionRow>();
  const scopes = new Map((members.results ?? []).map((member) =>
    [member.id, membershipSessionScope({ ...member, plan: orgPlan(member.metadata) })] as const));
  const rowsByUser = new Map<string, SessionRow[]>();
  for (const row of sessions.results ?? []) {
    if (!row.user_id) continue;
    const scope = scopes.get(row.user_id);
    if (!scope || !sessionInScope(row.start_utc, scope)) continue;
    const rows = rowsByUser.get(row.user_id) ?? [];
    rows.push(row);
    rowsByUser.set(row.user_id, rows);
  }

  const overview = (members.results ?? []).map((member): OverviewMember => {
    const month = summarizeMonth(rowsByUser.get(member.id) ?? [], period, timezone, now);
    return {
      id: member.id, email: member.email, role: member.role,
      name: member.name || member.email,
      stats: breakStats(month.recordedDays),
      days: month.recordedDays.map((day) => ({
        date: day.date, minutes: day.minutes, start: day.start, end: day.end,
        breakMinutes: day.breakMinutes, breakCount: day.breaks.length,
      })),
      enteredSessions: new Set(month.sessions.filter((s) => s.entry !== null).map((s) => s.id)).size,
    };
  });
  const { team, median } = teamBreakStats(overview.map((member) => member.stats));
  const today = localYMD(now, timezone);
  return {
    period,
    tz: timezone,
    today: `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`,
    members: overview,
    team,
    median,
  };
}

export const MAX_TEAM_SEND = 100;

export type TeamSendResult =
  | { ok: true; period: string; recipients: string[]; results: { userId: string; ok: boolean; error?: string }[] }
  | { ok: false; status: number; error: string };

/** Parse and validate a bulk selection: unique member ids, at least one. */
export function parseSelection(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128))];
  if (ids.length === 0 || ids.length !== value.length || ids.length > MAX_TEAM_SEND) return null;
  return ids;
}

/**
 * Email one timesheet per selected member to the team's delivery recipients.
 * Callers authorize the manager; this rejects the whole request if any selected
 * id is not a current member, so nobody outside the team can be included.
 */
export async function sendTeamTimesheets(
  env: Env,
  organizationId: string,
  period: string,
  userIds: readonly string[],
): Promise<TeamSendResult> {
  const members = await env.DB.prepare("SELECT userId FROM member WHERE organizationId = ?")
    .bind(organizationId).all<{ userId: string }>();
  const ids = new Set((members.results ?? []).map((member) => member.userId));
  if (!userIds.every((id) => ids.has(id))) {
    return { ok: false, status: 403, error: "selection includes someone outside your team" };
  }
  const delivery = await getTeamDelivery(env, organizationId);
  const recipients = delivery.recipients.length ? delivery.recipients : delivery.defaultRecipients;
  if (recipients.length === 0) return { ok: false, status: 400, error: "no recipients" };
  const results: { userId: string; ok: boolean; error?: string }[] = [];
  for (const userId of userIds) {
    const sent = await buildAndSendReport(env, period, {
      force: true, userId, to: recipients, timezone: delivery.schedule.timezone, organizationId,
    });
    results.push(sent.ok ? { userId, ok: true } : { userId, ok: false, error: sent.error || "send failed" });
  }
  return { ok: true, period, recipients, results };
}
