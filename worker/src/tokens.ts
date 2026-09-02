import type { Env } from "./types";

// Per-account Bearer tokens for desktop sync. The full secret is shown once at
// create/rotate; only a SHA-256 hash is stored (plus a short prefix for the UI).
// Legacy rows that still store plaintext in `token` are upgraded on first use.

const TOKEN_BYTES = 24; // 192-bit

function b64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a fresh, unguessable token (e.g. "clk_9fT2...") */
export function generateToken(): string {
  return "clk_" + b64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** SHA-256 hex of the raw token (lookup key). */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** UI prefix: "clk_" + first 8 chars of the secret body (not enough to auth). */
export function tokenPrefix(token: string): string {
  if (token.startsWith("clk_") && token.length > 12) return token.slice(0, 12) + "…";
  return token.slice(0, 8) + "…";
}

export interface TokenView {
  /** Full secret — only set when newly minted. */
  token: string | null;
  /** Safe-to-display prefix. */
  prefix: string | null;
  /** True when a token row exists for this user. */
  exists: boolean;
  /** True when `token` was just created and must be copied now. */
  created: boolean;
  /** Stable, non-secret identifier used for per-device revocation. */
  id: string;
  /** User-visible device name. */
  name: string;
}

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export const MAX_DEVICE_TOKENS = 20;
export const MAX_DEVICE_NAME_LENGTH = 64;

/** Validate and normalize a dashboard-provided device name. */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_DEVICE_NAME_LENGTH || /[\u0000-\u001f\u007f<>]/.test(name)) {
    return null;
  }
  return name;
}

async function insertHashed(
  env: Env,
  userId: string,
  token: string,
  name: string,
  id: string = crypto.randomUUID(),
): Promise<TokenSummary> {
  const tokenHash = await hashToken(token);
  const prefix = tokenPrefix(token);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO api_token (token, token_hash, token_prefix, userId, createdAt, id, name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(`h:${tokenHash}`, tokenHash, prefix, userId, createdAt, id, name)
    .run();
  return { id, name, prefix, createdAt };
}

/**
 * Ensure the user has a token. Returns the full secret only when minting;
 * existing tokens are never re-read (only the prefix is returned).
 */
export async function getOrCreateToken(env: Env, userId: string): Promise<TokenView> {
  const row = await env.DB.prepare(
    `SELECT token, token_hash, token_prefix, id, name
       FROM api_token WHERE userId = ? ORDER BY createdAt LIMIT 1`,
  )
    .bind(userId)
    .first<{
      token: string;
      token_hash: string | null;
      token_prefix: string | null;
      id: string;
      name: string | null;
    }>();

  if (row) {
    // Legacy plaintext still in `token` (no hash yet) — do not return it again.
    const prefix =
      row.token_prefix ||
      (row.token.startsWith("clk_") ? tokenPrefix(row.token) : row.token.slice(0, 8) + "…");
    return {
      token: null,
      prefix,
      exists: true,
      created: false,
      id: row.id,
      name: row.name || "Existing device",
    };
  }

  const token = generateToken();
  const summary = await insertHashed(env, userId, token, "First device");
  return { token, ...summary, exists: true, created: true };
}

/** List all device tokens without ever returning their full secrets. */
export async function listTokens(env: Env, userId: string): Promise<TokenSummary[]> {
  const result = await env.DB.prepare(
    `SELECT id, COALESCE(name, 'Existing device') AS name,
            COALESCE(token_prefix, substr(token, 1, 12) || '…') AS prefix,
            createdAt
       FROM api_token WHERE userId = ? ORDER BY createdAt, id`,
  )
    .bind(userId)
    .all<TokenSummary>();
  return result.results ?? [];
}

/** Mint an additional device token without changing any existing token. */
export async function mintToken(env: Env, userId: string, name: string): Promise<TokenView> {
  const token = generateToken();
  const summary = await insertHashed(env, userId, token, name);
  return { token, ...summary, exists: true, created: true };
}

/** Revoke one device token owned by this user. */
export async function revokeToken(env: Env, userId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM api_token WHERE userId = ? AND id = ?")
    .bind(userId, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Revoke existing token(s) and issue a new one (full secret returned once). */
export async function rotateToken(env: Env, userId: string): Promise<TokenView> {
  await env.DB.prepare("DELETE FROM api_token WHERE userId = ?").bind(userId).run();
  const token = generateToken();
  const summary = await insertHashed(env, userId, token, "Regenerated device");
  return { token, ...summary, exists: true, created: true };
}

/**
 * Resolve a raw Bearer token value to its owning userId, or null.
 * Supports hashed rows and legacy plaintext; upgrades legacy on hit.
 */
export async function userIdForToken(env: Env, token: string): Promise<string | null> {
  if (!token || token.length < 8) return null;

  const tokenHash = await hashToken(token);

  const byHash = await env.DB.prepare(
    `SELECT userId FROM api_token WHERE token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{ userId: string }>();
  if (byHash?.userId) return byHash.userId;

  // Legacy plaintext PK lookup.
  const byPlain = await env.DB.prepare(
    `SELECT userId, token, id, name FROM api_token WHERE token = ? LIMIT 1`,
  )
    .bind(token)
    .first<{ userId: string; token: string; id: string; name: string | null }>();
  if (!byPlain?.userId) return null;

  // Upgrade: replace plaintext row with hashed form.
  try {
    await env.DB.prepare("DELETE FROM api_token WHERE token = ?").bind(token).run();
    await insertHashed(
      env,
      byPlain.userId,
      token,
      byPlain.name || "Existing device",
      byPlain.id,
    );
  } catch {
    /* concurrent upgrade — auth still succeeded */
  }
  return byPlain.userId;
}
