import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidPeriod, parsePeriodParam } from "../.tmp-test/security.js";
import { planCap, orgPlan, isPaidBillingStatus } from "../.tmp-test/plans.js";
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

test("unpaid / unknown plan never grants multi-seat free tier", () => {
  assert.equal(orgPlan(null), "single");
  assert.equal(orgPlan("{}"), "single");
  assert.equal(orgPlan(JSON.stringify({ plan: "teamplus" })), "teamplus");
  assert.equal(planCap("single"), 1);
  assert.equal(planCap(undefined), 1);
  assert.equal(isPaidBillingStatus("active"), true);
  assert.equal(isPaidBillingStatus("canceled"), false);
  assert.equal(isPaidBillingStatus(""), false);
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

test("ingest batch cap is finite", () => {
  assert.ok(MAX_SESSIONS_PER_REQUEST > 0);
  assert.ok(MAX_SESSIONS_PER_REQUEST <= 1000);
});
