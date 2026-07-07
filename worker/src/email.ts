import type { Env } from "./types";
import { buildReportCsv, buildHoursReport, formatHours, isWorkDay, type HoursReport } from "./report";
import { getRecipients } from "./settings";

/** UTF-8-safe base64 (btoa alone mangles non-ASCII in session labels). */
function toBase64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** "2026-06" -> "June 2026". */
function monthTitle(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Render a tidy HTML timesheet summary (plus a plain-text fallback) from the
 * structured hours report. Stat tiles up top, then one row per calendar day:
 * worked days show their hours, empty work days are flagged as vacation, and
 * weekends without hours are omitted. The full breakdown rides along as a CSV
 * attachment.
 */
function renderReportEmail(period: string, report: HoursReport): { html: string; text: string } {
  const title = monthTitle(period);
  const total = formatHours(report.totalMinutes);
  const worked = report.activeDays;
  const vacation = report.days.filter((d) => d.minutes === 0 && isWorkDay(d.date)).length;

  const tile = (value: string, label: string) => `
    <td style="padding:0 8px;">
      <div style="background:#f4f5f7;border-radius:10px;padding:14px 18px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#111827;line-height:1;">${value}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:6px;text-transform:uppercase;letter-spacing:.04em;">${label}</div>
      </div>
    </td>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f0f1f3;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <tr><td style="padding:26px 28px 18px;">
      <div style="font-size:13px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;">Timesheet</div>
      <div style="font-size:24px;font-weight:700;color:#111827;margin-top:2px;">${esc(title)}</div>
    </td></tr>
    <tr><td style="padding:0 20px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${tile(total, "Total hours")}
        ${tile(String(worked), worked === 1 ? "Day worked" : "Days worked")}
        ${tile(String(vacation), vacation === 1 ? "Vacation day" : "Vacation days")}
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 28px 26px;color:#9ca3af;font-size:12px;">
      The full day-by-day breakdown is attached as <strong>clocked-${esc(period)}.csv</strong>.
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Timesheet — ${title}`,
    ``,
    `Total hours: ${total}`,
    `Days worked: ${worked}`,
    `Vacation days: ${vacation}`,
    ``,
    `Full day-by-day breakdown attached as clocked-${period}.csv.`,
  ].join("\n");

  return { html, text };
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
  const report = await buildHoursReport(env, period, userId);
  const body =
    rows > 0
      ? renderReportEmail(period, report)
      : { html: undefined, text: "No sessions recorded for this month." };

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
        subject: `Hours — ${monthTitle(period)}`,
        html: body.html,
        text: body.text,
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
 * The cron fires daily, so each user is only sent on `dayOfMonth` matching their
 * configured send day (default 1; 0 disables auto-send). Recipients are the
 * user's `mail_to` override(s) or their account email.
 */
export async function sendMonthlyReports(
  env: Env,
  period: string,
  opts: { force: boolean; dayOfMonth: number },
): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, s.send_day AS send_day
       FROM user u LEFT JOIN user_settings s ON s.userId = u.id`,
  ).all<{ id: string; email: string; send_day: number | null }>();
  for (const u of users.results ?? []) {
    const sendDay = u.send_day ?? 1;
    if (sendDay === 0 || sendDay !== opts.dayOfMonth) continue;
    const to = await getRecipients(env, u.id, u.email);
    if (to.length === 0) continue;
    await buildAndSendReport(env, period, { force: opts.force, userId: u.id, to });
  }
}
