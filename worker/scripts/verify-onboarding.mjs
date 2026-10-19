// Isolated local Worker/D1. No email credentials or production database access.
// --serve retains the fixture for browser inspection after the checks pass.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "clocked-onboarding-"));
const config = join(directory, "wrangler.json");
const state = join(directory, "state");
async function availablePort() {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", done); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local test port");
  const port = address.port;
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}
const port = process.env.CLOCKED_TEST_PORT ? Number(process.env.CLOCKED_TEST_PORT) : await availablePort();
const base = `http://localhost:${port}`;
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const password = "local-verification-password";
const operatorEmail = "ddusi@easytomanage.com";
writeFileSync(config, JSON.stringify({
  name: "clocked-onboarding-verification", main: resolve(root, "src/index.ts"),
  compatibility_date: "2026-07-01", compatibility_flags: ["nodejs_compat"],
  vars: { BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), REPORT_TZ: "UTC", MAIL_FROM: "local@example.test", MAIL_TO: "" },
  d1_databases: [{ binding: "DB", database_name: "clocked", database_id: "00000000-0000-0000-0000-000000000002", migrations_dir: resolve(root, "migrations") }],
}));
function wrangler(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--config", config, "--persist-to", state], {
    cwd: directory, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
wrangler(["d1", "migrations", "apply", "clocked", "--local"]);
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString("base64")}$${pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64")}`;
const sql = [];
for (const [id, email] of [["operator", operatorEmail], ["solo", "solo@example.test"]]) {
  sql.push(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${id}', '${id}', '${email}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
  sql.push(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('${id}', '${id}', 'credential', '${id}', '${hash}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
  sql.push(`INSERT INTO user_approval (userId, approvedAt) VALUES ('${id}', datetime('now'));`);
}
sql.push("INSERT INTO sessions (id, user_id, start_utc, end_utc, start_reason, end_reason) VALUES ('solo-session', 'solo', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'unlock', 'lock');");
const seed = join(directory, "seed.sql");
writeFileSync(seed, sql.join("\n"));
wrangler(["d1", "execute", "clocked", "--local", "--file", seed]);
let log = "";
const server = spawn(process.execPath, [cli, "dev", "--local", "--port", String(port), "--config", config, "--persist-to", state], {
  cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { log = (log + data).slice(-16000); });
process.on("exit", () => server.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const cookies = {};
async function api(actor, path, body) {
  return fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
    cookie: cookies[actor] || "", origin: base, "content-type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(actor, email) {
  const response = await api(actor, "/api/auth/sign-in/email", { email, password });
  assert.equal(response.status, 200, await response.clone().text());
  cookies[actor] = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
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
  assert.equal((await api("", "/api/request-access", { name: "Applicant", email: "applicant@example.test", kind: "individual" })).status, 503);
  assert.equal((await api("", "/api/request-access", { name: "Applicant", email: "invalid", kind: "team" })).status, 400);
  await login("operator", operatorEmail);
  await login("solo", "solo@example.test");
  assert.equal((await api("solo", "/api/admin/invite", { kind: "manager", email: "unauthorized@example.test", teamName: "Other" })).status, 403);
  assert.equal((await api("", "/api/auth/sign-up/email", { email: "uninvited@example.test", password, name: "Uninvited" })).status, 403);
  const created = await api("operator", "/api/admin/invite", { kind: "manager", email: "manager@example.test", teamName: "Independent team" });
  assert.equal(created.status, 200, await created.clone().text());
  const invitation = await created.json();
  assert.equal(invitation.emailSent, false);
  const invitationId = new URL(invitation.url).searchParams.get("invitation");
  const signedUp = await api("", "/api/auth/sign-up/email", { email: "manager@example.test", password, name: "Manager" });
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  cookies.manager = signedUp.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  assert.equal((await api("manager", "/api/token")).status, 403);
  assert.equal((await api("manager", "/api/auth/organization/accept-invitation", { invitationId })).status, 403);
  // Unit tests exercise the emailed verification token. This local fixture has
  // no sender configured, so mark only its test account verified through D1.
  wrangler(["d1", "execute", "clocked", "--local", "--command", "UPDATE user SET emailVerified = 1 WHERE email = 'manager@example.test'"]);
  await login("manager", "manager@example.test");
  const accepted = await api("manager", "/api/auth/organization/accept-invitation", { invitationId });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const me = await (await api("manager", "/api/me")).json();
  assert.equal(me.user.approved, true);
  assert.equal(me.orgs[0].role, "owner");
  assert.equal(me.orgs[0].name, "Independent team");
  assert.equal((await (await api("operator", "/api/me")).json()).orgs.length, 0);
  const organizationId = me.orgs[0].organizationId;
  const workerInvite = await api("manager", "/api/auth/organization/invite-member", { email: "solo@example.test", role: "member", organizationId });
  assert.equal(workerInvite.status, 200, await workerInvite.clone().text());
  const workerInvitation = await workerInvite.json();
  assert.equal((await api("solo", "/api/auth/organization/accept-invitation", { invitationId: workerInvitation.id })).status, 200);
  const solo = await (await api("solo", "/api/me")).json();
  assert.equal(solo.user.id, "solo");
  assert.equal(solo.orgs[0].role, "member");
  assert.equal(solo.orgs[0].organizationId, organizationId);
  assert.equal((await (await api("solo", "/api/hours?period=2026-10")).json()).totalMinutes, 60);
  assert.equal((await api("solo", "/api/auth/organization/invite-member", { email: "no@example.test", role: "member", organizationId })).status, 403);
  const individualInvite = await api("operator", "/api/admin/invite", { kind: "individual", email: "individual@example.test" });
  assert.equal(individualInvite.status, 200);
  const individualLink = (await individualInvite.json()).url;
  const individualId = new URL(individualLink).searchParams.get("individualInvitation");
  const individualSignup = await api("", "/api/auth/sign-up/email", { email: "individual@example.test", password, name: "Individual", callbackURL: new URL(individualLink).pathname + new URL(individualLink).search });
  assert.equal(individualSignup.status, 200, await individualSignup.clone().text());
  cookies.individual = individualSignup.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  assert.equal((await api("individual", "/api/invitations/individual/accept", { invitationId: individualId })).status, 403);
  wrangler(["d1", "execute", "clocked", "--local", "--command", "UPDATE user SET emailVerified = 1 WHERE email = 'individual@example.test'"]);
  // Remove only the cached user data, keeping the real session token. The next
  // request reads the test account's newly verified status from D1.
  cookies.individual = cookies.individual.split("; ").filter((cookie) => !cookie.includes("session_data=")).join("; ");
  assert.equal((await api("individual", "/api/invitations/individual/accept", { invitationId: individualId })).status, 200);
  const individualMe = await (await api("individual", "/api/me")).json();
  assert.equal(individualMe.user.approved, true);
  assert.equal(individualMe.operator, false);
  assert.equal(individualMe.orgs.length, 0);
  assert.equal((await api("individual", "/api/token")).status, 200);
  const delivery = { recipients: ["individual@example.test"], sendDay: 5, sendTime: "08:00", sendTimezone: "Europe/Berlin" };
  assert.equal((await api("individual", "/api/settings", delivery)).status, 200);
  assert.deepEqual(await (await api("individual", "/api/settings")).json(), { ...delivery, managed: false });
  assert.equal((await api("individual", "/api/admin/invite", { kind: "individual", email: "no@example.test" })).status, 403);
  assert.equal((await api("individual", "/api/team/create", { name: "Bypass" })).status, 403);
  assert.equal((await api("individual", "/api/auth/organization/create", { name: "Bypass", slug: "bypass" })).status, 403);
  const laterTeamInvite = await api("manager", "/api/auth/organization/invite-member", { email: "individual@example.test", role: "member", organizationId });
  assert.equal(laterTeamInvite.status, 200);
  const laterInviteId = (await laterTeamInvite.json()).id;
  assert.equal((await api("individual", "/api/auth/organization/accept-invitation", { invitationId: laterInviteId })).status, 200);
  assert.equal((await (await api("individual", "/api/me")).json()).orgs[0].organizationId, organizationId);
  console.log("PASS: invite-only signup, independent manager team, individual access and personal delivery, later team joining, recorded time intact, and invitation permissions.");
  if (process.argv.includes("--serve")) {
    console.log(`Browser fixture: ${base}, operator ${operatorEmail}, manager@example.test or solo@example.test, password ${password}`);
    await new Promise((done) => server.on("exit", done));
  }
} catch (error) {
  console.error(log);
  throw error;
} finally { server.kill(); }
