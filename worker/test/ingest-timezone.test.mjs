import assert from "node:assert/strict";
import { test } from "node:test";
import { handleIngest } from "../.tmp-test/ingest.js";

function recordingEnv() {
  const inserts = [];
  return {
    inserts,
    env: {
      DB: {
        prepare(sql) {
          let args = [];
          return {
            sql,
            bind(...values) {
              args = values;
              return this;
            },
            get args() {
              return args;
            },
            async all() {
              return { results: [] };
            },
          };
        },
        async batch(stmts) {
          inserts.push(...stmts.map((s) => s.args));
        },
      },
    },
  };
}

function ingestRequest(timezone) {
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const end = new Date(Date.now() - 60 * 60 * 1000);
  return new Request("https://example.test/sessions", {
    method: "POST",
    body: JSON.stringify({
      sessions: [
        {
          id: "11111111-2222-4333-8444-555555555555",
          start_utc: start.toISOString(),
          end_utc: end.toISOString(),
          timezone,
        },
      ],
    }),
  });
}

test("ingest stores a valid session timezone", async () => {
  const { env, inserts } = recordingEnv();
  const res = await handleIngest(ingestRequest("America/New_York"), env, "user-1");
  assert.equal(res.status, 200);
  assert.equal(inserts[0][5], "America/New_York");
});

test("ingest accepts a session with an unknown timezone and stores null", async () => {
  const { env, inserts } = recordingEnv();
  const res = await handleIngest(ingestRequest("Not/AZone"), env, "user-1");
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.accepted, ["11111111-2222-4333-8444-555555555555"]);
  assert.equal(inserts[0][5], null);
});
