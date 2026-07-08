import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAuth } from "../.tmp-test/auth.js";

test("empty BEARER_TOKEN never authenticates", () => {
  const req = new Request("https://example.com/sessions", {
    headers: { authorization: "Bearer " },
  });
  assert.equal(checkAuth(req, { BEARER_TOKEN: "" }), false);
  assert.equal(checkAuth(req, { BEARER_TOKEN: undefined }), false);
});

test("configured BEARER_TOKEN constant-time match", () => {
  const env = { BEARER_TOKEN: "supersecret" };
  const ok = new Request("https://example.com/sessions", {
    headers: { authorization: "Bearer supersecret" },
  });
  const bad = new Request("https://example.com/sessions", {
    headers: { authorization: "Bearer wrongsecret" },
  });
  assert.equal(checkAuth(ok, env), true);
  assert.equal(checkAuth(bad, env), false);
});
