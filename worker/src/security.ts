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
