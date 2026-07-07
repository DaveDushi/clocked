import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { downloadResponse, isDownloadMethod } from "./download";
import { faviconResponse } from "./favicon";
import { buildAndSendReport, sendMonthlyReports } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportCsv } from "./report";
import { getRecipients, getSendDay, setMailTo, setSendDay } from "./settings";
import { getOrCreateToken, rotateToken, userIdForToken } from "./tokens";
import { localYMD, previousMonthPeriod } from "./time";
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
        return json({
          recipients: await getRecipients(env, user.id, user.email),
          sendDay: await getSendDay(env, user.id),
        });
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          recipients?: unknown;
          sendDay?: unknown;
        };
        const recipients = Array.isArray(body.recipients)
          ? body.recipients.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)
          : [];
        if (recipients.length === 0) return json({ error: "at least one recipient required" }, 400);
        if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
        // Auto-send day: 0 disables, 1..28 selects the day (capped so it exists
        // in every month). Absent leaves the default (1st).
        let sendDay = 1;
        if (body.sendDay !== undefined) {
          const n = Number(body.sendDay);
          if (!Number.isInteger(n) || n < 0 || n > 28) return json({ error: "invalid send day" }, 400);
          sendDay = n;
        }
        await setMailTo(env, user.id, recipients.join("\n"));
        await setSendDay(env, user.id, sendDay);
        return json({ ok: true, recipients, sendDay });
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

  // Runs daily (06:00 UTC). Emails last month's report to each user on their
  // configured send day (default the 1st) in REPORT_TZ; the per-user
  // sent_reports guard keeps it to once a month.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    const { d } = localYMD(now, env.REPORT_TZ);
    const period = previousMonthPeriod(now, env.REPORT_TZ);
    ctx.waitUntil(sendMonthlyReports(env, period, { force: false, dayOfMonth: d }));
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
