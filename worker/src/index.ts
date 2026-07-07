import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { downloadResponse, isDownloadMethod } from "./download";
import { faviconResponse } from "./favicon";
import { buildAndSendReport, sendMonthlyReports, SEND_DAY_LAST } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportCsv } from "./report";
import { getRecipients, getSendDay, setMailTo, setSendDay } from "./settings";
import { getOrCreateToken, rotateToken, userIdForToken } from "./tokens";
import { formatHM, localYMD, monthBoundsUtc, previousMonthPeriod, wallToUtc } from "./time";
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

    // Manual time entries: log (POST), list (GET), or remove (DELETE) days the
    // desktop app missed. Times are local wall-clock in REPORT_TZ, stored as a
    // normal session with reason "manual" so it's distinguishable from an
    // auto-tracked one — and so only manual rows can be listed/deleted here.
    if (url.pathname === "/api/manual-session") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);

      if (req.method === "GET") {
        const period =
          url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
        const { start, end } = monthBoundsUtc(period, env.REPORT_TZ);
        const res = await env.DB.prepare(
          `SELECT id, start_utc, end_utc FROM sessions
            WHERE user_id = ? AND start_reason = 'manual' AND end_utc > ? AND start_utc < ?
            ORDER BY start_utc`,
        )
          .bind(user.id, start.toISOString(), end.toISOString())
          .all<{ id: string; start_utc: string; end_utc: string }>();
        const tz = env.REPORT_TZ;
        const entries = (res.results ?? []).map((r) => {
          const s = new Date(r.start_utc);
          const { y, m, d } = localYMD(s, tz);
          return {
            id: r.id,
            date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
            start: formatHM(s, tz),
            end: formatHM(new Date(r.end_utc), tz),
          };
        });
        return json({ entries });
      }

      if (req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown };
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return json({ error: "id required" }, 400);
        const res = await env.DB.prepare(
          `DELETE FROM sessions WHERE id = ? AND user_id = ? AND start_reason = 'manual'`,
        )
          .bind(id, user.id)
          .run();
        if (!res.meta.changes) return json({ error: "not found" }, 404);
        return json({ ok: true });
      }

      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          date?: unknown;
          start?: unknown;
          end?: unknown;
        };
        const date = typeof body.date === "string" ? body.date : "";
        const start = typeof body.start === "string" ? body.start : "";
        const end = typeof body.end === "string" ? body.end : "";
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !/^\d{2}:\d{2}$/.test(start) ||
          !/^\d{2}:\d{2}$/.test(end)
        ) {
          return json({ error: "invalid date or time" }, 400);
        }
        const [y, m, d] = date.split("-").map(Number);
        const [sh, smi] = start.split(":").map(Number);
        const [eh, emi] = end.split(":").map(Number);
        if (m < 1 || m > 12 || d < 1 || d > 31 || sh > 23 || smi > 59 || eh > 23 || emi > 59) {
          return json({ error: "invalid date or time" }, 400);
        }
        if (eh * 60 + emi <= sh * 60 + smi) {
          return json({ error: "clock-out must be after clock-in" }, 400);
        }
        const startUtc = wallToUtc(y, m, d, sh, smi, 0, env.REPORT_TZ);
        const endUtc = wallToUtc(y, m, d, eh, emi, 0, env.REPORT_TZ);
        await env.DB.prepare(
          `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, user_id)
           VALUES (?, ?, ?, 'manual', 'manual', ?)`,
        )
          .bind(crypto.randomUUID(), startUtc.toISOString(), endUtc.toISOString(), user.id)
          .run();
        return json({ ok: true });
      }
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
        // in every month), 99 = last day of the month. Absent leaves default (1st).
        let sendDay = 1;
        if (body.sendDay !== undefined) {
          const n = Number(body.sendDay);
          const valid = n === 0 || n === SEND_DAY_LAST || (n >= 1 && n <= 28);
          if (!Number.isInteger(n) || !valid) return json({ error: "invalid send day" }, 400);
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
  // configured send day (default the 1st, or the month's last day) in
  // REPORT_TZ; the per-user sent_reports guard keeps it to once a month.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    const { y, m, d } = localYMD(now, env.REPORT_TZ);
    const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const period = previousMonthPeriod(now, env.REPORT_TZ);
    ctx.waitUntil(sendMonthlyReports(env, period, { force: false, dayOfMonth: d, lastDayOfMonth }));
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
