import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import {
  downloadExtensionResponse,
  downloadMacResponse,
  downloadResponse,
  downloadWinResponse,
  isDownloadMethod,
} from "./download";
import { faviconResponse } from "./favicon";
import { ogImageResponse } from "./og";
import {
  extensionPrivacyPageResponse,
  llmsTxtResponse,
  pressPageResponse,
  robotsTxtResponse,
  sitemapXmlResponse,
} from "./marketing-pages";
import {
  indexNowKeyFileResponse,
  marketingStatusResponse,
  newsFeedResponse,
  newsPageResponse,
  runMarketingAgent,
} from "./marketing-agent";
import { buildAndSendReport, sendContactSales, sendMonthlyReports } from "./email";
import { handleActivityIngest, projectTotalsForPeriod } from "./activity";
import { handleIngest } from "./ingest";
import {
  buildHoursReport,
  buildReportCsv,
  listSessionsForPeriod,
  timezoneForLocalDate,
} from "./report";
import {
  getEffectiveRecipients,
  getEffectiveSendSchedule,
  getOrgMailTo,
  getOrgSendSchedule,
  managerEmailsForOrg,
  orgIdForUser,
  parseRecipients,
  setMailTo,
  setOrgMailTo,
  setOrgSendSchedule,
  setSendSchedule,
} from "./settings";
import {
  DEFAULT_SEND_TIME,
  DEFAULT_SEND_TIMEZONE,
  isValidSendDay,
  isValidSendTime,
  isValidTimeZone,
  type SendSchedule,
} from "./schedule";
import {
  getOrCreateToken,
  listTokens,
  MAX_DEVICE_TOKENS,
  mintToken,
  normalizeDeviceName,
  revokeToken,
  rotateToken,
  userIdForToken,
} from "./tokens";
import { previousMonthPeriod, wallToUtc } from "./time";
import { orgPlan, planCap, planLabel } from "./plans";
import { ensureTeamOrg } from "./teams";
import { handleAdminApprove, isApproved, requestApproval } from "./approval";
import { clientIp, rateLimitAllowDurable } from "./rate-limit";
import {
  isSameOriginRequest,
  isValidCalendarDate,
  parsePeriodParam,
  timingSafeEqual,
  withSecurityHeaders,
} from "./security";
import type { Env } from "./types";
import { effectiveWorkingHours, handleManagerWorkingHours } from "./working-hours";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await handleFetch(req, env), req);
    } catch (e) {
      console.error("unhandled fetch error:", String((e as Error)?.message ?? e));
      return withSecurityHeaders(json({ error: "internal error" }, 500), req);
    }
  },

  // Cron schedules (wrangler.jsonc):
  //   * * * * *   — monthly timesheet emails (per-user day, time, and timezone)
  //   0 14 * * * — marketing agent (IndexNow + site tips; optional X)
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === "0 14 * * *") {
      ctx.waitUntil(
        runMarketingAgent(env).then((r) => console.log("marketing agent:", r.summary)),
      );
      return;
    }
    ctx.waitUntil(sendMonthlyReports(env, now));
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ip = clientIp(req);

  // CSRF: cookie-authenticated mutating /api/* must be same-origin.
  // Exempt: better-auth (own origin checks),
  // desktop bearer ingest (/sessions, /activity — no cookies).
  if (
    url.pathname.startsWith("/api/") &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS" &&
    !url.pathname.startsWith("/api/auth/") &&
    url.pathname !== "/api/marketing/run" &&
    !isSameOriginRequest(req)
  ) {
    return json({ error: "forbidden" }, 403);
  }

  // Landing page + dashboard (single self-contained app) and health check.
  if (req.method === "GET" && url.pathname === "/") return dashboardResponse();
  if (isDownloadMethod(req.method) && url.pathname === "/download")
    return downloadResponse(req.headers.get("user-agent"));
  if (isDownloadMethod(req.method) && url.pathname === "/download/mac") return downloadMacResponse();
  if (isDownloadMethod(req.method) && url.pathname === "/download/win") return downloadWinResponse();
  if (
    isDownloadMethod(req.method) &&
    (url.pathname === "/download/extension" || url.pathname === "/download/chrome")
  ) {
    return downloadExtensionResponse();
  }
  if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")) {
    return faviconResponse();
  }
  if (req.method === "GET" && (url.pathname === "/og.jpg" || url.pathname === "/og.png")) {
    return ogImageResponse();
  }
  if (req.method === "GET" && url.pathname === "/robots.txt") return robotsTxtResponse();
  if (req.method === "GET" && url.pathname === "/sitemap.xml") return sitemapXmlResponse();
  if (req.method === "GET" && url.pathname === "/llms.txt") return llmsTxtResponse();
  if (req.method === "GET" && url.pathname === "/press") return pressPageResponse();
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/privacy/extension"
  ) {
    return extensionPrivacyPageResponse();
  }
  if (req.method === "GET" && url.pathname === "/news") return newsPageResponse(env);
  if (req.method === "GET" && url.pathname === "/news.xml") return newsFeedResponse(env);
  if (req.method === "GET" && url.pathname === "/api/marketing/status") {
    return marketingStatusResponse(env);
  }
  if (req.method === "POST" && url.pathname === "/api/marketing/run") {
    const secret = env.MARKETING_AGENT_SECRET;
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!secret || !timingSafeEqual(token, secret)) return json({ error: "unauthorized" }, 401);
    // Rate-limit only authenticated calls, so a caller without the secret can
    // never exhaust the budget and lock out the real operator. The scheduled
    // cron path calls runMarketingAgent directly and is unaffected.
    if (!(await rateLimitAllowDurable(env.DB, `marketing-run:${ip}`, 6, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const result = await runMarketingAgent(env);
    return json(result, result.ok ? 200 : 502);
  }
  // IndexNow key file: /{hex}.txt
  {
    const keyFile = await indexNowKeyFileResponse(env, url.pathname);
    if (keyFile) return keyFile;
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

  // Operator approve link from the new-signup email (HMAC-signed, no session).
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/admin/approve") {
    if (!(await rateLimitAllowDurable(env.DB, `admin-approve:${ip}`, 30, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return handleAdminApprove(req, env, url);
  }

  // better-auth handles all its own endpoints (sign-up, sign-in, session, ...).
  if (url.pathname.startsWith("/api/auth/")) {
    return makeAuth(env).handler(req);
  }

  // ---- Browser (session-cookie) API: everything below is per logged-in user.
  // `/api/me` allows unverified and unapproved users so the dashboard can show
  // the right gate. All other data APIs require a verified, approved account.

  if (url.pathname === "/api/token" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return json(await getOrCreateToken(env, user.id));
  }
  if (url.pathname === "/api/token/regenerate" && req.method === "POST") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `token-regen:${user.id}`, 5, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return json(await rotateToken(env, user.id));
  }
  if (url.pathname === "/api/tokens" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return json({ tokens: await listTokens(env, user.id) });
  }
  if (url.pathname === "/api/tokens" && req.method === "POST") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `token-mint:${user.id}`, 10, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = normalizeDeviceName(body.name);
    if (!name) return json({ error: "device name is required (max 64 characters)" }, 400);
    if ((await listTokens(env, user.id)).length >= MAX_DEVICE_TOKENS) {
      return json({ error: `device token limit reached (${MAX_DEVICE_TOKENS})` }, 409);
    }
    return json(await mintToken(env, user.id, name), 201);
  }
  const tokenIdMatch = /^\/api\/tokens\/([0-9a-f-]+)$/.exec(url.pathname);
  if (tokenIdMatch && req.method === "DELETE") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const revoked = await revokeToken(env, user.id, tokenIdMatch[1]);
    return revoked ? json({ ok: true }) : json({ error: "device token not found" }, 404);
  }

  if (url.pathname === "/api/hours" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const schedule = await getEffectiveSendSchedule(env, user.id);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const report = await buildHoursReport(env, period, user.id, schedule.timezone);
    const projects = await projectTotalsForPeriod(env, user.id, period);
    const sessions = await listSessionsForPeriod(env, period, user.id, schedule.timezone);
    return json({ ...report, projects, sessions });
  }

  // ---- Team (manager) API.
  if (url.pathname === "/api/me" && req.method === "GET") {
    const user = await sessionUser(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const approved = user.emailVerified && (await isApproved(env, user.id));
    if (user.emailVerified && !approved) await requestApproval(env, user);
    const orgs = approved ? await membershipsFor(env, user.id) : [];
    const manager = orgs.some((o) => isManagerRole(o.role));
    // Team workers (non-managers) may not self-edit times — managers adjust for them.
    const canEditTimes = orgs.length === 0 || manager;
    return json({
      user: { id: user.id, email: user.email, emailVerified: user.emailVerified, approved },
      orgs,
      manager,
      canEditTimes,
    });
  }

  if (url.pathname === "/api/team/members" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
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
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    const targetId = url.searchParams.get("userId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (!targetId || !(await isMemberOf(env, targetId, orgId))) {
      return json({ error: "user is not in your organization" }, 403);
    }
    const schedule = await getOrgSendSchedule(env, orgId);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    if (url.pathname === "/api/team/preview") {
      const csv = await buildReportCsv(env, period, targetId, schedule.timezone);
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    }
    const report = await buildHoursReport(env, period, targetId, schedule.timezone);
    const sessions = await listSessionsForPeriod(env, period, targetId, schedule.timezone);
    return json({ ...report, sessions });
  }

  if (url.pathname === "/api/team/working-hours") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return handleManagerWorkingHours(req, env, user.id);
  }
  if (url.pathname === "/api/working-hours" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return json(await effectiveWorkingHours(env, user.id));
  }

  if (url.pathname === "/api/team/settings") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (req.method === "GET") {
      const schedule = await getOrgSendSchedule(env, orgId);
      return json({
        recipients: parseRecipients(await getOrgMailTo(env, orgId)),
        sendDay: schedule.day,
        sendTime: schedule.time,
        sendTimezone: schedule.timezone,
        defaultRecipients: await managerEmailsForOrg(env, orgId),
      });
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        recipients?: unknown;
        sendDay?: unknown;
        sendTime?: unknown;
        sendTimezone?: unknown;
      };
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)
        : [];
      if (recipients.length === 0) return json({ error: "at least one recipient required" }, 400);
      if (recipients.length > 20) return json({ error: "too many recipients" }, 400);
      if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
      const schedule = parseSendSchedule(body);
      if (typeof schedule === "string") return json({ error: schedule }, 400);
      await setOrgMailTo(env, orgId, recipients.join("\n"));
      await setOrgSendSchedule(env, orgId, schedule);
      return json({
        ok: true,
        recipients,
        sendDay: schedule.day,
        sendTime: schedule.time,
        sendTimezone: schedule.timezone,
      });
    }
  }

  if (url.pathname === "/api/team/manual-session") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    const targetId = url.searchParams.get("userId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (!targetId || !(await isMemberOf(env, targetId, orgId))) {
      return json({ error: "user is not in your organization" }, 403);
    }
    const schedule = await getOrgSendSchedule(env, orgId);
    return handleManualSession(req, url, env, targetId, schedule.timezone);
  }

  // Create (or reuse) a team the caller manages. Teams are free.
  if (req.method === "POST" && url.pathname === "/api/team/create") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `team-create:${user.id}`, 10, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    try {
      const organizationId = await ensureTeamOrg(env, req, user, name || undefined);
      return json({ ok: true, organizationId });
    } catch (e) {
      console.error("team create error:", String((e as Error)?.message ?? e));
      return json({ error: "could not create team" }, 500);
    }
  }

  if (url.pathname === "/api/manual-session") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    // Team workers cannot add/delete their own manual entries (managers use /api/team/manual-session).
    if (req.method === "POST" || req.method === "DELETE") {
      if (!(await canSelfServiceEditTimes(env, user.id))) {
        return json(
          { error: "your team manager controls timesheet adjustments" },
          403,
        );
      }
      if (!(await rateLimitAllowDurable(env.DB, `manual-session:${user.id}`, 60, 60 * 60_000))) {
        return json({ error: "too many requests" }, 429);
      }
    }
    const schedule = await getEffectiveSendSchedule(env, user.id);
    return handleManualSession(req, url, env, user.id, schedule.timezone);
  }

  // Privacy: export this account's cloud data (sessions + activity aggregates).
  if (url.pathname === "/api/export" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `export:${user.id}`, 6, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return handleDataExport(env, user);
  }

  // Privacy: delete this account's clocked data + revoke tokens. Does not
  // remove better-auth user rows (session cookie
  // still works until sign-out) but product data is gone.
  if (url.pathname === "/api/account/delete" && req.method === "POST") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `account-delete:${user.id}`, 3, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
    if (body.confirm !== "DELETE") {
      return json({ error: 'send { "confirm": "DELETE" } to proceed' }, 400);
    }
    await deleteUserClockedData(env, user.id);
    return json({ ok: true });
  }

  if (url.pathname === "/api/settings") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (req.method === "GET") {
      const eff = await getEffectiveRecipients(env, user.id, user.email);
      const schedule = await getEffectiveSendSchedule(env, user.id);
      return json({
        recipients: eff.recipients,
        sendDay: schedule.day,
        sendTime: schedule.time,
        sendTimezone: schedule.timezone,
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
        sendTime?: unknown;
        sendTimezone?: unknown;
      };
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)
        : [];
      if (recipients.length === 0) return json({ error: "at least one recipient required" }, 400);
      if (recipients.length > 20) return json({ error: "too many recipients" }, 400);
      if (!recipients.every(isEmail)) return json({ error: "invalid email" }, 400);
      const schedule = parseSendSchedule(body);
      if (typeof schedule === "string") return json({ error: schedule }, 400);
      await setMailTo(env, user.id, recipients.join("\n"));
      await setSendSchedule(env, user.id, schedule);
      return json({
        ok: true,
        recipients,
        sendDay: schedule.day,
        sendTime: schedule.time,
        sendTimezone: schedule.timezone,
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/preview") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const schedule = await getEffectiveSendSchedule(env, user.id);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const csv = await buildReportCsv(env, period, user.id, schedule.timezone);
    return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
  }

  // Manual send — throttled (force email is expensive / abusable).
  if (req.method === "POST" && url.pathname === "/api/send") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `send:${user.id}`, 3, 60 * 60_000))) {
      return json({ error: "too many sends; try again later" }, 429);
    }
    const schedule = await getEffectiveSendSchedule(env, user.id);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const { recipients: to } = await getEffectiveRecipients(env, user.id, user.email);
    const result = await buildAndSendReport(env, period, {
      force: true,
      userId: user.id,
      to,
      timezone: schedule.timezone,
    });
    return json(
      result.ok
        ? { ok: true, period: result.period, rows: result.rows, recipients: to.length }
        : { error: result.error || "send failed" },
      result.ok ? 200 : 500,
    );
  }

  // ---- Desktop-app (Bearer-token) API.
  if (req.method === "GET" && url.pathname === "/desktop/working-hours") {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = await userIdForToken(env, bearer);
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (!(await isApproved(env, userId))) return json({ error: "account pending approval" }, 403);
    return new Response(JSON.stringify(await effectiveWorkingHours(env, userId)), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (req.method === "POST" && url.pathname === "/sessions") {
    if (!(await rateLimitAllowDurable(env.DB, `sessions:${ip}`, 60, 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = await userIdForToken(env, bearer);
    if (userId) {
      if (!(await rateLimitAllowDurable(env.DB, `sessions:user:${userId}`, 120, 60_000))) {
        return json({ error: "too many requests" }, 429);
      }
      if (!(await isApproved(env, userId))) return json({ error: "account pending approval" }, 403);
      return handleIngest(req, env, userId);
    }
    // Legacy global token: opt-in only (ALLOW_LEGACY_BEARER_TOKEN=true). Off by default.
    if (legacyBearerEnabled(env) && checkAuth(req, env)) {
      return handleIngest(req, env, null);
    }
    return json({ error: "unauthorized" }, 401);
  }

  // Daily app/project aggregates — per-account tokens only (no legacy unattributed path).
  if (req.method === "POST" && url.pathname === "/activity") {
    if (!(await rateLimitAllowDurable(env.DB, `activity:${ip}`, 60, 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = await userIdForToken(env, bearer);
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (!(await rateLimitAllowDurable(env.DB, `activity:user:${userId}`, 120, 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    if (!(await isApproved(env, userId))) return json({ error: "account pending approval" }, 403);
    return handleActivityIngest(req, env, userId);
  }

  return json({ error: "not found" }, 404);
}

function resolvePeriod(url: URL, timezone: string): string | null {
  const raw = url.searchParams.get("period");
  if (raw == null || raw === "") return previousMonthPeriod(new Date(), timezone);
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

/** Session user with a verified email and an approved account, or a 401/403 Response. */
async function requireActiveUser(
  req: Request,
  env: Env,
): Promise<SessionUser | Response> {
  const user = await sessionUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.emailVerified) return json({ error: "email not verified" }, 403);
  if (!(await isApproved(env, user.id))) return json({ error: "account pending approval" }, 403);
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
}

/** Orgs the user belongs to, with plan/cap for the dashboard. */
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

/**
 * List / add / remove sessions for a user.
 * GET returns all sessions in the period (app + manual) so wrong clockings can be removed.
 * POST still creates manual adjustments only.
 * DELETE removes any session id owned by the user (manual or desktop-synced).
 */
async function handleManualSession(
  req: Request,
  url: URL,
  env: Env,
  userId: string,
  timezone: string,
): Promise<Response> {
  if (req.method === "GET") {
    const period = resolvePeriod(url, timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const entries = await listSessionsForPeriod(env, period, userId, timezone);
    return json({ entries });
  }

  if (req.method === "DELETE") {
    const body = (await req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
      return json({ error: "id required" }, 400);
    }
    // Any owned closed session — managers use this to drop bad desktop clockings.
    const res = await env.DB.prepare(
      `DELETE FROM sessions WHERE id = ? AND user_id = ? AND end_utc IS NOT NULL`,
    )
      .bind(id, userId)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    // Tombstone so a later desktop re-sync of the same id cannot resurrect it.
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO session_deletions (id, user_id, deleted_at) VALUES (?, ?, ?)`,
      )
        .bind(id, userId, new Date().toISOString())
        .run();
    } catch {
      /* table may not exist until migration applied — delete still succeeded */
    }
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
    if (
      !isValidCalendarDate(y, m, d) ||
      sh > 23 ||
      smi > 59 ||
      eh > 23 ||
      emi > 59 ||
      sh < 0 ||
      smi < 0 ||
      eh < 0 ||
      emi < 0
    ) {
      return json({ error: "invalid date or time" }, 400);
    }
    if (eh * 60 + emi <= sh * 60 + smi) {
      return json({ error: "clock-out must be after clock-in" }, 400);
    }
    // Same-day only; cap is 24h by construction — still guard absurd ranges.
    if (eh * 60 + emi - (sh * 60 + smi) > 24 * 60) {
      return json({ error: "session too long" }, 400);
    }
    const dayTimezone = await timezoneForLocalDate(env, userId, date, timezone);
    const startUtc = wallToUtc(y, m, d, sh, smi, 0, dayTimezone);
    const endUtc = wallToUtc(y, m, d, eh, emi, 0, dayTimezone);
    if (!(endUtc.getTime() > startUtc.getTime())) {
      return json({ error: "clock-out must be after clock-in" }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, timezone, user_id)
       VALUES (?, ?, ?, 'manual', 'manual', ?, ?)`,
    )
      .bind(crypto.randomUUID(), startUtc.toISOString(), endUtc.toISOString(), dayTimezone, userId)
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

/** JSON dump of cloud sessions + activity for GDPR-style portability. */
async function handleDataExport(env: Env, user: SessionUser): Promise<Response> {
  const sessions = await env.DB.prepare(
    `SELECT id, start_utc, end_utc, start_reason, end_reason, timezone
       FROM sessions WHERE user_id = ? ORDER BY start_utc`,
  )
    .bind(user.id)
    .all();
  let activity: unknown[] = [];
  try {
    const act = await env.DB.prepare(
      `SELECT day, app, project, secs, updated_at FROM activity_day
        WHERE user_id = ? ORDER BY day, app, project`,
    )
      .bind(user.id)
      .all();
    activity = act.results ?? [];
  } catch {
    /* migration not applied */
  }
  const body = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    sessions: sessions.results ?? [],
    activity,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="clocked-export-${user.id.slice(0, 8)}.json"`,
    },
  });
}

/** Wipe product data for a user (sessions, activity, tokens, settings). */
async function deleteUserClockedData(env: Env, userId: string): Promise<void> {
  const steps = [
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM api_token WHERE userId = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user_settings WHERE userId = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM activity_day WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM session_deletions WHERE user_id = ?`).bind(userId),
  ];
  for (const s of steps) {
    try {
      await s.run();
    } catch (e) {
      console.error("deleteUserClockedData step failed:", String((e as Error)?.message ?? e));
    }
  }
}

function parseSendSchedule(body: {
  sendDay?: unknown;
  sendTime?: unknown;
  sendTimezone?: unknown;
}): SendSchedule | string {
  const day = body.sendDay === undefined ? 1 : Number(body.sendDay);
  if (!isValidSendDay(day)) return "invalid send day";

  const time =
    body.sendTime === undefined
      ? DEFAULT_SEND_TIME
      : typeof body.sendTime === "string"
        ? body.sendTime.trim()
        : body.sendTime;
  if (!isValidSendTime(time)) return "invalid send time";

  const timezone =
    body.sendTimezone === undefined
      ? DEFAULT_SEND_TIMEZONE
      : typeof body.sendTimezone === "string"
        ? body.sendTimezone.trim()
        : body.sendTimezone;
  if (!isValidTimeZone(timezone)) return "invalid timezone";

  return { day, time, timezone };
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
