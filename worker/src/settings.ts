import type { Env } from "./types";

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

/** Per-user auto-send day of the month. Absent/NULL -> 1 (send on the 1st);
 * 0 means automatic monthly sending is turned off; 99 means the last day. */
export async function getSendDay(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT send_day FROM user_settings WHERE userId = ?")
    .bind(userId)
    .first<{ send_day: number | null }>();
  return row?.send_day ?? 1;
}

/** Upsert a user's auto-send day (0 = disabled, 1..28 = day of month). */
export async function setSendDay(env: Env, userId: string, day: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (userId, send_day) VALUES (?, ?)
     ON CONFLICT(userId) DO UPDATE SET send_day = excluded.send_day`,
  )
    .bind(userId, day)
    .run();
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

/** The team's auto-send day (1 default, 0 off, 99 last day). */
export async function getOrgSendDay(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT send_day FROM org_settings WHERE organizationId = ?")
    .bind(orgId)
    .first<{ send_day: number | null }>();
  return row?.send_day ?? 1;
}
export async function setOrgSendDay(env: Env, orgId: string, day: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_settings (organizationId, send_day) VALUES (?, ?)
     ON CONFLICT(organizationId) DO UPDATE SET send_day = excluded.send_day`,
  )
    .bind(orgId, day)
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

/** Effective auto-send day for a user (the team schedule wins in a team). */
export async function getEffectiveSendDay(env: Env, userId: string): Promise<number> {
  const orgId = await orgIdForUser(env, userId);
  return orgId ? await getOrgSendDay(env, orgId) : await getSendDay(env, userId);
}
