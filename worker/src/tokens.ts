import type { Env } from "./types";

// Per-account Bearer tokens for desktop sync. Tokens are high-entropy random
// secrets (192-bit), looked up by their value (the PK) — no hashing needed for
// the lookup to be safe, and the prefix makes them recognizable in configs.

const TOKEN_BYTES = 24; // 192-bit

function b64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a fresh, unguessable token (e.g. "clk_9fT2...") */
export function generateToken(): string {
  return "clk_" + b64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** The user's current token, creating one on first request. */
export async function getOrCreateToken(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT token FROM api_token WHERE userId = ? LIMIT 1")
    .bind(userId)
    .first<{ token: string }>();
  if (row?.token) return row.token;

  const token = generateToken();
  await env.DB.prepare("INSERT INTO api_token (token, userId, createdAt) VALUES (?, ?, ?)")
    .bind(token, userId, new Date().toISOString())
    .run();
  return token;
}

/** Revoke the user's existing token(s) and issue a new one. */
export async function rotateToken(env: Env, userId: string): Promise<string> {
  await env.DB.prepare("DELETE FROM api_token WHERE userId = ?").bind(userId).run();
  return getOrCreateToken(env, userId);
}

/** Resolve a raw Bearer token value to its owning userId, or null. */
export async function userIdForToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare("SELECT userId FROM api_token WHERE token = ? LIMIT 1")
    .bind(token)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}
