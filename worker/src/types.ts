// D1Database and the Workers runtime types are ambient globals
// provided by @cloudflare/workers-types (see tsconfig "types").
export interface Env {
  DB: D1Database;
  /** Resend API key for sending timesheet emails (wrangler secret). */
  RESEND_API_KEY: string;
  /**
   * Legacy global Bearer for unattributed ingest (wrangler secret).
   * Only honored when ALLOW_LEGACY_BEARER_TOKEN is "true"/"1". Prefer per-account clk_ tokens.
   */
  BEARER_TOKEN?: string;
  /** Opt-in: allow BEARER_TOKEN to authenticate POST /sessions (default off). */
  ALLOW_LEGACY_BEARER_TOKEN?: string;
  /** IANA timezone used for day names, day boundaries, and the cron gate. */
  REPORT_TZ: string;
  /** Default timesheet recipient; overridden by the `mail_to` setting if set. */
  MAIL_TO: string;
  MAIL_FROM: string;
  /** better-auth signing secret (wrangler secret). */
  BETTER_AUTH_SECRET: string;
  /** Public base URL of this worker, e.g. https://clocked-worker.<sub>.workers.dev */
  BETTER_AUTH_URL: string;
  /** Google OAuth client credentials (wrangler secrets). Optional — Google
   * sign-in is only enabled when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Stripe secret key (wrangler secret / .dev.vars). */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret for /api/stripe/webhook (wrangler secret). */
  STRIPE_WEBHOOK_SECRET: string;
  /** Recurring Price ids for the self-serve plans (non-secret vars). */
  STRIPE_PRICE_SINGLE: string;
  STRIPE_PRICE_TEAM: string;
  STRIPE_PRICE_TEAMPLUS: string;
}

export interface SessionIn {
  id: string;
  start_utc: string;
  end_utc: string;
  start_reason?: string | null;
  end_reason?: string | null;
}
