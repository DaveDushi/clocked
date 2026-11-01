import type { Env } from "./types";
import { getSetting, setSetting } from "./settings.js";
import { getPrimaryMembership, isManagerRole } from "./memberships.js";

export type TrackingStatus = "tracking" | "disabled" | "no_device";
export function trackingStatus(enabled: boolean, hasDevice: boolean): TrackingStatus {
  return !hasDevice ? "no_device" : enabled ? "tracking" : "disabled";
}
export async function getTracking(env: Env, userId: string) {
  const enabled = await getSetting(env, `user:${userId}:tracking`) !== "off";
  const device = await env.DB.prepare("SELECT id FROM api_token WHERE userId = ? AND EXISTS (SELECT 1 FROM settings WHERE key = 'device:' || api_token.id || ':connected') LIMIT 1").bind(userId).first<{ id: string }>();
  return { enabled, status: trackingStatus(enabled, device !== null) };
}
export async function handleTracking(req: Request, env: Env, userId: string): Promise<Response> {
  const membership = await getPrimaryMembership(env, userId);
  if (!membership || !isManagerRole(membership.role)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (req.method !== "GET" && req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (req.method === "POST") {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    await setSetting(env, `user:${userId}:tracking`, body.enabled ? "on" : "off");
  }
  return Response.json(await getTracking(env, userId));
}
