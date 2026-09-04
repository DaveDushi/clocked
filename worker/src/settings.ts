import type { Env } from "./types";
import {
  DEFAULT_SEND_TIME,
  DEFAULT_SEND_TIMEZONE,
  isValidSendDay,
  isValidSendTime,
  isValidTimeZone,
  type SendSchedule,
} from "./schedule";

type StoredSchedule = {
  send_day: number | null;
  send_time: string | null;
  send_timezone: string | null;
};

function normalizeSchedule(row: StoredSchedule | null): SendSchedule {
  const day = row?.send_day ?? 1;
  const time = row?.send_time ?? DEFAULT_SEND_TIME;
  const timezone = row?.send_timezone ?? DEFAULT_SEND_TIMEZONE;
  return {
    day: isValidSendDay(day) ? day : 1,
    time: isValidSendTime(time) ? time : DEFAULT_SEND_TIME,
    timezone: isValidTimeZone(timezone) ? timezone : DEFAULT_SEND_TIMEZONE,
  };
}

/** Read a value from the `settings` key/value table (null if unset). */
export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Upsert a value into the `settings` key/value table. */
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

/** Per-user timesheet recipient override (null if the user hasn't set one). */
export async function getMailTo(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT mail_to FROM user_settings WHERE userId = ?")
    .bind(userId)
    .first<{ mail_to: string | null }>();
  return row?.mail_to ?? null;
}

/** Upsert a user's timesheet recipient(s). Stores the raw (newline-joined) string. */
export async function setMailTo(env: Env, userId: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (userId, mail_to) VALUES (?, ?)
     ON CONFLICT(userId) DO UPDATE SET mail_to = excluded.mail_to`,
  )
    .bind(userId, value)
    .run();
}

/** Per-user delivery schedule. NULL columns retain the historical 06:00 UTC default. */
export async function getSendSchedule(env: Env, userId: string): Promise<SendSchedule> {
  const row = await env.DB.prepare(
    "SELECT send_day, send_time, send_timezone FROM user_settings WHERE userId = ?",
  )
    .bind(userId)
    .first<StoredSchedule>();
  return normalizeSchedule(row);
}

/** Atomically upsert all per-user schedule fields. */
export async function setSendSchedule(
  env: Env,
  userId: string,
  schedule: SendSchedule,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (userId, send_day, send_time, send_timezone) VALUES (?, ?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET
       send_day = excluded.send_day,
       send_time = excluded.send_time,
       send_timezone = excluded.send_timezone`,
  )
    .bind(userId, schedule.day, schedule.time, schedule.timezone)
    .run();
}

/**
 * Desktop project-tracking feature flag (Settings → Advanced / track_projects).
 * `null` = never set by a current desktop (legacy); treat as "show if data exists".
 * `false` = user turned the feature off — hide dashboard + CSV project sections.
 * `true` = feature on — show project rollups when activity_day has rows.
 */
export async function getTrackProjects(env: Env, userId: string): Promise<boolean | null> {
  try {
    const row = await env.DB.prepare("SELECT track_projects FROM user_settings WHERE userId = ?")
      .bind(userId)
      .first<{ track_projects: number | null }>();
    if (!row || row.track_projects == null) return null;
    return row.track_projects === 1;
  } catch {
    // Migration 0013 not applied yet.
    return null;
  }
}

/** Persist the desktop track_projects preference (creates user_settings row if needed). */
export async function setTrackProjects(env: Env, userId: string, enabled: boolean): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO user_settings (userId, track_projects) VALUES (?, ?)
       ON CONFLICT(userId) DO UPDATE SET track_projects = excluded.track_projects`,
    )
      .bind(userId, enabled ? 1 : 0)
      .run();
  } catch {
    // Migration 0013 not applied yet — ignore; project data still syncs.
  }
}

/** Split a stored `mail_to` value into individual addresses (newline/comma separated,
 * trimmed, de-duplicated, empties dropped). */
export function parseRecipients(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const addr of raw.split(/[\n,]/)) {
    const t = addr.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** The user's timesheet recipients, falling back to their account email when none set. */
export async function getRecipients(
  env: Env,
  userId: string,
  fallbackEmail: string,
): Promise<string[]> {
  const list = parseRecipients(await getMailTo(env, userId));
  return list.length > 0 ? list : [fallbackEmail];
}

// ---- Team (org-level) timesheet delivery ---------------------------------
// In a team the manager chooses where every member's timesheet is emailed and
// on what schedule, overriding each member's personal setting. Solo users keep
// their own user_settings.

/** The (first) organization a user belongs to, or null for solo users. */
export async function orgIdForUser(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1",
  )
    .bind(userId)
    .first<{ organizationId: string }>();
  return row?.organizationId ?? null;
}

/** The team's timesheet recipient(s) as stored by the manager (null if unset). */
export async function getOrgMailTo(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT mail_to FROM org_settings WHERE organizationId = ?")
    .bind(orgId)
    .first<{ mail_to: string | null }>();
  return row?.mail_to ?? null;
}
export async function setOrgMailTo(env: Env, orgId: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_settings (organizationId, mail_to) VALUES (?, ?)
     ON CONFLICT(organizationId) DO UPDATE SET mail_to = excluded.mail_to`,
  )
    .bind(orgId, value)
    .run();
}

/** Organization delivery schedule, shared by every member. */
export async function getOrgSendSchedule(env: Env, orgId: string): Promise<SendSchedule> {
  const row = await env.DB.prepare(
    "SELECT send_day, send_time, send_timezone FROM org_settings WHERE organizationId = ?",
  )
    .bind(orgId)
    .first<StoredSchedule>();
  return normalizeSchedule(row);
}

/** Atomically upsert all organization schedule fields. */
export async function setOrgSendSchedule(
  env: Env,
  orgId: string,
  schedule: SendSchedule,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_settings (organizationId, send_day, send_time, send_timezone)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(organizationId) DO UPDATE SET
       send_day = excluded.send_day,
       send_time = excluded.send_time,
       send_timezone = excluded.send_timezone`,
  )
    .bind(orgId, schedule.day, schedule.time, schedule.timezone)
    .run();
}

/** Owner/admin emails for an org — the default timesheet destination until a
 * manager sets an explicit one, so team timesheets always reach a manager. */
export async function managerEmailsForOrg(env: Env, orgId: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT u.email AS email FROM member m JOIN user u ON u.id = m.userId
      WHERE m.organizationId = ? AND (m.role LIKE '%owner%' OR m.role LIKE '%admin%')
      ORDER BY m.createdAt`,
  )
    .bind(orgId)
    .all<{ email: string }>();
  const seen = new Set<string>();
  for (const r of res.results ?? []) if (r.email) seen.add(r.email);
  return [...seen];
}

/** Effective timesheet recipients for a user. In a team the manager's org-level
 * choice wins (defaulting to the managers' own emails); solo users keep their
 * personal recipients. `managed` is true when the team controls delivery. */
export async function getEffectiveRecipients(
  env: Env,
  userId: string,
  fallbackEmail: string,
): Promise<{ recipients: string[]; managed: boolean }> {
  const orgId = await orgIdForUser(env, userId);
  if (!orgId) return { recipients: await getRecipients(env, userId, fallbackEmail), managed: false };
  const explicit = parseRecipients(await getOrgMailTo(env, orgId));
  let recipients = explicit.length > 0 ? explicit : await managerEmailsForOrg(env, orgId);
  if (recipients.length === 0) recipients = [fallbackEmail];
  return { recipients, managed: true };
}

/** Effective schedule for a user (the team schedule wins in a team). */
export async function getEffectiveSendSchedule(
  env: Env,
  userId: string,
): Promise<SendSchedule> {
  const orgId = await orgIdForUser(env, userId);
  return orgId ? await getOrgSendSchedule(env, orgId) : await getSendSchedule(env, userId);
}

export interface ScheduledUser {
  id: string;
  email: string;
  schedule: SendSchedule;
}

/**
 * Load every account's effective schedule in one query for the per-minute cron.
 * The earliest membership matches `orgIdForUser`; an org schedule overrides the
 * personal schedule whenever the user belongs to a team.
 */
export async function listUsersWithEffectiveSchedules(env: Env): Promise<ScheduledUser[]> {
  const res = await env.DB.prepare(
    `WITH first_membership AS (
       SELECT userId, organizationId,
              ROW_NUMBER() OVER (PARTITION BY userId ORDER BY createdAt) AS position
         FROM member
     )
     SELECT u.id, u.email,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_day ELSE us.send_day END AS send_day,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_time ELSE us.send_time END AS send_time,
            CASE WHEN fm.organizationId IS NOT NULL THEN os.send_timezone ELSE us.send_timezone END AS send_timezone
       FROM user u
       LEFT JOIN first_membership fm ON fm.userId = u.id AND fm.position = 1
       LEFT JOIN user_settings us ON us.userId = u.id
       LEFT JOIN org_settings os ON os.organizationId = fm.organizationId`,
  ).all<{ id: string; email: string } & StoredSchedule>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    schedule: normalizeSchedule(row),
  }));
}
