import type { Env } from "./types";

/** Constant-time bearer-token check against the Worker's BEARER_TOKEN secret. */
export function checkAuth(req: Request, env: Env): boolean {
  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.BEARER_TOKEN}`;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
