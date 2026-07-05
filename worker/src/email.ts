import type { Env } from "./types";
import { buildReportTsv } from "./report";
import { getSetting } from "./settings";

export interface SendResult {
  ok: boolean;
  period: string;
  rows: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Build and email the report for `period`. Unless `force` is set (manual test),
 * skips months already recorded in `sent_reports` and records success there for
 * exactly-once monthly delivery. Recipient is the dashboard `mail_to` setting,
 * falling back to the MAIL_TO var.
 *
 * Uses the Cloudflare Email Sending object API (`env.SEND_EMAIL.send({...})`),
 * which delivers to any recipient once the MAIL_FROM domain is onboarded via
 * `wrangler email sending enable <domain>`.
 */
export async function buildAndSendReport(
  env: Env,
  period: string,
  opts: { force: boolean },
): Promise<SendResult> {
  if (!opts.force) {
    const existing = await env.DB.prepare("SELECT period FROM sent_reports WHERE period = ?")
      .bind(period)
      .first();
    if (existing) return { ok: true, period, rows: 0, skipped: true };
  }

  const mailTo = (await getSetting(env, "mail_to")) ?? env.MAIL_TO;
  const tsv = await buildReportTsv(env, period);
  const rows = tsv ? tsv.trimEnd().split("\n").length : 0;

  try {
    await env.SEND_EMAIL.send({
      to: mailTo,
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
    await env.DB.prepare("INSERT OR IGNORE INTO sent_reports (period, sent_utc) VALUES (?, ?)")
      .bind(period, new Date().toISOString())
      .run();
  }

  return { ok: true, period, rows };
}
