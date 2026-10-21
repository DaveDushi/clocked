import type { Env } from "./types";
import { getPrimaryMembership } from "./memberships.js";

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

/** Real teams take precedence over legacy single-seat personal organizations. */
export async function orgIdForUser(env: Env, userId: string): Promise<string | null> {
  return (await getPrimaryMembership(env, userId))?.organizationId ?? null;
}
