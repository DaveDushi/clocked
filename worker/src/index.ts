import { getTeamSessionScope } from "./team-scope";
import { effectiveInactivity, handleManagerInactivity } from "./inactivity";
import { checkAuth } from "./auth";
import { makeAuth } from "./auth-server";
import { dashboardResponse } from "./dashboard";
import { privacyPageResponse, termsPageResponse } from "./legal-pages";
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
import { buildAndSendReport, buildTeamReport, sendScheduledReports } from "./email";
import { handleActivityIngest } from "./activity";
import { handleIngest } from "./ingest";
import { buildTimesheet } from "./report";
import { handleManagerTimePolicy } from "./time-policy.js";
import { breakStats } from "./break-stats";
import { handleManualSession } from "./manual-session";
import { buildTeamOverview, parseSelection, sendTeamTimesheets } from "./team-overview";
import { getEffectiveDelivery, getTeamDelivery, handleDeliverySettings } from "./delivery";
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
import { previousMonthPeriod } from "./time";
import { orgPlan, planCap, planLabel } from "./plans";
import { ensureTeamOrg } from "./teams";
import { handleAdminApprove, isApproved } from "./approval";
import { handleAcceptIndividualInvitation, handleCreateInvitation, handleRequestAccess, isOperator } from "./onboarding";
import { clientIp, rateLimitAllowDurable } from "./rate-limit";
import {
  isSameOriginRequest,
  parsePeriodParam,
  timingSafeEqual,
  withSecurityHeaders,
} from "./security";
import type { Env } from "./types";
import { effectiveWorkingHours, handleManagerWorkingHours } from "./working-hours";
import { getPrimaryMembership, normalizeMembershipDate, selectPrimaryMembership } from "./memberships";

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
    ctx.waitUntil(sendScheduledReports(env, now));
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
  if ((req.method === "GET" || req.method === "HEAD") &&
      (url.pathname === "/privacy" || url.pathname === "/terms")) {
    const response = url.pathname === "/privacy" ? privacyPageResponse() : termsPageResponse();
    return req.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  }
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

  // Public access requests notify the operator without creating an account.
  if (req.method === "POST" && url.pathname === "/api/request-access") {
    if (!(await rateLimitAllowDurable(env.DB, `request-access:${ip}`, 3, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return handleRequestAccess(req, env);
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
    const { schedule } = await getEffectiveDelivery(env, { userId: user.id, email: user.email });
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const { report, projects, sessions, recordedDays } = await buildTimesheet({
      env, period, userId: user.id, timezone: schedule.timezone, scope: { kind: "personal" },
    });
    return json({ ...report, projects, sessions, recordedDays, stats: breakStats(recordedDays) });
  }

  // ---- Team (manager) API.
  if (url.pathname === "/api/me" && req.method === "GET") {
    const user = await sessionUser(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const approved = user.emailVerified && (await isApproved(env, user.id));
    const orgs = approved ? await membershipsFor(env, user.id) : [];
    const primary = selectPrimaryMembership(orgs);
    const manager = primary !== null && isManagerRole(primary.role);
    // Team workers (non-managers) may not self-edit times — managers adjust for them.
    const canEditTimes = primary === null || manager;
    return json({
      user: { id: user.id, email: user.email, emailVerified: user.emailVerified, approved },
      operator: approved && isOperator(user),
      orgs,
      manager,
      canEditTimes,
    });
  }

  if (url.pathname === "/api/admin/invite" && req.method === "POST") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `operator-invite:${user.id}`, 20, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return handleCreateInvitation(req, env, user);
  }

  if (url.pathname === "/api/invitations/individual/accept" && req.method === "POST") {
    const user = await sessionUser(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!(await rateLimitAllowDurable(env.DB, `individual-invite-accept:${user.id}`, 30, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    return handleAcceptIndividualInvitation(req, env, user);
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
    const { schedule } = await getTeamDelivery(env, orgId);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const scope = await getTeamSessionScope(env, targetId, orgId);
    if (!scope) return json({ error: "user is not in your organization" }, 403);
    const { report, sessions, recordedDays, csv } = await buildTimesheet({
      env, period, userId: targetId, timezone: schedule.timezone, scope,
      organizationId: orgId,
      includeProjects: false,
    });
    if (url.pathname === "/api/team/preview") {
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    }
    return json({ ...report, sessions, recordedDays, stats: breakStats(recordedDays) });
  }

  // Every member's month at once: roster totals, break comparison and the day grid.
  if (url.pathname === "/api/team/overview" && req.method === "GET") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    const { schedule } = await getTeamDelivery(env, orgId);
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    return json(await buildTeamOverview(env, orgId, period, schedule.timezone));
  }

  // Send the reviewed selection of member timesheets to the team's recipients.
  if ((url.pathname === "/api/team/send" || url.pathname === "/api/team/preview-bundle") && req.method === "POST") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    const body: unknown = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object") return json({ error: "invalid selection" }, 400);
    const period = parsePeriodParam("period" in body && typeof body.period === "string" ? body.period : null);
    if (!period) return json({ error: "invalid period" }, 400);
    const userIds = parseSelection("userIds" in body ? body.userIds : null);
    if (!userIds) return json({ error: "select at least one member" }, 400);
    if (url.pathname === "/api/team/preview-bundle") {
      const { schedule } = await getTeamDelivery(env, orgId);
      const preview = await buildTeamReport(env, period, { force: true, organizationId: orgId,
        userIds, to: [], timezone: schedule.timezone });
      if (!preview.ok) return json({ error: preview.error }, 403);
      return json({ text: preview.message.text, files: preview.previewFiles });
    }
    if (!(await rateLimitAllowDurable(env.DB, `team-send:${orgId}`, 5, 60 * 60_000))) {
      return json({ error: "too many sends; try again later" }, 429);
    }
    const result = await sendTeamTimesheets(env, orgId, period, userIds);
    if (!result.ok) return json({ error: result.error }, result.status);
    const failed = result.results.filter((item) => !item.ok).length;
    return json({ ...result, ok: failed === 0, sent: result.results.length - failed, failed }, failed ? 502 : 200);
  }

  if (url.pathname === "/api/team/time-policy") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return handleManagerTimePolicy(req, env, user.id);
  }
  if (url.pathname === "/api/team/inactivity") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    return handleManagerInactivity(req, env, user.id);
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
    if (req.method === "GET" || req.method === "POST") {
      return handleDeliverySettings(req, env, { kind: "team", organizationId: orgId });
    }
  }

  if (url.pathname === "/api/team/manual-session") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const orgId = url.searchParams.get("organizationId") ?? "";
    const targetId = url.searchParams.get("userId") ?? "";
    if (!(await isManagerOf(env, user.id, orgId))) return json({ error: "forbidden" }, 403);
    if (user.id === targetId && req.method !== "GET" && !(await canSelfServiceEditTimes(env, user.id))) {
      return json({ error: "your team manager controls timesheet adjustments" }, 403);
    }
    const { schedule } = await getTeamDelivery(env, orgId);
    if (req.method !== "GET" &&
      !(await rateLimitAllowDurable(env.DB, `manual-session:${user.id}`, 120, 60 * 60_000))) {
      return json({ error: "too many requests" }, 429);
    }
    const scope = await getTeamSessionScope(env, targetId, orgId);
    if (!scope) return json({ error: "user is not in your organization" }, 403);
    return handleManualSession(req, url, env, targetId, user.id, schedule.timezone, scope);
  }

  // Create (or reuse) a team the caller manages. Teams are free.
  if (req.method === "POST" && url.pathname === "/api/team/create") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const primary = await getPrimaryMembership(env, user.id);
    if (!isOperator(user) && primary && !isManagerRole(primary.role)) {
      return json({ error: "Ask the operator for a team manager invitation." }, 403);
    }
    const ownsTeam = (await membershipsFor(env, user.id)).some((org) => org.role.split(",").includes("owner"));
    if (!isOperator(user) && !ownsTeam) return json({ error: "Ask the operator for a team manager invitation." }, 403);
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
    if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
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
    const { schedule } = await getEffectiveDelivery(env, { userId: user.id, email: user.email });
    return handleManualSession(req, url, env, user.id, user.id, schedule.timezone, { kind: "personal" });
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
    if (req.method === "GET" || req.method === "POST") {
      return handleDeliverySettings(req, env, { kind: "personal", userId: user.id, email: user.email });
    }
  }

  if (req.method === "GET" && url.pathname === "/preview") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    const { schedule } = await getEffectiveDelivery(env, { userId: user.id, email: user.email });
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
    const { csv } = await buildTimesheet({
      env, period, userId: user.id, timezone: schedule.timezone, scope: { kind: "personal" },
    });
    return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
  }

  // Manual send — throttled (force email is expensive / abusable).
  if (req.method === "POST" && url.pathname === "/api/send") {
    const user = await requireActiveUser(req, env);
    if (user instanceof Response) return user;
    if (!(await rateLimitAllowDurable(env.DB, `send:${user.id}`, 3, 60 * 60_000))) {
      return json({ error: "too many sends; try again later" }, 429);
    }
    const { schedule, recipients: to } = await getEffectiveDelivery(env, { userId: user.id, email: user.email });
    const period = resolvePeriod(url, schedule.timezone);
    if (!period) return json({ error: "invalid period" }, 400);
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
  if (req.method === "GET" && ["/desktop/working-hours", "/desktop/inactivity"].includes(url.pathname)) {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = await userIdForToken(env, bearer);
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (!(await isApproved(env, userId))) return json({ error: "account pending approval" }, 403);
    return new Response(JSON.stringify(url.pathname === "/desktop/inactivity"
      ? { policy: await effectiveInactivity(env, userId) } : await effectiveWorkingHours(env, userId)), {
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
  id: string;
  createdAt: string | number;
  organizationId: string;
  role: string;
  name: string;
  metadata: string | null;
  memberCount: number;
}

/** Orgs the user belongs to, with plan/cap for the dashboard. */
async function membershipsFor(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT m.id, m.createdAt, m.organizationId AS organizationId, m.role AS role, o.name AS name, o.metadata AS metadata,
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
      id: r.id,
      createdAt: normalizeMembershipDate(r.createdAt),
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
  const membership = await getPrimaryMembership(env, userId);
  return membership === null || isManagerRole(membership.role);
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

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
