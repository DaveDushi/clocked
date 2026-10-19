// An isolated local Worker with real D1, cookies, device tokens and migrations.
// --serve keeps its fixture running for browser checks after the assertions pass.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "clocked-working-hours-"));
const config = join(directory, "wrangler.json");
const state = join(directory, "state");
const port = Number(process.env.CLOCKED_TEST_PORT || 8791);
const base = `http://localhost:${port}`;
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const password = "local-verification-password";
const deviceToken = "clk_local_verification_worker_device";
const deviceId = "11111111-1111-4111-8111-111111111111";
writeFileSync(config, JSON.stringify({
  name: "clocked-hours-verification", main: resolve(root, "src/index.ts"),
  compatibility_date: "2026-07-01", compatibility_flags: ["nodejs_compat"],
  vars: { BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), REPORT_TZ: "UTC", MAIL_FROM: "local@example.test", MAIL_TO: "" },
  d1_databases: [{ binding: "DB", database_name: "clocked", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: resolve(root, "migrations") }],
}));
function wrangler(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--config", config, "--persist-to", state], {
    cwd: directory, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 90_000,
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
wrangler(["d1", "migrations", "apply", "clocked", "--local"]);
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString("base64")}$${pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64")}`;
const sql = [];
for (const id of ["manager", "employee", "other-manager", "outsider"]) {
  sql.push(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${id}', '${id}', '${id}@example.test', 1, 1, 1);`);
  sql.push(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('${id}', '${id}', 'credential', '${id}', '${hash}', 1, 1);`);
  sql.push(`INSERT INTO user_approval (userId, requestedAt, approvedAt) VALUES ('${id}', datetime('now'), datetime('now'));`);
}
sql.push(`INSERT INTO organization (id, name, slug, metadata, createdAt) VALUES ('acme', 'Acme', 'acme', '{"plan":"team"}', 1), ('other', 'Other', 'other', '{"plan":"team"}', 1);
  INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
  ('manager-member', 'acme', 'manager', 'owner', 1), ('employee-member', 'acme', 'employee', 'member', 1),
  ('other-owner', 'other', 'other-manager', 'owner', 1), ('outsider-member', 'other', 'outsider', 'member', 1);`);
const tokenHash = createHash("sha256").update(deviceToken).digest("hex");
sql.push(`INSERT INTO api_token (token, token_hash, token_prefix, userId, createdAt, id, name) VALUES
  ('h:${tokenHash}', '${tokenHash}', 'clk_local_ve', 'employee', datetime('now'), '${deviceId}', 'Test laptop');`);
const seedFile = join(directory, "seed.sql");
writeFileSync(seedFile, sql.join("\n"));
wrangler(["d1", "execute", "clocked", "--local", "--file", seedFile]);

let log = "";
const server = spawn(process.execPath, [cli, "dev", "--local", "--port", String(port), "--config", config, "--persist-to", state], {
  cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
server.stdout.on("data", (data) => { log = (log + data).slice(-16000); });
server.stderr.on("data", (data) => { log = (log + data).slice(-16000); });
process.on("exit", () => server.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function login(id) {
  const response = await fetch(base + "/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: id + "@example.test", password }),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(base + "/health")).ok; } catch {}
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, "Local Worker did not start: " + log);
  const cookies = {};
  for (const id of ["manager", "employee", "other-manager"]) cookies[id] = await login(id);
  async function api(actor, path, schedule) {
    return fetch(base + path, { method: schedule === undefined ? "GET" : "POST", headers: {
      cookie: cookies[actor], origin: base, "content-type": "application/json",
    }, ...(schedule === undefined ? {} : { body: JSON.stringify({ schedule }) }) });
  }
  const path = "/api/team/working-hours?organizationId=acme";
  const hours = { mode: "scheduled", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await api("employee", path, hours)).status, 403);
  assert.equal((await api("other-manager", path)).status, 403);
  assert.equal((await api("manager", path + "&userId=outsider", hours)).status, 403);
  assert.equal((await api("manager", path, hours)).status, 200);
  assert.deepEqual((await (await api("employee", "/api/working-hours")).json()).schedule, hours);
  const desktop = () => fetch(base + "/desktop/working-hours", { headers: { authorization: "Bearer " + deviceToken } });
  let response = await desktop();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).schedule, hours);
  assert.equal((await fetch(base + "/desktop/working-hours")).status, 401);
  const partTime = { ...hours, start: "10:00", end: "14:00", days: [1, 3, 5] };
  assert.equal((await api("manager", path + "&userId=employee", partTime)).status, 200);
  assert.deepEqual((await (await desktop()).json()).schedule, partTime);
  assert.equal((await api("manager", path + "&userId=employee", null)).status, 200);
  assert.deepEqual((await (await desktop()).json()).schedule, hours);
  assert.equal((await api("manager", path, null)).status, 200);
  assert.equal((await (await desktop()).json()).schedule, null);
  // Leave a representative schedule in place for optional browser inspection.
  await api("manager", path, hours);
  await api("manager", path + "&userId=employee", partTime);
  if (!process.argv.includes("--serve")) {
    const removal = await fetch(base + "/api/auth/organization/remove-member", {
      method: "POST", headers: { cookie: cookies.manager, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ memberIdOrEmail: "employee@example.test", organizationId: "acme" }),
    });
    assert.equal(removal.status, 200, await removal.text());
    assert.equal((await (await desktop()).json()).schedule, null);
    const revoked = await fetch(base + "/api/tokens/" + deviceId, {
      method: "DELETE", headers: { cookie: cookies.employee, origin: base },
    });
    assert.equal(revoked.status, 200, await revoked.text());
    assert.equal((await desktop()).status, 401);
  }
  console.log("PASS: real Worker/D1 cookie permissions, cross-team isolation, team schedule, member override, reset, and device policy.");
  if (process.argv.includes("--serve")) {
    console.log(`Browser fixture: ${base}, manager@example.test or employee@example.test, password ${password}`);
    await new Promise((done) => server.on("exit", done));
  }
} catch (error) {
  console.error(log);
  throw error;
} finally {
  server.kill();
}
