import { createAuthEndpoint } from "@better-auth/core/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

import { rateLimitAllowDurable } from "./rate-limit";
import { userIdForToken } from "./tokens";
import type { Env } from "./types";

// --- Desktop "Open timesheet" auto-login -----------------------------------
// The tray app only holds a per-account `clk_` Bearer sync token, but the
// dashboard is gated by better-auth session cookies. This plugin bridges the
// two without ever putting the long-lived token in a browser URL:
//
//   1. POST /api/auth/desktop/link   (Authorization: Bearer clk_…)
//        -> mints a single-use, short-lived code and returns its open URL
//   2. GET  /api/auth/desktop/open?code=…
//        -> validates the code, creates a *short-lived* session, sets cookie, redirects
//
// Threat model: the sync token is equivalent to account login via this bridge.
// Mitigations: single-use codes, short code TTL, short desktop sessions, D1 rate
// limits, hashed tokens at rest, regenerate-to-revoke. Keep the token secret.
//
// The code is stored in better-auth's own `verification` table via
// createVerificationValue / consumeVerificationValue (atomic, single-use, with
// expiry) — so no extra table or migration is needed.

const CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes — the app opens it immediately
/** Desktop-minted browser sessions expire sooner than normal cookie sessions. */
const DESKTOP_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const CODE_PREFIX = "desktop-login:"; // verification identifier namespace

function generateLoginCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24)); // 192-bit
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function desktopAuth(env: Env) {
  return {
    id: "desktop-auth",
    endpoints: {
      // Exchange the desktop Bearer token for a one-time browser-login URL.
      desktopLink: createAuthEndpoint(
        "/desktop/link",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          const bearer = (ctx.headers?.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
          const userId = await userIdForToken(env, bearer);
          if (!userId) throw ctx.error("UNAUTHORIZED");

          // Durable limits: stolen tokens should not mint unlimited login codes.
          if (!(await rateLimitAllowDurable(env.DB, `desktop-link:user:${userId}`, 10, 60 * 60_000))) {
            throw ctx.error("TOO_MANY_REQUESTS");
          }
          const ip =
            ctx.headers?.get("cf-connecting-ip") ||
            ctx.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            "unknown";
          if (!(await rateLimitAllowDurable(env.DB, `desktop-link:ip:${ip}`, 30, 60 * 60_000))) {
            throw ctx.error("TOO_MANY_REQUESTS");
          }

          const code = generateLoginCode();
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: CODE_PREFIX + code,
            value: userId,
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          });

          // Build the absolute open URL under this auth instance's base path,
          // mirroring how the magic-link plugin builds its verify URL.
          const base = new URL(ctx.context.baseURL);
          const pathname = base.pathname === "/" ? "" : base.pathname;
          const basePath = pathname ? "" : ctx.context.options.basePath || "";
          const url = new URL(`${pathname}${basePath}/desktop/open`, base.origin);
          url.searchParams.set("code", code);
          return ctx.json({ url: url.toString() });
        },
      ),

      // Consume a one-time code and start a short-lived browser session.
      desktopOpen: createAuthEndpoint(
        "/desktop/open",
        { method: "GET", query: z.object({ code: z.string() }) },
        async (ctx) => {
          const home = new URL("/", ctx.context.baseURL).toString();
          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
            CODE_PREFIX + ctx.query.code,
          );
          if (!consumed) throw ctx.redirect(home);

          const user = await ctx.context.internalAdapter.findUserById(consumed.value);
          if (!user) throw ctx.redirect(home);

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw ctx.redirect(home);

          // Clamp lifetime: token-for-session bridge is high risk if token leaks.
          const shortExpiry = new Date(Date.now() + DESKTOP_SESSION_TTL_MS);
          const currentExpiry = new Date(session.expiresAt);
          if (currentExpiry > shortExpiry) {
            try {
              await env.DB.prepare(`UPDATE session SET expiresAt = ? WHERE id = ?`)
                .bind(shortExpiry.toISOString(), session.id)
                .run();
              (session as { expiresAt: Date }).expiresAt = shortExpiry;
            } catch (e) {
              console.error("desktop session clamp failed:", String((e as Error)?.message ?? e));
            }
          }

          await setSessionCookie(ctx, { session, user });
          throw ctx.redirect(home);
        },
      ),
    },
    // better-auth in-memory limiter (pairs with D1 limits above).
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/desktop/"),
        window: 60,
        max: 10,
      },
    ],
  };
}
