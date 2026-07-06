import type { Env } from "./types";
import { buildReportCsv } from "./report";
import { getRecipients } from "./settings";

/** UTF-8-safe base64 (btoa alone mangles non-ASCII in session labels). */
function toBase64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export interface SendResult {
  ok: boolean;
  period: string;
  rows: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Build and email one account's report for `period`. Unless `force` is set
 * (manual test), skips (period, user) pairs already recorded in `sent_reports`
 * and records success there for exactly-once monthly delivery. Recipient is the
 * user's `mail_to` override, falling back to their account email.
 *
 * Sends via the Resend REST API (`POST https://api.resend.com/emails`) from the
 * verified MAIL_FROM domain; `to` may hold several recipients (one email each).
 */
export async function buildAndSendReport(
  env: Env,
  period: string,
  opts: { force: boolean; userId: string; to: string[] },
): Promise<SendResult> {
  const { userId, to } = opts;

  if (!opts.force) {
    const existing = await env.DB.prepare(
      "SELECT period FROM sent_reports WHERE period = ? AND userId = ?",
    )
      .bind(period, userId)
      .first();
    if (existing) return { ok: true, period, rows: 0, skipped: true };
  }

  const csv = await buildReportCsv(env, period, userId);
  const rows = csv ? csv.trimEnd().split("\n").length : 0;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: `clocked <${env.MAIL_FROM}>`,
        to,
        subject: `Hours — ${period}`,
        text: rows > 0 ? csv : "No sessions recorded for this month.",
        attachments:
          rows > 0
            ? [
                {
                  content: toBase64(csv), // Resend requires base64
                  filename: `clocked-${period}.csv`,
                },
              ]
            : undefined,
      }),
    });
    if (!res.ok) {
      return { ok: false, period, rows, error: `resend ${res.status}: ${await res.text()}` };
    }
  } catch (e) {
    return { ok: false, period, rows, error: String((e as Error)?.message ?? e) };
  }

  if (!opts.force) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sent_reports (period, userId, sent_utc) VALUES (?, ?, ?)",
    )
      .bind(period, userId, new Date().toISOString())
      .run();
  }

  return { ok: true, period, rows };
}

/**
 * Monthly cron fan-out: email every account its own report for `period`.
 * Each user's recipients are their `mail_to` override(s) or their account email.
 */
export async function sendMonthlyReports(
  env: Env,
  period: string,
  opts: { force: boolean },
): Promise<void> {
  const users = await env.DB.prepare("SELECT id, email FROM user").all<{
    id: string;
    email: string;
  }>();
  for (const u of users.results ?? []) {
    const to = await getRecipients(env, u.id, u.email);
    if (to.length === 0) continue;
    await buildAndSendReport(env, period, { force: opts.force, userId: u.id, to });
  }
}
