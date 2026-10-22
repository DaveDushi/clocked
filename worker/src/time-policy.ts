import type { Env } from "./types";
import { isManagerOf } from "./memberships.js";

export interface TimePolicy {
  paidLunchMinutes: number;
  lunchMinMinutes: number;
  lunchMaxMinutes: number;
  longBreakMinutes: number;
  overtime: { mode: "disabled" } | { mode: "daily" | "weekly"; thresholdMinutes: number };
}

export const DEFAULT_TIME_POLICY: TimePolicy = {
  paidLunchMinutes: 0, lunchMinMinutes: 20, lunchMaxMinutes: 90, longBreakMinutes: 0, overtime: { mode: "disabled" },
};

export function parseTimePolicy(value: unknown): TimePolicy {
  if (!value || typeof value !== "object" || !("paidLunchMinutes" in value) || !("overtime" in value)) {
    throw new Error("Paid lunch and overtime settings are required.");
  }
  const { paidLunchMinutes, overtime } = value;
  if (!("lunchMinMinutes" in value) || !("lunchMaxMinutes" in value) || !("longBreakMinutes" in value)) {
    throw new Error("Lunch duration range and long-break limit are required.");
  }
  const { lunchMinMinutes, lunchMaxMinutes, longBreakMinutes } = value;
  if (typeof lunchMinMinutes !== "number" || !Number.isInteger(lunchMinMinutes) || lunchMinMinutes < 2 || lunchMinMinutes > 180 ||
      typeof lunchMaxMinutes !== "number" || !Number.isInteger(lunchMaxMinutes) || lunchMaxMinutes < lunchMinMinutes || lunchMaxMinutes > 240 ||
      typeof longBreakMinutes !== "number" || !Number.isInteger(longBreakMinutes) || longBreakMinutes < 0 || longBreakMinutes > 1440) {
    throw new Error("Choose a lunch range from 2 to 240 minutes and a long-break limit from 0 to 1440 minutes.");
  }
  if (typeof paidLunchMinutes !== "number" || !Number.isInteger(paidLunchMinutes) || paidLunchMinutes < 0 || paidLunchMinutes > 180) {
    throw new Error("Paid lunch must be a whole number from 0 to 180 minutes per day.");
  }
  const lunch = { paidLunchMinutes, lunchMinMinutes, lunchMaxMinutes, longBreakMinutes };
  if (!overtime || typeof overtime !== "object" || !("mode" in overtime)) throw new Error("Choose an overtime rule.");
  if (overtime.mode === "disabled") return { ...lunch, overtime: { mode: "disabled" } };
  if ((overtime.mode !== "daily" && overtime.mode !== "weekly") || !("thresholdMinutes" in overtime) ||
      typeof overtime.thresholdMinutes !== "number" || !Number.isInteger(overtime.thresholdMinutes) ||
      overtime.thresholdMinutes < 1 || overtime.thresholdMinutes > (overtime.mode === "daily" ? 1440 : 10080)) {
    throw new Error("Choose an overtime threshold of 1 to 1440 minutes per day or 1 to 10080 minutes per week.");
  }
  return { ...lunch, overtime: { mode: overtime.mode, thresholdMinutes: overtime.thresholdMinutes } };
}

export async function getTimePolicy(env: Env, organizationId: string): Promise<TimePolicy> {
  const row = await env.DB.prepare("SELECT * FROM org_time_policy WHERE organizationId = ?")
    .bind(organizationId).first<{ paid_lunch_minutes: number; lunch_min_minutes: number; lunch_max_minutes: number; long_break_minutes: number; overtime_mode: string; overtime_threshold_minutes: number }>();
  return row ? {
    paidLunchMinutes: row.paid_lunch_minutes,
    lunchMinMinutes: row.lunch_min_minutes, lunchMaxMinutes: row.lunch_max_minutes, longBreakMinutes: row.long_break_minutes,
    overtime: row.overtime_mode === "daily" || row.overtime_mode === "weekly"
      ? { mode: row.overtime_mode, thresholdMinutes: row.overtime_threshold_minutes } : { mode: "disabled" },
  } : DEFAULT_TIME_POLICY;
}

export async function handleManagerTimePolicy(req: Request, env: Env, actorId: string): Promise<Response> {
  const orgId = new URL(req.url).searchParams.get("organizationId") ?? "";
  if (!(await isManagerOf(env, actorId, orgId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (req.method === "POST") {
    let policy: TimePolicy;
    try { policy = parseTimePolicy(await req.json()); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid settings" }, { status: 400 }); }
    await env.DB.prepare(`INSERT INTO org_time_policy (organizationId, paid_lunch_minutes, lunch_min_minutes, lunch_max_minutes, long_break_minutes, overtime_mode, overtime_threshold_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organizationId) DO UPDATE SET paid_lunch_minutes = excluded.paid_lunch_minutes,
      lunch_min_minutes = excluded.lunch_min_minutes, lunch_max_minutes = excluded.lunch_max_minutes,
      long_break_minutes = excluded.long_break_minutes, overtime_mode = excluded.overtime_mode, overtime_threshold_minutes = excluded.overtime_threshold_minutes`)
      .bind(orgId, policy.paidLunchMinutes, policy.lunchMinMinutes, policy.lunchMaxMinutes, policy.longBreakMinutes,
        policy.overtime.mode, policy.overtime.mode === "disabled" ? 480 : policy.overtime.thresholdMinutes).run();
  }
  return Response.json({ policy: await getTimePolicy(env, orgId) });
}
