import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateToken,
  mintToken,
  normalizeDeviceName,
  revokeToken,
  tokenPrefix,
} from "../.tmp-test/tokens.js";

test("device names are normalized and unsafe names are rejected", () => {
  assert.equal(normalizeDeviceName("  Personal   laptop  "), "Personal laptop");
  assert.equal(normalizeDeviceName(""), null);
  assert.equal(normalizeDeviceName("bad<name"), null);
  assert.equal(normalizeDeviceName("x".repeat(65)), null);
});

test("minted tokens are unique clk secrets with safe display prefixes", () => {
  const first = generateToken();
  const second = generateToken();
  assert.match(first, /^clk_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first, second);
  assert.equal(tokenPrefix(first), first.slice(0, 12) + "…");
});

test("minting is additive and revocation targets one device id", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
  const env = { DB: db };

  const first = await mintToken(env, "user-1", "Laptop one");
  const second = await mintToken(env, "user-1", "Laptop two");

  assert.notEqual(first.id, second.id);
  assert.equal(calls.filter((x) => /^\s*INSERT INTO api_token/.test(x.sql)).length, 2);
  assert.equal(calls.filter((x) => /^\s*DELETE FROM api_token/.test(x.sql)).length, 0);

  assert.equal(await revokeToken(env, "user-1", first.id), true);
  const deletion = calls.at(-1);
  assert.match(deletion.sql, /WHERE userId = \? AND id = \?/);
  assert.deepEqual(deletion.values, ["user-1", first.id]);
});
