import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { downloadResponse, isDownloadMethod } from "./download";
import { faviconResponse } from "./favicon";
import { buildAndSendReport, sendContactSales, sendMonthlyReports, SEND_DAY_LAST } from "./email";
import { handleIngest } from "./ingest";
import { buildHoursReport, buildReportCsv } from "./report";
import {
  getEffectiveRecipients,
  getEffectiveSendDay,
  getOrgMailTo,
  getOrgSendDay,
  managerEmailsForOrg,
  orgIdForUser,
  parseRecipients,
  setMailTo,
  setOrgMailTo,
  setOrgSendDay,
  setSendDay,
} from "./settings";
import { getOrCreateToken, rotateToken, userIdForToken } from "./tokens";
import { formatHM, localYMD, monthBoundsUtc, previousMonthPeriod, wallToUtc } from "./time";
import {
  effectiveMemberCap,
  effectiveOrgPlan,
  isPaidBillingStatus,
  planLabel,
} from "./plans";
import {
  changeSubscriptionPlan,
  createCheckoutSession,
  createPortalSession,
  ensurePersonalOrg,
  ensureTeamOrg,
  handleWebhook,
  isSelfServePlan,
  userHasPaidAccess,
} from "./billing";
import { clientIp, rateLimitAllowDurable } from "./rate-limit";
import { parsePeriodParam, withSecurityHeaders } from "./security";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await handleFetch(req, env), req);
    } catch (e) {
      console.error("unhandled fetch error:", String((e as Error)?.message ?? e));
      return withSecurityHeaders(json({ error: "internal error" }, 500), req);
    }
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

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ip = clientIp(req);

  // Landing page + dashboard (single self-contained app) and health check.
  if (req.method === "GET" && url.pathname === "/") return dashboardResponse();
  if (isDownloadMethod(req.method) && url.pathname === "/download") return downloadResponse();
  if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")) {
    return faviconResponse();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response("clocked-worker ok\n", { status: 200 });
  }

  // Public "Contact sales" lead form — durable rate-limit to curb Resend abuse.
  if (req.method === "POST" && url.pathname === "/api/contact-sales") {
    if (!(await rateLimitAllowDurable(env.DB, `contact-sales:${ip}`, 3, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
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
    return json(result.ok ? { ok: true } : { error: result.error || "send failed" }, result.ok ? 200 : 500);
  }

  // better-auth handles all its own endpoints (sign-up, sign-in, session, ...).
  if (url.pathname.startsWith("/api/auth/")) {
    return makeAuth(env).handler(req);
  }

  // ---- Browser (session-cookie) API: everything below is per logged-in user.
  // `/api/me` allows unverified users so the dashboard can show the verify banner.
  // All other data APIs require a verified email.

  if (url.pathname === "/api/token" && req.method === "GET") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    return json(await getOrCreateToken(env, user.id));
  }
  if (url.pathname === "/api/token/regenerate" && req.method === "POST") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `token-regen:${user.id}`, 5, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return json(await rotateToken(env, user.id));
  }

  if (url.pathname === "/api/hours" && req.method === "GET") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    const period = resolvePeriod(url, env);
    if (!period) return json({ error: "invalid period" }, 400);
    return json(await buildHoursReport(env, period, user.id));
  }

  // ---- Team (manager) API.
  if (url.pathname === "/api/me" && req.method === "GET") {
    const user = await sessionUser(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const orgs = user.emailVerified ? await membershipsFor(env, user.id) : [];
    const manager = orgs.some((o) => isManagerRole(o.role));
    const hasAccess = user.emailVerified && orgs.some((o) => o.paid);
    const waitingOnTeam =
      user.emailVerified &&
      !hasAccess &&
      orgs.length > 0 &&
      !manager;
    // Team workers (non-managers) may not self-edit times — managers adjust for them.
    const canEditTimes = orgs.length === 0 || manager;
    return json({
      user: { id: user.id, email: user.email, emailVerified: user.emailVerified },
      orgs,
      manager,
      hasAccess,
      needsPlan: user.emailVerified && !hasAccess && !waitingOnTeam,
      waitingOnTeam,
      canEditTimes,
    });
  }

  if (url.pathname === "/api/team/members" && req.method === "GET") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
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
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    const targetId = url.searchParams.get("userId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (!targetId || !(await isMemberOf(env, targetId, orgId))) {
      return json({ error: "user is not in your organization" }, 403);
    }
    const period = resolvePeriod(url, env);
    if (!period) return json({ error: "invalid period" }, 400);
    if (url.pathname === "/api/team/preview") {
      const csv = await buildReportCsv(env, period, targetId);
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    }
    return json(await buildHoursReport(env, period, targetId));
  }

  if (url.pathname === "/api/team/settings") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (req.method === "GET") {
      return json({
        recipients: parseRecipients(await getOrgMailTo(env, orgId)),
        sendDay: await getOrgSendDay(env, orgId),
        defaultRecipients: await managerEmailsForOrg(env, orgId),
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
      if (recipients.length > 20) return json({ error: "too many recipients" }, 400);
      if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
      let sendDay = 1;
      if (body.sendDay !== undefined) {
        const n = Number(body.sendDay);
        const valid = n === 0 || n === SEND_DAY_LAST || (n >= 1 && n <= 28);
        if (!Number.isInteger(n) || !valid) return json({ error: "invalid send day" }, 400);
        sendDay = n;
      }
      await setOrgMailTo(env, orgId, recipients.join("\n"));
      await setOrgSendDay(env, orgId, sendDay);
      return json({ ok: true, recipients, sendDay });
    }
  }

  if (url.pathname === "/api/team/manual-session") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    const targetId = url.searchParams.get("userId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (!targetId || !(await isMemberOf(env, targetId, orgId))) {
      return json({ error: "user is not in your organization" }, 403);
    }
    return handleManualSession(req, url, env, targetId);
  }

  // ---- Billing (Stripe).
  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    return handleWebhook(req, env);
  }
  if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
    const user = await requireVerifiedUser(req, env);
    if (user instanceof Response) return user;
    const body = (await req.json().catch(() => ({}))) as {
      plan?: unknown;
      organizationId?: unknown;
      organizationName?: unknown;
    };
    const plan = typeof body.plan === "string" ? body.plan : "";
    if (!isSelfServePlan(plan)) return json({ error: "invalid plan" }, 400);
    const orgName =
      typeof body.organizationName === "string" ? body.organizationName.trim().slice(0, 80) : "";
    let targetOrg: string;
    try {
      if (plan === "single") {
        targetOrg = await ensurePersonalOrg(env, req, user);
      } else {
        targetOrg = typeof body.organizationId === "string" ? body.organizationId : "";
        if (targetOrg) {
          if (!(await isManagerOf(env, user.id, targetOrg))) {
            return json({ error: "forbidden" }, 403);
          }
        } else {
          // One-click team checkout: create workspace if needed, then Stripe.
          targetOrg = await ensureTeamOrg(env, req, user, orgName || undefined);
        }
      }
      const checkoutUrl = await createCheckoutSession(env, {
        orgId: targetOrg,
        plan,
        email: user.email,
        origin: url.origin,
      });
      if (!checkoutUrl) return json({ error: "checkout unavailable" }, 502);
      return json({ url: checkoutUrl, organizationId: targetOrg });
    } catch (e) {
      console.error("stripe checkout error:", String((e as Error)?.message ?? e));
      return json({ error: "checkout unavailable" }, 502);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/billing/portal") {
    const user = await requireVerifiedUser(req, env);
    if (user instanceof Response) return user;
    const body = (await req.json().catch(() => ({}))) as { organizationId?: unknown };
    const targetOrg = typeof body.organizationId === "string" ? body.organizationId : "";
    if (!(await isManagerOf(env, user.id, targetOrg))) return json({ error: "forbidden" }, 403);
    try {
      const portalUrl = await createPortalSession(env, { orgId: targetOrg, origin: url.origin });
      if (!portalUrl) return json({ error: "no subscription" }, 400);
      return json({ url: portalUrl });
    } catch (e) {
      console.error("stripe portal error:", String((e as Error)?.message ?? e));
      return json({ error: "portal unavailable" }, 502);
    }
  }

  // Upgrade or downgrade an existing subscription (prorated). Seat-cap checked server-side.
  if (req.method === "POST" && url.pathname === "/api/billing/change-plan") {
    const user = await requireVerifiedUser(req, env);
    if (user instanceof Response) return user;
    const body = (await req.json().catch(() => ({}))) as {
      plan?: unknown;
      organizationId?: unknown;
    };
    const plan = typeof body.plan === "string" ? body.plan : "";
    if (!isSelfServePlan(plan)) return json({ error: "invalid plan" }, 400);
    const targetOrg = typeof body.organizationId === "string" ? body.organizationId : "";
    if (!(await isManagerOf(env, user.id, targetOrg))) return json({ error: "forbidden" }, 403);
    const result = await changeSubscriptionPlan(env, { orgId: targetOrg, plan });
    if (!result.ok) {
      const status = result.error.includes("seat") || result.error.includes("member") ? 409 : 400;
      return json({ error: result.error }, status);
    }
    return json({ ok: true, plan: result.plan });
  }

  if (url.pathname === "/api/manual-session") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    // Team workers cannot add/delete their own manual entries (managers use /api/team/manual-session).
    if (req.method === "POST" || req.method === "DELETE") {
      if (!(await canSelfServiceEditTimes(env, user.id))) {
        return json(
          { error: "your team manager controls timesheet adjustments" },
          403,
        );
      }
    }
    return handleManualSession(req, url, env, user.id);
  }

  if (url.pathname === "/api/settings") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    if (req.method === "GET") {
      const eff = await getEffectiveRecipients(env, user.id, user.email);
      return json({
        recipients: eff.recipients,
        sendDay: await getEffectiveSendDay(env, user.id),
        managed: eff.managed,
      });
    }
    if (req.method === "POST") {
      if (await orgIdForUser(env, user.id)) {
        return json({ error: "your team manager controls timesheet delivery" }, 403);
      }
      const body = (await req.json().catch(() => ({}))) as {
        recipients?: unknown;
        sendDay?: unknown;
      };
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)
        : [];
      if (recipients.length === 0) return json({ error: "at least one recipient required" }, 400);
      if (recipients.length > 20) return json({ error: "too many recipients" }, 400);
      if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
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

  if (req.method === "GET" && url.pathname === "/preview") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    const period = resolvePeriod(url, env);
    if (!period) return json({ error: "invalid period" }, 400);
    const csv = await buildReportCsv(env, period, user.id);
    return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
  }

  // Manual send — throttled (force email is expensive / abusable).
  if (req.method === "POST" && url.pathname === "/api/send") {
    const user = await requirePaidUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `send:${user.id}`, 3, 60 * 60_000))) {
      return json({ error: "too many sends; try again later" }, 429);
    }
    const period = resolvePeriod(url, env);
    if (!period) return json({ error: "invalid period" }, 400);
    const { recipients: to } = await getEffectiveRecipients(env, user.id, user.email);
    const result = await buildAndSendReport(env, period, { force: true, userId: user.id, to });
    return json(
      result.ok
        ? { ok: true, period: result.period, rows: result.rows, recipients: to.length }
        : { error: result.error || "send failed" },
      result.ok ? 200 : 500,
    );
  }

  // ---- Desktop-app (Bearer-token) API.
  if (req.method === "POST" && url.pathname === "/sessions") {
    if (!(await rateLimitAllowDurable(env.DB, `sessions:${ip}`, 60, 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = await userIdForToken(env, bearer);
    if (userId) {
      if (!(await userHasPaidAccess(env, userId))) {
        return json({ error: "subscription required" }, 402);
      }
      if (!(await rateLimitAllowDurable(env.DB, `sessions:user:${userId}`, 120, 60_000))) {
        return json({ error: "too many requests" }, 429);
      }
      return handleIngest(req, env, userId);
    }
    // Legacy global token: opt-in only (ALLOW_LEGACY_BEARER_TOKEN=true). Off by default.
    if (legacyBearerEnabled(env) && checkAuth(req, env)) {
      return handleIngest(req, env, null);
    }
    return json({ error: "unauthorized" }, 401);
  }

  return json({ error: "not found" }, 404);
}

function resolvePeriod(url: URL, env: Env): string | null {
  const raw = url.searchParams.get("period");
  if (raw == null || raw === "") return previousMonthPeriod(new Date(), env.REPORT_TZ);
  return parsePeriodParam(raw);
}

interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** The logged-in user from the better-auth session cookie, or null. */
async function sessionUser(req: Request, env: Env): Promise<SessionUser | null> {
  const data = await makeAuth(env).api.getSession({ headers: req.headers });
  const u = data?.user;
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    emailVerified: !!u.emailVerified,
  };
}

/** Session user with verified email, or a 401/403 Response. */
async function requireVerifiedUser(
  req: Request,
  env: Env,
): Promise<SessionUser | Response> {
  const user = await sessionUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.emailVerified) return json({ error: "email not verified" }, 403);
  return user;
}

/**
 * Verified user on a paid org (owner or member). Used for product APIs.
 * Billing/checkout stays on requireVerifiedUser so unpaid users can subscribe.
 */
async function requirePaidUser(
  req: Request,
  env: Env,
): Promise<SessionUser | Response> {
  const user = await requireVerifiedUser(req, env);
  if (user instanceof Response) return user;
  if (!(await userHasPaidAccess(env, user.id))) {
    return json({ error: "subscription required" }, 402);
  }
  return user;
}

/** Legacy global BEARER_TOKEN is off unless explicitly opted in. */
function legacyBearerEnabled(env: Env): boolean {
  const v = env.ALLOW_LEGACY_BEARER_TOKEN;
  return v === "true" || v === "1";
}

interface MembershipRow {
  organizationId: string;
  role: string;
  name: string;
  metadata: string | null;
  memberCount: number;
  billingStatus: string | null;
}

/** Orgs the user belongs to, with paid-aware plan/cap for the dashboard. */
async function membershipsFor(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT m.organizationId AS organizationId, m.role AS role, o.name AS name, o.metadata AS metadata,
            (SELECT COUNT(*) FROM member m2 WHERE m2.organizationId = o.id) AS memberCount,
            b.status AS billingStatus
       FROM member m JOIN organization o ON o.id = m.organizationId
       LEFT JOIN org_billing b ON b.organizationId = o.id
      WHERE m.userId = ?
      ORDER BY o.name`,
  )
    .bind(userId)
    .all<MembershipRow>();

  return Promise.all(
    (res.results ?? []).map(async (r) => {
      const plan = await effectiveOrgPlan(env, r.organizationId, r.metadata);
      const cap = await effectiveMemberCap(env, r.organizationId);
      const paid = isPaidBillingStatus(r.billingStatus);
      return {
        organizationId: r.organizationId,
        role: r.role,
        name: r.name,
        plan,
        planLabel: planLabel(plan),
        cap,
        memberCount: r.memberCount,
        billingStatus: r.billingStatus ?? "",
        paid,
      };
    }),
  );
}

function isManagerRole(role: string): boolean {
  return role.split(",").some((r) => {
    const t = r.trim();
    return t === "owner" || t === "admin";
  });
}

async function isManagerOf(env: Env, userId: string, organizationId: string): Promise<boolean> {
  if (!organizationId) return false;
  const row = await env.DB.prepare(
    `SELECT role FROM member WHERE userId = ? AND organizationId = ?`,
  )
    .bind(userId, organizationId)
    .first<{ role: string }>();
  return !!row && isManagerRole(row.role);
}

/**
 * Solo accounts and org managers can add/edit their own manual times.
 * Pure team workers cannot — only managers adjust timesheets for the team.
 */
async function canSelfServiceEditTimes(env: Env, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(`SELECT role FROM member WHERE userId = ?`)
    .bind(userId)
    .all<{ role: string }>();
  const roles = res.results ?? [];
  if (roles.length === 0) return true;
  return roles.some((r) => isManagerRole(r.role));
}

async function handleManualSession(
  req: Request,
  url: URL,
  env: Env,
  userId: string,
): Promise<Response> {
  if (req.method === "GET") {
    const period = resolvePeriod(url, env);
    if (!period) return json({ error: "invalid period" }, 400);
    const { start, end } = monthBoundsUtc(period, env.REPORT_TZ);
    const res = await env.DB.prepare(
      `SELECT id, start_utc, end_utc FROM sessions
        WHERE user_id = ? AND start_reason = 'manual' AND end_utc > ? AND start_utc < ?
        ORDER BY start_utc`,
    )
      .bind(userId, start.toISOString(), end.toISOString())
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
    if (!id || id.length > 128) return json({ error: "id required" }, 400);
    const res = await env.DB.prepare(
      `DELETE FROM sessions WHERE id = ? AND user_id = ? AND start_reason = 'manual'`,
    )
      .bind(id, userId)
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
      .bind(crypto.randomUUID(), startUtc.toISOString(), endUtc.toISOString(), userId)
      .run();
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

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
