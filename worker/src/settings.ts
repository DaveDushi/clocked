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
 * 0 means automatic monthly sending is turned off. */
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
