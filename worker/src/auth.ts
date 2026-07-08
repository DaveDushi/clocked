import type { Env } from "./types";

/**
 * Constant-time bearer-token check against the Worker's BEARER_TOKEN secret.
 * Fails closed when the secret is missing/blank so an unset env never
 * authenticates `Authorization: Bearer `.
 */
export function checkAuth(req: Request, env: Env): boolean {
  const secret = env.BEARER_TOKEN;
  if (typeof secret !== "string" || secret.length === 0) return false;

  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
