import type { Env } from "./types";
import { buildReportTsv } from "./report";
import { getMailTo } from "./settings";

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
 * Uses the Cloudflare Email Sending object API (`env.SEND_EMAIL.send({...})`),
 * which delivers to any recipient once the MAIL_FROM domain is onboarded via
 * `wrangler email sending enable <domain>`.
 */
export async function buildAndSendReport(
  env: Env,
  period: string,
  opts: { force: boolean; userId: string; to: string },
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

  const tsv = await buildReportTsv(env, period, userId);
  const rows = tsv ? tsv.trimEnd().split("\n").length : 0;

  try {
    await env.SEND_EMAIL.send({
      to,
      from: { email: env.MAIL_FROM, name: "clocked" },
      subject: `Hours — ${period}`,
      text: rows > 0 ? tsv : "No sessions recorded for this month.",
      attachments:
        rows > 0
          ? [
              {
                content: tsv, // Workers binding: raw string, not base64
                filename: `clocked-${period}.tsv`,
                type: "text/tab-separated-values",
                disposition: "attachment",
              },
            ]
          : undefined,
    });
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
 * Each user's recipient is their `mail_to` override or their account email.
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
    const to = (await getMailTo(env, u.id)) ?? u.email;
    if (!to) continue;
    await buildAndSendReport(env, period, { force: opts.force, userId: u.id, to });
  }
}
