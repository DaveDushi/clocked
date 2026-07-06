import { betterAuth } from "better-auth";

import type { Env } from "./types";

// --- Workers-native password hashing (PBKDF2 via Web Crypto) --------------
// better-auth's default is pure-JS scrypt (@noble/hashes), which can exceed the
// Worker CPU limit even on a single sign-up (better-auth issue #8860). Web Crypto
// PBKDF2 is hardware-accelerated and off the pure-JS CPU path — no nodejs_compat,
// no extra deps. Stored format is self-describing: `pbkdf2$<iter>$<saltB64>$<hashB64>`.
const PBKDF2_ITER = 100_000; // Cloudflare crypto.subtle caps PBKDF2 near 100k
const KEY_LEN = 32; // 256-bit derived key
const enc = new TextEncoder();

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveBits(password: string, salt: Uint8Array, iter: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    key,
    KEY_LEN * 8,
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt.buffer)}$${b64(bits)}`;
}

async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = hash.split("$");
  if (scheme !== "pbkdf2") return false;
  const bits = await deriveBits(password, unb64(saltB64), Number(iterStr));
  const a = new Uint8Array(bits);
  const b = unb64(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- better-auth instance --------------------------------------------------
// Bindings only exist inside `fetch`, so build a fresh instance per request.
// Public sign-up is enabled: each new account gets its own per-account API token
// (see tokens.ts) that the desktop app uses to sync.
export function makeAuth(env: Env, allowSignUp = true) {
  return betterAuth({
    database: env.DB, // native D1 (better-auth >= 1.5), no adapter
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp, // public multi-account registration
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30d — rarely re-run the CPU-heavy login
      updateAge: 60 * 60 * 24 * 7, // slide expiry at most weekly -> ~0 refresh writes
      cookieCache: { enabled: true, maxAge: 5 * 60 }, // serve getSession from cookie -> skip D1
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100, // in-memory per-isolate limiter; fine at this scale
      customRules: { "/sign-in/email": { window: 10, max: 3 } }, // throttle password verify
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;
