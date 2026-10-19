import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidPeriod, parsePeriodParam } from "../.tmp-test/security.js";
import { planCap, orgPlan, TEAM_SEAT_CAP } from "../.tmp-test/plans.js";
import { rateLimitAllow } from "../.tmp-test/rate-limit.js";
import { MAX_SESSIONS_PER_REQUEST } from "../.tmp-test/ingest.js";

test("period validation accepts YYYY-MM only", () => {
  assert.equal(isValidPeriod("2026-06"), true);
  assert.equal(isValidPeriod("2026-13"), false);
  assert.equal(isValidPeriod("26-06"), false);
  assert.equal(isValidPeriod("not-a-period"), false);
  assert.equal(parsePeriodParam(null), null);
  assert.equal(parsePeriodParam("2026-01"), "2026-01");
  assert.equal(parsePeriodParam("bogus"), null);
});

test("unknown plan never grants a multi-seat org", () => {
  assert.equal(orgPlan(null), "single");
  assert.equal(orgPlan("{}"), "single");
  assert.equal(orgPlan(JSON.stringify({ plan: "bogus" })), "single");
  assert.equal(orgPlan(JSON.stringify({ plan: "team" })), "team");
  assert.equal(orgPlan(JSON.stringify({ plan: "teamplus" })), "team");
  assert.equal(planCap("single"), 1);
  assert.equal(planCap(undefined), 1);
  assert.equal(planCap("team"), TEAM_SEAT_CAP);
});

test("in-memory rate limiter trips after max", () => {
  const key = "test-" + Math.random();
  assert.equal(rateLimitAllow(key, 2, 60_000), true);
  assert.equal(rateLimitAllow(key, 2, 60_000), true);
  assert.equal(rateLimitAllow(key, 2, 60_000), false);
});

test("security headers include HSTS only on https", async () => {
  const { withSecurityHeaders } = await import("../.tmp-test/security.js");
  const base = new Response("ok", { headers: { "content-type": "text/plain" } });
  const httpsReq = new Request("https://clocked.example/");
  const httpReq = new Request("http://localhost:8787/");
  const withHsts = withSecurityHeaders(base.clone(), httpsReq);
  const noHsts = withSecurityHeaders(base.clone(), httpReq);
  assert.ok(withHsts.headers.get("strict-transport-security")?.includes("max-age="));
  assert.equal(noHsts.headers.get("strict-transport-security"), null);
  assert.equal(withHsts.headers.get("x-content-type-options"), "nosniff");
});

test("security headers preserve multiple Set-Cookie values", async () => {
  const { withSecurityHeaders } = await import("../.tmp-test/security.js");
  // Build a response the way auth libraries do (append each cookie).
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", "a=1; Path=/; HttpOnly");
  headers.append("Set-Cookie", "b=2; Path=/; HttpOnly");
  headers.append("Set-Cookie", "c=; Max-Age=0; Path=/");
  const res = withSecurityHeaders(new Response("{}", { headers }));
  const cookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  assert.ok(cookies.length >= 2, "expected multiple Set-Cookie headers, got " + cookies.length);
  assert.ok(cookies.some((c) => c.startsWith("a=")));
  assert.ok(cookies.some((c) => c.startsWith("b=")));
});

test("ingest batch cap is finite", () => {
  assert.ok(MAX_SESSIONS_PER_REQUEST > 0);
  assert.ok(MAX_SESSIONS_PER_REQUEST <= 1000);
});

test("calendar date validation rejects impossible days", async () => {
  const { isValidCalendarDate, sanitizeSessionReason, isSameOriginRequest, timingSafeEqual } =
    await import("../.tmp-test/security.js");
  assert.equal(isValidCalendarDate(2026, 2, 28), true);
  assert.equal(isValidCalendarDate(2026, 2, 29), false); // not a leap year
  assert.equal(isValidCalendarDate(2024, 2, 29), true);
  assert.equal(isValidCalendarDate(2026, 13, 1), false);
  assert.equal(isValidCalendarDate(1999, 6, 1), false);

  assert.equal(sanitizeSessionReason("unlock"), "unlock");
  assert.equal(sanitizeSessionReason("IDLE"), "idle");
  assert.equal(sanitizeSessionReason("  manual  "), "manual");
  assert.equal(sanitizeSessionReason("<script>"), null);
  assert.equal(sanitizeSessionReason(null), null);

  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("ab", "abc"), false);

  const same = new Request("https://clocked.example/api/hours", {
    method: "POST",
    headers: { origin: "https://clocked.example" },
  });
  const cross = new Request("https://clocked.example/api/hours", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  const noOrigin = new Request("https://clocked.example/api/hours", { method: "POST" });
  assert.equal(isSameOriginRequest(same), true);
  assert.equal(isSameOriginRequest(cross), false);
  assert.equal(isSameOriginRequest(noOrigin), false);
});
