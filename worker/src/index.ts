import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { buildAndSendReport } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportTsv } from "./report";
import { getSetting, setSetting } from "./settings";
import { isFirstOfMonth, previousMonthPeriod } from "./time";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Dashboard (browser) and health check.
    if (req.method === "GET" && url.pathname === "/") return dashboardResponse();
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("clocked-worker ok\n", { status: 200 });
    }

    // better-auth handles all its own endpoints (sign-in, sign-out, session, ...).
    if (url.pathname.startsWith("/api/auth/")) {
      return makeAuth(env).handler(req);
    }

    // Browser dashboard data — protected by the better-auth session cookie.
    if (url.pathname === "/api/hours" && req.method === "GET") {
      if (!(await hasSession(req, env))) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      return json(await buildHoursReport(env, period));
    }
    if (url.pathname === "/api/settings") {
      if (!(await hasSession(req, env))) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET") {
        return json({ mailTo: (await getSetting(env, "mail_to")) ?? env.MAIL_TO });
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { mailTo?: unknown };
        const mailTo = typeof body.mailTo === "string" ? body.mailTo.trim() : "";
        if (!isEmail(mailTo)) return json({ error: "invalid email" }, 400);
        await setSetting(env, "mail_to", mailTo);
        return json({ ok: true, mailTo });
      }
    }

    // One-time seeding of the single dashboard user. Bearer-guarded; refuses once
    // a user exists, so the public sign-up stays disabled.
    if (req.method === "POST" && url.pathname === "/api/seed") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      return handleSeed(req, env);
    }

    // Sync endpoint: desktop app pushes completed sessions here.
    if (req.method === "POST" && url.pathname === "/sessions") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      return handleIngest(req, env);
    }

    // Preview the report body without emailing (?period=YYYY-MM, default last).
    if (req.method === "GET" && url.pathname === "/preview") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const tsv = await buildReportTsv(env, period);
      return new Response(tsv, { status: 200, headers: { "content-type": "text/plain" } });
    }

    // Manual test trigger: build + send a report now, bypassing the date gate.
    if (req.method === "POST" && url.pathname === "/send-test") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const result = await buildAndSendReport(env, period, { force: true });
      return json(result, result.ok ? 200 : 500);
    }

    return json({ error: "not found" }, 404);
  },

  // Runs daily (06:00 UTC); only emails on the 1st in REPORT_TZ, for last month.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (!isFirstOfMonth(now, env.REPORT_TZ)) return;
    const period = previousMonthPeriod(now, env.REPORT_TZ);
    ctx.waitUntil(buildAndSendReport(env, period, { force: false }).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

/** True if the request carries a valid better-auth session cookie. */
async function hasSession(req: Request, env: Env): Promise<boolean> {
  const session = await makeAuth(env).api.getSession({ headers: req.headers });
  return !!session;
}

/** POST /api/seed — create the one dashboard user if none exists yet. */
async function handleSeed(req: Request, env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT id FROM user LIMIT 1").first();
  if (existing) return json({ error: "already seeded" }, 409);

  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : email;
  if (!isEmail(email) || password.length < 8) {
    return json({ error: "email and password (>= 8 chars) required" }, 400);
  }

  try {
    await makeAuth(env, true).api.signUpEmail({ body: { email, password, name } });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
  return json({ ok: true, email });
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
