import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

import { desktopAuth } from "./desktop-auth";
import { sendAuthEmail } from "./email";
import { effectiveMemberCap } from "./plans";
import type { Env } from "./types";

// --- Workers-native password hashing (PBKDF2 via Web Crypto) --------------
// better-auth's default is pure-JS scrypt (@noble/hashes), which can exceed the
// Worker CPU limit even on a single sign-up (better-auth issue #8860). Web Crypto
// PBKDF2 is hardware-accelerated and off the pure-JS CPU path — no nodejs_compat,
// no extra deps. Stored format is self-describing: `pbkdf2$<iter>$<saltB64>$<hashB64>`.
const PBKDF2_ITER = 100_000; // Cloudflare crypto.subtle caps PBKDF2 near 100k
const KEY_LEN = 32; // 256-bit derived key
const enc = new TextEncoder();

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveBits(password: string, salt: Uint8Array, iter: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    key,
    KEY_LEN * 8,
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt.buffer)}$${b64(bits)}`;
}

async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = hash.split("$");
  if (scheme !== "pbkdf2") return false;
  const bits = await deriveBits(password, unb64(saltB64), Number(iterStr));
  const a = new Uint8Array(bits);
  const b = unb64(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Force plan metadata to the unpaid floor — Stripe webhooks elevate later. */
function unpaidOrgMetadata(
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const rest = { ...(incoming || {}) };
  // Never trust client-supplied plan (incl. enterprise / teamplus).
  delete rest.plan;
  return { ...rest, plan: "single" };
}

// --- better-auth instance --------------------------------------------------
// Bindings only exist inside `fetch`, so build a fresh instance per request.
// Public sign-up is enabled: each new account gets its own per-account API token
// (see tokens.ts) that the desktop app uses to sync.
export function makeAuth(env: Env, allowSignUp = true) {
  return betterAuth({
    database: env.DB, // native D1 (better-auth >= 1.5), no adapter
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Origins allowed to POST to auth endpoints (CSRF/origin check). Include every
    // host the app is legitimately served from: the configured URL, the production
    // domain on either protocol, and local dev on localhost/127.0.0.1. All are the
    // app's own origins, so this doesn't widen the trust surface.
    trustedOrigins: [
      env.BETTER_AUTH_URL,
      "https://clocked.daviddusi.com",
      "http://clocked.daviddusi.com",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ].filter(Boolean),
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24, // 24h
      async sendVerificationEmail({ user, url }) {
        await sendAuthEmail(env, {
          to: user.email,
          subject: "Verify your clocked email",
          text: `Verify your clocked account:\n\n${url}\n\nThis link expires in 24 hours.`,
          html: authEmailHtml(
            "Verify your email",
            "Confirm this address to activate desktop sync and timesheet delivery.",
            url,
            "Verify email",
          ),
        });
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      // Soft: allow session creation so the dashboard can prompt verify.
      // All data APIs require verified email (see requireVerifiedUser).
      requireEmailVerification: false,
      minPasswordLength: 12,
      password: { hash: hashPassword, verify: verifyPassword },
      async sendResetPassword({ user, url }) {
        await sendAuthEmail(env, {
          to: user.email,
          subject: "Reset your clocked password",
          text: `Reset your clocked password:\n\n${url}\n\nIf you did not request this, ignore this email.`,
          html: authEmailHtml(
            "Reset your password",
            "Choose a new password for your clocked account.",
            url,
            "Reset password",
          ),
        });
      },
    },
    // Google sign-in — only registered when creds are configured, so local dev
    // without them still boots. Uses non-sensitive scopes (openid/email/profile),
    // so no Google verification review is needed to publish.
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : undefined,
    plugins: [
      desktopAuth(env),
      organization({
        creatorRole: "owner",
        teams: { enabled: true },
        // Paid seat cap only. Unpaid orgs are hard-capped at 1 (owner).
        membershipLimit: async (_user, org) => {
          const id = (org as { id?: string } | null)?.id;
          if (!id) return 1;
          return effectiveMemberCap(env, id);
        },
        organizationHooks: {
          // Strip any client-supplied plan; only Stripe may elevate seats.
          async beforeCreateOrganization({ organization: org }) {
            return {
              data: {
                ...org,
                metadata: unpaidOrgMetadata(
                  org.metadata as Record<string, unknown> | undefined,
                ),
              },
            };
          },
          async beforeUpdateOrganization({ organization: patch }) {
            // Clients may not change plan via metadata — re-read and re-apply
            // the server plan whenever metadata is part of the update.
            if (patch.metadata === undefined) return;
            let incoming: Record<string, unknown> = {};
            try {
              incoming =
                typeof patch.metadata === "string"
                  ? (JSON.parse(patch.metadata) as Record<string, unknown>)
                  : { ...(patch.metadata as Record<string, unknown>) };
            } catch {
              incoming = {};
            }
            delete incoming.plan;
            // Best effort: keep whatever plan is already stored for this org id
            // if the client included one (adapter update is by organizationId).
            const orgId = (patch as { id?: string }).id;
            let existingPlan = "single";
            if (orgId) {
              const row = await env.DB.prepare("SELECT metadata FROM organization WHERE id = ?")
                .bind(orgId)
                .first<{ metadata: string | null }>();
              try {
                const cur = row?.metadata ? JSON.parse(row.metadata) : null;
                if (cur && typeof cur.plan === "string") existingPlan = cur.plan;
              } catch {
                /* keep single */
              }
            }
            incoming.plan = existingPlan;
            return { data: { metadata: incoming } };
          },
        },
        async sendInvitationEmail(data) {
          const base = env.BETTER_AUTH_URL.replace(/\/$/, "");
          const url = `${base}/?invitation=${encodeURIComponent(data.id)}`;
          const orgName = data.organization?.name || "a team";
          const inviterName = data.inviter?.user?.name || data.inviter?.user?.email || "A teammate";
          await sendAuthEmail(env, {
            to: data.email,
            subject: `You're invited to ${orgName} on clocked`,
            text: `${inviterName} invited you to join ${orgName} on clocked.\n\nAccept: ${url}\n`,
            html: authEmailHtml(
              `Join ${orgName}`,
              `${inviterName} invited you to track time with their team on clocked.`,
              url,
              "Accept invitation",
            ),
          });
        },
      }),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30d — rarely re-run the CPU-heavy login
      updateAge: 60 * 60 * 24 * 7, // slide expiry at most weekly -> ~0 refresh writes
      cookieCache: { enabled: true, maxAge: 5 * 60 }, // serve getSession from cookie -> skip D1
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100, // in-memory per-isolate limiter; fine at this scale
      customRules: {
        "/sign-in/email": { window: 10, max: 3 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
      },
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;

function authEmailHtml(title: string, body: string, url: string, cta: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html><body style="margin:0;background:#f0f1f3;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">
    <tr><td style="padding:28px">
      <div style="font-size:22px;font-weight:700;color:#111827">${esc(title)}</div>
      <p style="font-size:14px;color:#4b5563;line-height:1.6">${esc(body)}</p>
      <p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:#f2a950;color:#221503;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${esc(cta)}</a></p>
      <p style="font-size:12px;color:#9ca3af;word-break:break-all">${esc(url)}</p>
    </td></tr>
  </table></body></html>`;
}
