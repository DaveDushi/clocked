// D1Database, SendEmail, and the Workers runtime types are ambient globals
// provided by @cloudflare/workers-types (see tsconfig "types").
export interface Env {
  DB: D1Database;
  SEND_EMAIL: SendEmail;
  /** Shared secret matching the desktop app's config (wrangler secret). */
  BEARER_TOKEN: string;
  /** IANA timezone used for day names, day boundaries, and the cron gate. */
  REPORT_TZ: string;
  /** Default timesheet recipient; overridden by the `mail_to` setting if set. */
  MAIL_TO: string;
  MAIL_FROM: string;
  /** better-auth signing secret (wrangler secret). */
  BETTER_AUTH_SECRET: string;
  /** Public base URL of this worker, e.g. https://clocked-worker.<sub>.workers.dev */
  BETTER_AUTH_URL: string;
}

export interface SessionIn {
  id: string;
  start_utc: string;
  end_utc: string;
  start_reason?: string | null;
  end_reason?: string | null;
}
