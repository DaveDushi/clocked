import type { Env } from "./types";
import { getPrimaryMembership, isManagerOf, isManagerRole } from "./memberships.js";
import { getSetting, setSetting } from "./settings.js";

export type WorkerEditPermission = "full" | "add_only" | "none";

function isWorkerEditPermission(value: unknown): value is WorkerEditPermission {
  return value === "full" || value === "add_only" || value === "none";
}

export async function getWorkerEditPermission(env: Env, organizationId: string): Promise<WorkerEditPermission> {
  const value = await getSetting(env, `org:${organizationId}:worker_edit_permission`);
  return isWorkerEditPermission(value) ? value : "none";
}

export async function getSelfEditPermission(env: Env, userId: string): Promise<WorkerEditPermission> {
  const membership = await getPrimaryMembership(env, userId);
  if (!membership || isManagerRole(membership.role)) return "full";
  return getWorkerEditPermission(env, membership.organizationId);
}

export function canMutateSessions(permission: WorkerEditPermission, method: string): boolean {
  return permission === "full" || (permission === "add_only" && method === "POST");
}

export async function handleWorkerPermissions(req: Request, env: Env, actorId: string): Promise<Response> {
  const organizationId = new URL(req.url).searchParams.get("organizationId") ?? "";
  if (!(await isManagerOf(env, actorId, organizationId))) return Response.json({ error: "forbidden" }, { status: 403 });
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (req.method === "POST") {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("permission" in body) || !isWorkerEditPermission(body.permission)) {
      return Response.json({ error: "Choose complete control, add only, or none." }, { status: 400 });
    }
    await setSetting(env, `org:${organizationId}:worker_edit_permission`, body.permission);
  }
  return Response.json({ permission: await getWorkerEditPermission(env, organizationId) });
}
