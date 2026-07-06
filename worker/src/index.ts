import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { downloadResponse, isDownloadMethod } from "./download";
import { faviconResponse } from "./favicon";
import { buildAndSendReport, sendMonthlyReports } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportCsv } from "./report";
import { getRecipients, setMailTo } from "./settings";
import { getOrCreateToken, rotateToken, userIdForToken } from "./tokens";
import { isFirstOfMonth, previousMonthPeriod } from "./time";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Landing page + dashboard (single self-contained app) and health check.
    if (req.method === "GET" && url.pathname === "/") return dashboardResponse();
    if (isDownloadMethod(req.method) && url.pathname === "/download") return downloadResponse();
    if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")) {
      return faviconResponse();
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("clocked-worker ok\n", { status: 200 });
    }

    // better-auth handles all its own endpoints (sign-up, sign-in, session, ...).
    if (url.pathname.startsWith("/api/auth/")) {
      return makeAuth(env).handler(req);
    }

    // ---- Browser (session-cookie) API: everything below is per logged-in user.
    if (url.pathname === "/api/token" && req.method === "GET") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ token: await getOrCreateToken(env, user.id) });
    }
    if (url.pathname === "/api/token/regenerate" && req.method === "POST") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ token: await rotateToken(env, user.id) });
    }

    if (url.pathname === "/api/hours" && req.method === "GET") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      return json(await buildHoursReport(env, period, user.id));
    }

    if (url.pathname === "/api/settings") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET") {
        return json({ recipients: await getRecipients(env, user.id, user.email) });
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { recipients?: unknown };
        const recipients = Array.isArray(body.recipients)
          ? body.recipients.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)
          : [];
        if (recipients.length === 0) return json({ error: "at least one recipient required" }, 400);
        if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
        await setMailTo(env, user.id, recipients.join("\n"));
        return json({ ok: true, recipients });
      }
    }

    // Preview this account's report body without emailing (?period=YYYY-MM).
    if (req.method === "GET" && url.pathname === "/preview") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const csv = await buildReportCsv(env, period, user.id);
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    }

    // Manual send: build + email this account's report now (bypasses the date
    // gate and the once-a-month guard). Sends the requested/selected month.
    if (req.method === "POST" && url.pathname === "/api/send") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const to = await getRecipients(env, user.id, user.email);
      const result = await buildAndSendReport(env, period, { force: true, userId: user.id, to });
      return json({ ...result, recipients: to.length }, result.ok ? 200 : 500);
    }

    // ---- Desktop-app (Bearer-token) API.
    // Sync endpoint: the desktop app pushes completed sessions here. The Bearer
    // resolves to the owning account; the global BEARER_TOKEN still works as a
    // legacy fallback (those sessions land unattributed).
    if (req.method === "POST" && url.pathname === "/sessions") {
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const userId = await userIdForToken(env, bearer);
      if (userId) return handleIngest(req, env, userId);
      if (checkAuth(req, env)) return handleIngest(req, env, null);
      return json({ error: "unauthorized" }, 401);
    }

    return json({ error: "not found" }, 404);
  },

  // Runs daily (06:00 UTC); only emails on the 1st in REPORT_TZ, for last month.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (!isFirstOfMonth(now, env.REPORT_TZ)) return;
    const period = previousMonthPeriod(now, env.REPORT_TZ);
    ctx.waitUntil(sendMonthlyReports(env, period, { force: false }));
  },
} satisfies ExportedHandler<Env>;

/** The logged-in user (id + email) from the better-auth session cookie, or null. */
async function sessionUser(req: Request, env: Env): Promise<{ id: string; email: string } | null> {
  const data = await makeAuth(env).api.getSession({ headers: req.headers });
  const u = data?.user;
  return u ? { id: u.id, email: u.email } : null;
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
