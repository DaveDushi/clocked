import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { downloadResponse, isDownloadMethod } from "./download";
import { faviconResponse } from "./favicon";
import { buildAndSendReport, sendContactSales, sendMonthlyReports, SEND_DAY_LAST } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportCsv } from "./report";
import { getRecipients, getSendDay, setMailTo, setSendDay } from "./settings";
import { getOrCreateToken, rotateToken, userIdForToken } from "./tokens";
import { formatHM, localYMD, monthBoundsUtc, previousMonthPeriod, wallToUtc } from "./time";
import { orgPlan, planCap, planLabel } from "./plans";
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

    // Public "Contact sales" lead form (Enterprise pricing tier). No auth — any
    // visitor can submit; it just emails the fixed sales inbox.
    if (req.method === "POST" && url.pathname === "/api/contact-sales") {
      const body = (await req.json().catch(() => ({}))) as {
        name?: unknown;
        email?: unknown;
        company?: unknown;
        teamSize?: unknown;
        message?: unknown;
      };
      const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
      const name = str(body.name, 200);
      const email = str(body.email, 200);
      if (!name || !email) return json({ error: "name and email are required" }, 400);
      if (!isEmail(email)) return json({ error: "invalid email" }, 400);
      const result = await sendContactSales(env, {
        name,
        email,
        company: str(body.company, 200),
        teamSize: str(body.teamSize, 100),
        message: str(body.message, 4000),
      });
      return json(result, result.ok ? 200 : 500);
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

    // ---- Team (manager) API. A manager — a member whose org role is owner/admin
    // — sees their org's roster and each member's hours. Every read is guarded:
    // the caller must manage `organizationId` and the target must belong to it.
    // Membership mutations (create org, invite, remove) go straight to
    // better-auth's own /api/auth/organization/* endpoints, so there's no code
    // for them here.
    if (url.pathname === "/api/me" && req.method === "GET") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const orgs = await membershipsFor(env, user.id);
      return json({ user, orgs, manager: orgs.some((o) => isManagerRole(o.role)) });
    }

    if (url.pathname === "/api/team/members" && req.method === "GET") {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const orgId = url.searchParams.get("organizationId") ?? "";
      if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
      const res = await env.DB.prepare(
        `SELECT u.id AS id, u.name AS name, u.email AS email, m.role AS role
           FROM member m JOIN user u ON u.id = m.userId
          WHERE m.organizationId = ?
          ORDER BY u.name`,
      )
        .bind(orgId)
        .all<{ id: string; name: string; email: string; role: string }>();
      return json({ members: res.results ?? [] });
    }

    if (
      (url.pathname === "/api/team/hours" || url.pathname === "/api/team/preview") &&
      req.method === "GET"
    ) {
      const user = await sessionUser(req, env);
      if (!user) return json({ error: "unauthorized" }, 401);
      const orgId = url.searchParams.get("organizationId") ?? "";
      const targetId = url.searchParams.get("userId") ?? "";
      if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
      if (!targetId || !(await isMemberOf(env, targetId, orgId))) {
        return json({ error: "user is not in your organization" }, 403);
      }
      const period = url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      if (url.pathname === "/api/team/preview") {
        const csv = await buildReportCsv(env, period, targetId);
        return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
      }
      return json(await buildHoursReport(env, period, targetId));
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

interface MembershipRow {
  organizationId: string;
  role: string;
  name: string;
  metadata: string | null;
  memberCount: number;
}

/** Every organization the user belongs to, with their role, the org name, and
 * the pricing tier (plan key, label, member cap, and current member count) so
 * the dashboard can show usage and gate invites at the cap. */
async function membershipsFor(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT m.organizationId AS organizationId, m.role AS role, o.name AS name, o.metadata AS metadata,
            (SELECT COUNT(*) FROM member m2 WHERE m2.organizationId = o.id) AS memberCount
       FROM member m JOIN organization o ON o.id = m.organizationId
      WHERE m.userId = ?
      ORDER BY o.name`,
  )
    .bind(userId)
    .all<MembershipRow>();
  return (res.results ?? []).map((r) => {
    const plan = orgPlan(r.metadata);
    return {
      organizationId: r.organizationId,
      role: r.role,
      name: r.name,
      plan,
      planLabel: planLabel(plan),
      cap: planCap(plan),
      memberCount: r.memberCount,
    };
  });
}

/** True when the role string grants manager rights (better-auth may store a
 * comma-separated list, so check each). */
function isManagerRole(role: string): boolean {
  return role.split(",").some((r) => {
    const t = r.trim();
    return t === "owner" || t === "admin";
  });
}

/** True when `userId` is an owner/admin member of `organizationId`. */
async function isManagerOf(env: Env, userId: string, organizationId: string): Promise<boolean> {
  if (!organizationId) return false;
  const row = await env.DB.prepare(
    `SELECT role FROM member WHERE userId = ? AND organizationId = ?`,
  )
    .bind(userId, organizationId)
    .first<{ role: string }>();
  return !!row && isManagerRole(row.role);
}

/** True when `userId` belongs to `organizationId` (any role). */
async function isMemberOf(env: Env, userId: string, organizationId: string): Promise<boolean> {
  if (!organizationId) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM member WHERE userId = ? AND organizationId = ?`,
  )
    .bind(userId, organizationId)
    .first<{ ok: number }>();
  return !!row;
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
