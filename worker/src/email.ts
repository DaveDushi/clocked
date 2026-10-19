import type { Env } from "./types";
import { sendEmail } from "./email-provider.js";
import { buildTimesheet, formatHours, isWorkDay, type HoursReport } from "./report.js";
import { listDeliveries } from "./delivery.js";
import { isScheduleDue, periodForSchedule } from "./schedule.js";

/**
 * Referral footer on outgoing timesheets. These land in clients'/managers'
 * inboxes every month, so a small, tasteful "sent by clocked" line is the
 * product's best organic growth loop. UTM tags attribute the traffic.
 */
const MARKETING_URL =
  "https://clocked.daviddusi.com/?utm_source=timesheet_email&utm_medium=email&utm_campaign=footer";
const MARKETING_FOOTER_TEXT =
  "— Sent automatically by clocked, automatic time tracking for Windows. https://clocked.daviddusi.com";

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
function renderReportEmail(
  period: string,
  report: HoursReport,
  projects: { project: string; minutes: number }[],
): { html: string; text: string } {
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

  const projectRows = projects
    .slice(0, 12)
    .map(
      (p) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f1f3;color:#111827;">${esc(p.project)}</td>` +
        `<td style="padding:6px 0;border-bottom:1px solid #f0f1f3;text-align:right;color:#6b7280;">${formatHours(p.minutes)}</td></tr>`,
    )
    .join("");
  const projectBlock =
    projects.length > 0
      ? `<tr><td style="padding:8px 28px 4px;font-size:13px;font-weight:600;color:#111827;">By project</td></tr>
    <tr><td style="padding:0 28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${projectRows}</table>
    </td></tr>`
      : "";

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
    ${projectBlock}
    <tr><td style="padding:20px 28px 8px;color:#9ca3af;font-size:12px;">
      The full day-by-day breakdown is attached as <strong>clocked-${esc(period)}.csv</strong>.
    </td></tr>
    <tr><td style="padding:0 28px 22px;">
      <div style="border-top:1px solid #f0f1f3;padding-top:14px;font-size:11px;color:#b6bcc6;line-height:1.5;">
        Sent automatically by <a href="${MARKETING_URL}" style="color:#9ca3af;text-decoration:none;font-weight:600;">clocked</a> — automatic time tracking for Windows. No timers, no screenshots.
      </div>
    </td></tr>
  </table>
</body>
</html>`;

  const textProjects =
    projects.length > 0
      ? [
          ``,
          `By project:`,
          ...projects.slice(0, 12).map((p) => `  ${p.project}: ${formatHours(p.minutes)}`),
        ]
      : [];

  const text = [
    `Timesheet — ${title}`,
    ``,
    `Total hours: ${total}`,
    `Days worked: ${worked}`,
    `Vacation days: ${vacation}`,
    ...textProjects,
    ``,
    `Full day-by-day breakdown attached as clocked-${period}.csv.`,
    ``,
    MARKETING_FOOTER_TEXT,
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
 * and records successful submission there. Recipient is the
 * user's `mail_to` override, falling back to their account email.
 *
 * Sends through the configured email provider from the verified MAIL_FROM domain.
 */
export async function buildAndSendReport(
  env: Env,
  period: string,
  opts: { force: boolean; userId: string; to: string[]; timezone?: string },
): Promise<SendResult> {
  const { userId, to } = opts;
  const timezone = opts.timezone ?? env.REPORT_TZ;

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

  const { csv, report, projects } = await buildTimesheet({ env, period, userId, timezone });
  const rows = csv ? csv.trimEnd().split("\n").length : 0;
  const body =
    rows > 0
      ? renderReportEmail(period, report, projects)
      : {
          html: undefined,
          text: `No sessions recorded for this month.\n\n${MARKETING_FOOTER_TEXT}`,
        };

  const sent = await sendEmail(env, {
    to,
    subject: `Hours — ${monthTitle(period)}`,
    html: body.html,
    text: body.text,
    attachments: rows > 0 ? [{
      content: new TextEncoder().encode(csv),
      filename: `clocked-${period}.csv`,
      contentType: "text/csv; charset=utf-8",
    }] : undefined,
  });
  if (!sent.ok) return { ...sent, period, rows };

  if (!opts.force) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sent_reports (period, userId, sent_utc) VALUES (?, ?, ?)",
    )
      .bind(period, userId, new Date().toISOString())
      .run();
  }

  return { ok: true, period, rows };
}

/** Operator inbox: sales leads and new-signup approvals. */
export const ADMIN_INBOX = "ddusi@easytomanage.com";

/** Send auth/transactional mail through the configured provider. */
export async function sendAuthEmail(
  env: Env,
  opts: { to: string; subject: string; text: string; html: string },
): Promise<{ ok: boolean; error?: string }> {
  return sendEmail(env, { ...opts, to: [opts.to] });
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
 * verified MAIL_FROM domain with
 * the lead's own address as reply-to, so hitting reply reaches them directly.
 */
export async function sendContactSales(
  env: Env,
  lead: SalesLead,
): Promise<{ ok: boolean; error?: string }> {
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

  return sendEmail(env, {
    to: [ADMIN_INBOX],
    replyTo: lead.email,
    subject: `Enterprise enquiry — ${lead.name}`,
    html,
    text,
  });
}

/**
 * Monthly cron fan-out: email every account whose configured local delivery
 * minute is due. For a team member, the manager's org-level schedule wins; for
 * a solo user, their personal schedule is used.
 * Recipients are likewise the effective ones — the manager's team destination in
 * a team, or the user's own `mail_to`/account email when solo.
 */
export async function sendMonthlyReports(env: Env, now: Date): Promise<void> {
  const users = await listDeliveries(env);
  for (const u of users) {
    const { schedule, recipients } = u;
    if (!isScheduleDue(schedule, now)) continue;
    if (recipients.length === 0) continue;
    await buildAndSendReport(env, periodForSchedule(schedule, now), {
      force: false,
      userId: u.id,
      to: recipients,
      timezone: schedule.timezone,
    });
  }
}
