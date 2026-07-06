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

/** Upsert a user's timesheet recipient. */
export async function setMailTo(env: Env, userId: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (userId, mail_to) VALUES (?, ?)
     ON CONFLICT(userId) DO UPDATE SET mail_to = excluded.mail_to`,
  )
    .bind(userId, value)
    .run();
}
