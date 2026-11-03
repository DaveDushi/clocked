interface Env {
  DB: D1Database;
  BEARER_TOKEN: string;
  RESEND_API_KEY: string;
  REPORT_TZ: string;
  MAIL_FROM: string;
  MAIL_TO: string;
}

interface SessionInput {
  id?: unknown;
  start_utc?: unknown;
  end_utc?: unknown;
  start_reason?: unknown;
  end_reason?: unknown;
}

interface SessionRow {
  id: string;
  start_utc: string;
  end_utc: string | null;
  start_reason: string | null;
  end_reason: string | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("Unhandled error", error);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendScheduledReport(controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return json({
      name: "Clocked self-hosted worker",
      status: "ok",
      endpoints: ["GET /health", "POST /sessions", "GET /preview", "POST /send"],
    });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return new Response("clocked-self-hosted ok\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (!authorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    return ingestSessions(request, env);
  }

  if (request.method === "GET" && url.pathname === "/preview") {
    const period = requestedPeriod(url, env.REPORT_TZ);
    if (!period) return json({ error: "period must use YYYY-MM" }, 400);
    const report = await buildReport(env, period);
    return new Response(report.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `inline; filename="clocked-${period}.csv"`,
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/send") {
    const period = requestedPeriod(url, env.REPORT_TZ);
    if (!period) return json({ error: "period must use YYYY-MM" }, 400);
    const result = await emailReport(env, period);
    return json(result, result.ok ? 200 : 502);
  }

  return json({ error: "not found" }, 404);
}

function authorized(request: Request, env: Env): boolean {
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!env.BEARER_TOKEN && constantTimeEqual(supplied, env.BEARER_TOKEN);
}

function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

async function ingestSessions(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { sessions?: unknown } | null;
  if (!body || !Array.isArray(body.sessions)) {
    return json({ error: "body must contain a sessions array" }, 400);
  }
  if (body.sessions.length > 500) {
    return json({ error: "maximum 500 sessions per request" }, 400);
  }

  const statements: D1PreparedStatement[] = [];
  for (const raw of body.sessions as SessionInput[]) {
    const session = validateSession(raw);
    if (!session.ok) return json({ error: session.error }, 400);

    statements.push(
      env.DB.prepare(
        `INSERT INTO sessions (id, start_utc, end_utc, start_reason, end_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           start_utc = excluded.start_utc,
           end_utc = excluded.end_utc,
           start_reason = excluded.start_reason,
           end_reason = excluded.end_reason,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(
        session.value.id,
        session.value.startUtc,
        session.value.endUtc,
        session.value.startReason,
        session.value.endReason,
      ),
    );
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return json({ ok: true, received: statements.length });
}

function validateSession(raw: SessionInput):
  | { ok: true; value: { id: string; startUtc: string; endUtc: string | null; startReason: string | null; endReason: string | null } }
  | { ok: false; error: string } {
  const id = cleanString(raw?.id, 200);
  const startUtc = cleanString(raw?.start_utc, 50);
  const endUtc = raw?.end_utc == null ? null : cleanString(raw.end_utc, 50);
  if (!id) return { ok: false, error: "each session requires an id" };
  if (!isIsoDate(startUtc)) return { ok: false, error: `invalid start_utc for session ${id}` };
  if (endUtc !== null && !isIsoDate(endUtc)) return { ok: false, error: `invalid end_utc for session ${id}` };
  if (endUtc && Date.parse(endUtc) < Date.parse(startUtc)) {
    return { ok: false, error: `end_utc precedes start_utc for session ${id}` };
  }
  return {
    ok: true,
    value: {
      id,
      startUtc,
      endUtc,
      startReason: nullableString(raw.start_reason, 100),
      endReason: nullableString(raw.end_reason, 100),
    },
  };
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullableString(value: unknown, max: number): string | null {
  const result = cleanString(value, max);
  return result || null;
}

function isIsoDate(value: string): boolean {
  return !!value && Number.isFinite(Date.parse(value));
}

async function buildReport(env: Env, period: string): Promise<{ csv: string; rows: number; totalHours: number }> {
  const { start, end } = periodBoundsUtc(period, env.REPORT_TZ);
  const result = await env.DB.prepare(
    `SELECT id, start_utc, end_utc, start_reason, end_reason
       FROM sessions
      WHERE start_utc < ? AND COALESCE(end_utc, start_utc) >= ?
      ORDER BY start_utc`,
  )
    .bind(end.toISOString(), start.toISOString())
    .all<SessionRow>();

  const lines = ["date,start,end,hours,start_reason,end_reason"];
  let totalMs = 0;
  let rows = 0;

  for (const session of result.results ?? []) {
    if (!session.end_utc) continue;
    const sessionStart = new Date(session.start_utc);
    const sessionEnd = new Date(session.end_utc);
    const clippedStart = new Date(Math.max(sessionStart.getTime(), start.getTime()));
    const clippedEnd = new Date(Math.min(sessionEnd.getTime(), end.getTime()));
    if (clippedEnd <= clippedStart) continue;

    const durationMs = clippedEnd.getTime() - clippedStart.getTime();
    totalMs += durationMs;
    rows++;
    lines.push(
      [
        localDate(clippedStart, env.REPORT_TZ),
        localTime(clippedStart, env.REPORT_TZ),
        localTime(clippedEnd, env.REPORT_TZ),
        (durationMs / 3_600_000).toFixed(2),
        session.start_reason ?? "",
        session.end_reason ?? "",
      ].map(csvCell).join(","),
    );
  }

  const totalHours = totalMs / 3_600_000;
  lines.push("");
  lines.push(`Total hours,,,${totalHours.toFixed(2)},,`);
  return { csv: lines.join("\n"), rows, totalHours };
}

async function emailReport(env: Env, period: string): Promise<{ ok: boolean; period: string; rows?: number; totalHours?: number; error?: string }> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) {
    return { ok: false, period, error: "RESEND_API_KEY, MAIL_FROM, and MAIL_TO are required" };
  }

  const report = await buildReport(env, period);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: env.MAIL_TO.split(",").map((value) => value.trim()).filter(Boolean),
      subject: `Clocked timesheet - ${period}`,
      text: `Clocked report for ${period}\n\nSessions: ${report.rows}\nTotal hours: ${report.totalHours.toFixed(2)}\n\nThe CSV report is attached.`,
      attachments: [
        {
          filename: `clocked-${period}.csv`,
          content: base64Encode(report.csv),
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Resend error", response.status, detail);
    return { ok: false, period, error: `email provider returned ${response.status}` };
  }

  return { ok: true, period, rows: report.rows, totalHours: report.totalHours };
}

async function sendScheduledReport(timestamp: number, env: Env): Promise<void> {
  const now = new Date(timestamp);
  const parts = dateParts(now, env.REPORT_TZ);
  if (parts.day !== 1) return;

  const period = previousPeriod(now, env.REPORT_TZ);
  const existing = await env.DB.prepare("SELECT period FROM sent_reports WHERE period = ?").bind(period).first();
  if (existing) return;

  const result = await emailReport(env, period);
  if (!result.ok) throw new Error(result.error ?? "scheduled email failed");
  await env.DB.prepare("INSERT INTO sent_reports (period) VALUES (?)").bind(period).run();
}

function requestedPeriod(url: URL, timezone: string): string | null {
  const value = url.searchParams.get("period");
  if (!value) return previousPeriod(new Date(), timezone);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

function previousPeriod(date: Date, timezone: string): string {
  const parts = dateParts(date, timezone);
  const month = parts.month === 1 ? 12 : parts.month - 1;
  const year = parts.month === 1 ? parts.year - 1 : parts.year;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodBoundsUtc(period: string, timezone: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: zonedMidnightUtc(year, month, 1, timezone),
    end: zonedMidnightUtc(nextYear, nextMonth, 1, timezone),
  };
}

function zonedMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = dateTimeParts(new Date(guess), timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const target = Date.UTC(year, month - 1, day, 0, 0, 0);
    guess += target - represented;
  }
  return new Date(guess);
}

function dateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = dateTimeParts(date, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function dateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
  };
}

function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
