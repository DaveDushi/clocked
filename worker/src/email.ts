import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";

import type { Env } from "./types";
import { buildReportTsv } from "./report";

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
 * exactly-once monthly delivery.
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

  const tsv = await buildReportTsv(env, period);
  const rows = tsv ? tsv.trimEnd().split("\n").length : 0;

  try {
    const mime = createMimeMessage();
    mime.setSender({ name: "clocked", addr: env.MAIL_FROM });
    mime.setRecipient(env.MAIL_TO);
    mime.setSubject(`Hours — ${period}`);
    mime.addMessage({
      contentType: "text/plain",
      data: rows > 0 ? tsv : "No sessions recorded for this month.",
    });
    if (rows > 0) {
      mime.addAttachment({
        filename: `clocked-${period}.tsv`,
        contentType: "text/tab-separated-values",
        data: btoa(unescape(encodeURIComponent(tsv))),
      });
    }

    const email = new EmailMessage(env.MAIL_FROM, env.MAIL_TO, mime.asRaw());
    await env.SEND_EMAIL.send(email);
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
