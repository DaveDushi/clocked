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
}

async function insertHashed(env: Env, userId: string, token: string): Promise<void> {
  const tokenHash = await hashToken(token);
  const prefix = tokenPrefix(token);
  await env.DB.prepare(
    `INSERT INTO api_token (token, token_hash, token_prefix, userId, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(`h:${tokenHash}`, tokenHash, prefix, userId, new Date().toISOString())
    .run();
}

/**
 * Ensure the user has a token. Returns the full secret only when minting;
 * existing tokens are never re-read (only the prefix is returned).
 */
export async function getOrCreateToken(env: Env, userId: string): Promise<TokenView> {
  const row = await env.DB.prepare(
    `SELECT token, token_hash, token_prefix FROM api_token WHERE userId = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ token: string; token_hash: string | null; token_prefix: string | null }>();

  if (row) {
    // Legacy plaintext still in `token` (no hash yet) — do not return it again.
    const prefix =
      row.token_prefix ||
      (row.token.startsWith("clk_") ? tokenPrefix(row.token) : row.token.slice(0, 8) + "…");
    return { token: null, prefix, exists: true, created: false };
  }

  const token = generateToken();
  await insertHashed(env, userId, token);
  return { token, prefix: tokenPrefix(token), exists: true, created: true };
}

/** Revoke existing token(s) and issue a new one (full secret returned once). */
export async function rotateToken(env: Env, userId: string): Promise<TokenView> {
  await env.DB.prepare("DELETE FROM api_token WHERE userId = ?").bind(userId).run();
  const token = generateToken();
  await insertHashed(env, userId, token);
  return { token, prefix: tokenPrefix(token), exists: true, created: true };
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
    `SELECT userId, token FROM api_token WHERE token = ? LIMIT 1`,
  )
    .bind(token)
    .first<{ userId: string; token: string }>();
  if (!byPlain?.userId) return null;

  // Upgrade: replace plaintext row with hashed form.
  try {
    await env.DB.prepare("DELETE FROM api_token WHERE token = ?").bind(token).run();
    await insertHashed(env, byPlain.userId, token);
  } catch {
    /* concurrent upgrade — auth still succeeded */
  }
  return byPlain.userId;
}
