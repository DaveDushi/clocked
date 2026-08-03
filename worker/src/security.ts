/**
 * Attach baseline security headers without destroying multi-value Set-Cookie.
 * `new Headers(res.headers)` + rebuild can collapse multiple Set-Cookie lines into
 * one (or drop them), which breaks better-auth sign-out / session cookies.
 */
export function withSecurityHeaders(res: Response, req?: Request): Response {
  const headers = new Headers();

  // Copy every header except Set-Cookie (handled separately).
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers.append(key, value);
  });

  // Preserve each Set-Cookie as its own header (sign-out clears several cookies).
  // getSetCookie() exists on undici/Workers Headers but not all TS lib typings.
  const hdr = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof hdr.getSetCookie === "function" ? hdr.getSetCookie() : [];
  if (setCookies.length > 0) {
    for (const c of setCookies) headers.append("Set-Cookie", c);
  } else {
    // Fallback if runtime only exposes a single joined header.
    const single = res.headers.get("set-cookie");
    if (single) headers.append("Set-Cookie", single);
  }

  if (!headers.has("x-content-type-options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("x-frame-options")) {
    headers.set("X-Frame-Options", "DENY");
  }
  if (!headers.has("referrer-policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("permissions-policy")) {
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
  if (!headers.has("cross-origin-opener-policy")) {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
  }

  // HSTS only on HTTPS so local http://localhost:8787 is not bricked.
  const isHttps = req ? new URL(req.url).protocol === "https:" : false;
  if (isHttps && !headers.has("strict-transport-security")) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // HTML is a large inline app; full script CSP would need nonces across the
  // dashboard template — frame-ancestors + baseline directives are the win.
  if (!headers.has("content-security-policy")) {
    const ct = headers.get("content-type") ?? "";
    if (ct.includes("text/html")) {
      headers.set(
        "Content-Security-Policy",
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
          "form-action 'self'" +
          (isHttps ? "; upgrade-insecure-requests" : ""),
      );
    } else {
      headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Validate report period query param "YYYY-MM". */
export function isValidPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}

/** Parse period or null if invalid. Empty/null input → null (caller uses default). */
export function parsePeriodParam(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  return isValidPeriod(raw) ? raw : null;
}

/** Client-safe error body — never forward upstream exception text. */
export function publicError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * CSRF guard for cookie-authenticated mutating API calls.
 * Browsers send Origin on cross-site form/fetch POSTs; we require same origin.
 * Sec-Fetch-Site / Referer are fallbacks for older clients.
 */
export function isSameOriginRequest(req: Request): boolean {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }

  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site === "same-origin" || site === "none") return true;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }

  // No Origin/Referer on a mutating request → fail closed (blocks classic CSRF).
  return false;
}

/** True for real Gregorian calendar dates (rejects 2026-02-31). */
export function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Known desktop clock reasons (+ manual). Unknown values are dropped. */
const KNOWN_REASONS = new Set([
  "start",
  "resume",
  "unlock",
  "active",
  "call",
  "manual",
  "idle",
  "lock",
  "suspend",
  "shutdown",
  "quit",
  "crash",
  "app",
]);

/**
 * Normalize a session reason from the desktop client.
 * Keeps only short, known tokens so free-form junk cannot pollute reports.
 */
export function sanitizeSessionReason(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().slice(0, 32);
  if (!s) return null;
  if (KNOWN_REASONS.has(s)) return s;
  // Allow simple future tokens: lowercase letters/digits/underscore only, short.
  if (/^[a-z][a-z0-9_]{0,31}$/.test(s)) return s;
  return null;
}

/**
 * Constant-time string compare for shared secrets.
 * Unequal lengths short-circuit (length is not itself the secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
