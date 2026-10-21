import type { Env } from "./types";
import { orgIdForUser } from "./settings.js";
import { PRIMARY_MEMBERSHIP_ORDER_SQL } from "./memberships.js";
import {
  DEFAULT_SEND_TIME,
  DEFAULT_SEND_TIMEZONE,
  isValidSendDay,
  isValidSendTime,
  isValidTimeZone,
  type SendSchedule,
} from "./schedule.js";

type DeliveryTarget =
  | { kind: "personal"; userId: string; email: string }
  | { kind: "team"; organizationId: string };

interface StoredDelivery {
  mail_to: string | null;
  send_day: number | null;
  send_time: string | null;
  send_timezone: string | null;
}

interface Delivery {
  recipients: string[];
  schedule: SendSchedule;
}

interface EffectiveDelivery extends Delivery {
  managed: boolean;
}

interface AccountDelivery extends EffectiveDelivery {
  id: string;
  email: string;
}

function normalizeSchedule(row: StoredDelivery | null): SendSchedule {
  return {
    day: isValidSendDay(row?.send_day) ? row.send_day : 1,
    time: isValidSendTime(row?.send_time) ? row.send_time : DEFAULT_SEND_TIME,
    timezone: isValidTimeZone(row?.send_timezone) ? row.send_timezone : DEFAULT_SEND_TIMEZONE,
  };
}

function parseRecipients(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
}

/** Primary membership selects both recipients and schedule, including for cron. */
async function readDeliveries(
  env: Env,
  user: { userId: string; email: string } | null,
): Promise<AccountDelivery[]> {
  const result = await env.DB.prepare(
    `WITH first_membership AS (
       SELECT m.userId, m.organizationId,
              ROW_NUMBER() OVER (PARTITION BY m.userId ORDER BY ${PRIMARY_MEMBERSHIP_ORDER_SQL}) AS position
         FROM member m JOIN organization o ON o.id = m.organizationId
         ${user ? "WHERE m.userId = ?" : ""}
     )
     SELECT u.id, COALESCE(?, u.email) AS email, fm.organizationId,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.mail_to ELSE us.mail_to END AS mail_to,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_day ELSE us.send_day END AS send_day,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_time ELSE us.send_time END AS send_time,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_timezone ELSE us.send_timezone END AS send_timezone,
            manager_user.email AS manager_email
       FROM user u
       LEFT JOIN first_membership fm ON fm.userId = u.id AND fm.position = 1
       LEFT JOIN user_settings us ON us.userId = u.id
       LEFT JOIN org_settings os ON os.organizationId = fm.organizationId
       LEFT JOIN member manager ON manager.organizationId = fm.organizationId
         AND (manager.role LIKE '%owner%' OR manager.role LIKE '%admin%')
       LEFT JOIN user manager_user ON manager_user.id = manager.userId
       ${user ? "WHERE u.id = ?" : ""}
       ORDER BY manager.createdAt`,
  ).bind(...(user ? [user.userId, user.email, user.userId] : [null])).all<StoredDelivery & {
    id: string;
    email: string;
    organizationId: string | null;
    manager_email: string | null;
  }>();

  const accounts = new Map<string, { delivery: AccountDelivery; managers: Set<string> }>();
  for (const row of result.results ?? []) {
    let account = accounts.get(row.id);
    if (!account) {
      account = {
        delivery: {
          id: row.id,
          email: row.email,
          recipients: parseRecipients(row.mail_to),
          schedule: normalizeSchedule(row),
          managed: row.organizationId !== null,
        },
        managers: new Set(),
      };
      accounts.set(row.id, account);
    }
    if (row.manager_email) account.managers.add(row.manager_email);
  }
  return [...accounts.values()].map(({ delivery, managers }) => ({
    ...delivery,
    recipients: delivery.recipients.length > 0 ? delivery.recipients
      : managers.size > 0 ? [...managers] : [delivery.email],
  }));
}

export async function getEffectiveDelivery(
  env: Env,
  user: { userId: string; email: string },
): Promise<EffectiveDelivery> {
  const [delivery] = await readDeliveries(env, user);
  return delivery
    ? { recipients: delivery.recipients, schedule: delivery.schedule, managed: delivery.managed }
    : { recipients: [user.email], schedule: normalizeSchedule(null), managed: false };
}

/** Bulk selection keeps the per-minute cron from resolving each account separately. */
export async function listDeliveries(env: Env): Promise<AccountDelivery[]> {
  return readDeliveries(env, null);
}

export async function getTeamDelivery(env: Env, organizationId: string): Promise<Delivery & {
  defaultRecipients: string[];
}> {
  const row = await env.DB.prepare(
    "SELECT mail_to, send_day, send_time, send_timezone FROM org_settings WHERE organizationId = ?",
  ).bind(organizationId).first<StoredDelivery>();
  const managers = await env.DB.prepare(
    `SELECT u.email FROM member m JOIN user u ON u.id = m.userId
      WHERE m.organizationId = ? AND (m.role LIKE '%owner%' OR m.role LIKE '%admin%')
      ORDER BY m.createdAt`,
  ).bind(organizationId).all<{ email: string }>();
  return {
    recipients: parseRecipients(row?.mail_to ?? null),
    schedule: normalizeSchedule(row),
    defaultRecipients: [...new Set((managers.results ?? []).map((manager) => manager.email).filter(Boolean))],
  };
}

function parseDelivery(input: unknown): Delivery | string {
  const body = input !== null && typeof input === "object" ? input : {};
  const rawRecipients = "recipients" in body ? body.recipients : undefined;
  const recipients = Array.isArray(rawRecipients)
    ? rawRecipients.map((value: unknown) => typeof value === "string" ? value.trim() : "").filter(Boolean)
    : [];
  if (recipients.length === 0) return "at least one recipient required";
  if (recipients.length > 20) return "too many recipients";
  if (!recipients.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return "invalid email";

  const rawDay = "sendDay" in body ? body.sendDay : undefined;
  const day = rawDay === undefined ? 1 : Number(rawDay);
  if (!isValidSendDay(day)) return "invalid send day";
  const rawTime = "sendTime" in body ? body.sendTime : undefined;
  const time = rawTime === undefined ? DEFAULT_SEND_TIME
    : typeof rawTime === "string" ? rawTime.trim() : rawTime;
  if (!isValidSendTime(time)) return "invalid send time";
  const rawTimezone = "sendTimezone" in body ? body.sendTimezone : undefined;
  const timezone = rawTimezone === undefined ? DEFAULT_SEND_TIMEZONE
    : typeof rawTimezone === "string" ? rawTimezone.trim() : rawTimezone;
  if (!isValidTimeZone(timezone)) return "invalid timezone";
  return { recipients, schedule: { day, time, timezone } };
}

function settingsFields({ recipients, schedule }: Delivery) {
  return { recipients, sendDay: schedule.day, sendTime: schedule.time, sendTimezone: schedule.timezone };
}

/** Callers authenticate the account and authorize access to the selected team. */
export async function handleDeliverySettings(req: Request, env: Env, target: DeliveryTarget): Promise<Response> {
  if (req.method === "GET") {
    if (target.kind === "team") {
      const delivery = await getTeamDelivery(env, target.organizationId);
      return Response.json({ ...settingsFields(delivery), defaultRecipients: delivery.defaultRecipients });
    }
    const delivery = await getEffectiveDelivery(env, target);
    return Response.json({ ...settingsFields(delivery), managed: delivery.managed });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (target.kind === "personal" && await orgIdForUser(env, target.userId)) {
    return Response.json({ error: "your team manager controls timesheet delivery" }, { status: 403 });
  }
  const input: unknown = await req.json().catch(() => ({}));
  const delivery = parseDelivery(input);
  if (typeof delivery === "string") return Response.json({ error: delivery }, { status: 400 });
  const { recipients, schedule } = delivery;
  const [table, column, id] = target.kind === "team"
    ? ["org_settings", "organizationId", target.organizationId]
    : ["user_settings", "userId", target.userId];
  await env.DB.prepare(
    `INSERT INTO ${table} (${column}, mail_to, send_day, send_time, send_timezone) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(${column}) DO UPDATE SET mail_to = excluded.mail_to, send_day = excluded.send_day,
       send_time = excluded.send_time, send_timezone = excluded.send_timezone`,
  ).bind(id, recipients.join("\n"), schedule.day, schedule.time, schedule.timezone).run();
  return Response.json({ ok: true, ...settingsFields(delivery) });
}
