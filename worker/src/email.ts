import type { Env } from "./types";
import { buildReportCsv, buildHoursReport, formatHours, isWorkDay, type HoursReport } from "./report";
import { getEffectiveRecipients, getEffectiveSendDay } from "./settings";

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

  if (!env.RESEND_API_KEY) {
    console.error("buildAndSendReport: RESEND_API_KEY not configured");
    return { ok: false, period, rows: 0, error: "email not configured" };
  }
  if (!to.length) {
    return { ok: false, period, rows: 0, error: "no recipients" };
  }

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
      const detail = await res.text();
      console.error(`buildAndSendReport resend ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, period, rows, error: "email send failed" };
    }
  } catch (e) {
    console.error("buildAndSendReport error:", String((e as Error)?.message ?? e));
    return { ok: false, period, rows, error: "email send failed" };
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

/** Fixed recipient for Enterprise "Contact sales" leads. */
const SALES_INBOX = "ddusi@easytomanage.com";

/** Low-level Resend send for auth/transactional mail (verify, reset, invites). */
export async function sendAuthEmail(
  env: Env,
  opts: { to: string; subject: string; text: string; html: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) {
    console.error("sendAuthEmail: RESEND_API_KEY not configured");
    return { ok: false, error: "email not configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: `clocked <${env.MAIL_FROM}>`,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`sendAuthEmail resend ${res.status}: ${body.slice(0, 200)}`);
      return { ok: false, error: "email send failed" };
    }
  } catch (e) {
    console.error("sendAuthEmail error:", String((e as Error)?.message ?? e));
    return { ok: false, error: "email send failed" };
  }
  return { ok: true };
}

export interface SalesLead {
  name: string;
  email: string;
  company?: string;
  teamSize?: string;
  message?: string;
}

/**
 * Email an Enterprise "Contact sales" lead to the sales inbox. Sends from the
 * verified MAIL_FROM domain (Resend requires the from-address be verified) with
 * the lead's own address as reply-to, so hitting reply reaches them directly.
 */
export async function sendContactSales(
  env: Env,
  lead: SalesLead,
): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) {
    console.error("sendContactSales: RESEND_API_KEY not configured");
    return { ok: false, error: "email not configured" };
  }

  const fields: [string, string][] = [
    ["Name", lead.name],
    ["Email", lead.email],
    ["Company", lead.company || "—"],
    ["Team size", lead.teamSize || "—"],
  ];

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f0f1f3;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <tr><td style="padding:26px 28px 8px;">
      <div style="font-size:13px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;">New enterprise lead</div>
      <div style="font-size:22px;font-weight:700;color:#111827;margin-top:2px;">${esc(lead.name)}</div>
    </td></tr>
    <tr><td style="padding:8px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#111827;">
        ${fields
          .map(
            ([k, v]) =>
              `<tr><td style="padding:6px 0;color:#6b7280;width:120px;">${esc(k)}</td><td style="padding:6px 0;">${esc(v)}</td></tr>`,
          )
          .join("")}
      </table>
    </td></tr>
    <tr><td style="padding:16px 28px 26px;">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Message</div>
      <div style="font-size:14px;color:#111827;line-height:1.6;white-space:pre-wrap;">${esc(lead.message || "—")}</div>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `New enterprise lead`,
    ``,
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company || "—"}`,
    `Team size: ${lead.teamSize || "—"}`,
    ``,
    `Message:`,
    lead.message || "—",
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: `clocked <${env.MAIL_FROM}>`,
        to: [SALES_INBOX],
        reply_to: lead.email,
        subject: `Enterprise enquiry — ${lead.name}`,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error(`sendContactSales resend ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, error: "email send failed" };
    }
  } catch (e) {
    console.error("sendContactSales error:", String((e as Error)?.message ?? e));
    return { ok: false, error: "email send failed" };
  }
  return { ok: true };
}

/** Sentinel `send_day` meaning "the last day of the month". */
export const SEND_DAY_LAST = 99;

/**
 * Monthly cron fan-out: email every account its own report for `period`.
 * The cron fires daily, so each user is only sent when `dayOfMonth` matches
 * their *effective* send day: for a team member that's the manager's org-level
 * schedule; for a solo user their own (default 1, 0 disables, 99 = last day).
 * Recipients are likewise the effective ones — the manager's team destination in
 * a team, or the user's own `mail_to`/account email when solo.
 */
export async function sendMonthlyReports(
  env: Env,
  period: string,
  opts: { force: boolean; dayOfMonth: number; lastDayOfMonth: number },
): Promise<void> {
  const users = await env.DB.prepare(`SELECT id, email FROM user`).all<{
    id: string;
    email: string;
  }>();
  for (const u of users.results ?? []) {
    const sendDay = await getEffectiveSendDay(env, u.id);
    if (sendDay === 0) continue;
    const target = sendDay === SEND_DAY_LAST ? opts.lastDayOfMonth : sendDay;
    if (target !== opts.dayOfMonth) continue;
    const { recipients } = await getEffectiveRecipients(env, u.id, u.email);
    if (recipients.length === 0) continue;
    await buildAndSendReport(env, period, { force: opts.force, userId: u.id, to: recipients });
  }
}
