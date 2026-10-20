// Isolated local Worker/D1 with fixture accounts for the Timesheets and Stats workspace.
// Email uses the local send_email binding, which only writes messages to temp files.
// --serve keeps the fixture running for browser checks after the API checks pass.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "clocked-dashboard-"));
const config = join(directory, "wrangler.json");
const state = join(directory, "state");
const port = Number(process.env.CLOCKED_TEST_PORT || 8793);
const base = `http://localhost:${port}`;
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const password = "local-verification-password";
writeFileSync(config, JSON.stringify({
  name: "clocked-dashboard-verification", main: resolve(root, "src/index.ts"),
  compatibility_date: "2026-07-01", compatibility_flags: ["nodejs_compat"],
  vars: { BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), REPORT_TZ: "UTC", MAIL_FROM: "local@example.test", MAIL_TO: "", EMAIL_PROVIDER: "cloudflare" },
  send_email: [{ name: "EMAIL" }],
  d1_databases: [{ binding: "DB", database_name: "clocked", database_id: "00000000-0000-0000-0000-000000000003", migrations_dir: resolve(root, "migrations") }],
}));
function wrangler(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--config", config, "--persist-to", state], {
    cwd: directory, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

// ---- fixture ----
const people = [
  ["manager", "Morgan Hale", "manager@example.test", "owner"],
  ["ana", "Ana Ruiz", "ana@example.test", "member"],
  ["ben", "Ben Okafor", "ben@example.test", "member"],
  ["cy", "Cy Lindqvist", "cy@example.test", "member"],
  ["dee", "Dee Park", "dee@example.test", "admin"],
];
const others = [["solo", "Sam Solo", "solo@example.test"], ["outsider", "Otto Side", "outsider@example.test"]];
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString("base64")}$${pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64")}`;
const sql = [];
for (const [id, name, email] of [...people, ...others]) {
  sql.push(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${id}', '${name}', '${email}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
  sql.push(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('${id}', '${id}', 'credential', '${id}', '${hash}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
  sql.push(`INSERT INTO user_approval (userId, approvedAt) VALUES ('${id}', datetime('now'));`);
}
sql.push(`INSERT INTO organization (id, name, slug, createdAt, metadata) VALUES ('team', 'Northwind Studio', 'northwind', '2026-01-01T00:00:00Z', '{"plan":"team"}'), ('other', 'Other Co', 'other-co', '2026-01-01T00:00:00Z', '{"plan":"team"}');`);
people.forEach(([id, , , role], i) => sql.push(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-${id}', 'team', '${id}', '${role}', '2026-01-0${i + 1}T00:00:00Z');`));
sql.push(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-outsider', 'other', 'outsider', 'owner', '2026-01-01T00:00:00Z');`);
sql.push(`INSERT INTO org_settings (organizationId, mail_to, send_day, send_time, send_timezone) VALUES ('team', 'payroll@example.test', 1, '09:00', 'Europe/Berlin');`);
sql.push(`INSERT INTO user_settings (userId, send_timezone) VALUES ('solo', 'Europe/Berlin');`);

// Berlin is UTC+2 for every fixture date (before the October 25 change).
const utc = (date, clock) => { const [h, m] = clock.split(":").map(Number); const d = new Date(`${date}T00:00:00Z`); d.setUTCMinutes(h * 60 + m - 120); return d.toISOString(); };
const weekdays = (period, last) => Array.from({ length: last }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`)
  .filter((date) => { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return day > 0 && day < 6; });
const nextDay = (date) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
let n = 0;
const session = (user, date, start, end, endReason = "lock", startReason = "unlock", endDate = date) => {
  sql.push(`INSERT INTO sessions (id, user_id, start_utc, end_utc, start_reason, end_reason, timezone) VALUES ('seed-${user}-${++n}', '${user}', '${utc(date, start)}', '${utc(endDate, end)}', '${startReason}', ${endReason === null ? "NULL" : `'${endReason}'`}, 'Europe/Berlin');`);
};
for (const [period, last] of [["2026-09", 30], ["2026-10", 16]]) {
  weekdays(period, last).forEach((date, i) => {
    session("manager", date, "08:45", "12:30", "suspend", "resume");
    session("manager", date, "13:00", "17:15");
    session("ana", date, "09:00", "10:45", "idle");
    session("ana", date, "11:00", "12:30", "manual", "manual");
    session("ana", date, "13:15", "17:30");
    if (i % 3 !== 2) {
      session("ben", date, "09:30", "12:00");
      session("ben", date, "13:00", "18:00", "shutdown");
    }
    session("cy", date, "08:00", "12:00", "idle");
    session("cy", date, "09:00", "12:00", "quit", "start"); // a second computer, counted once
    if (i % 2) session("cy", date, "12:20", "16:30");
    else session("cy", date, "12:00", "16:00");
    if (i === 3) session("dee", date, "20:00", "01:30", "lock", "unlock", nextDay(date));
    else if (i % 4 === 1) session("dee", date, "10:00", "15:00", null);
    else { session("dee", date, "09:15", "12:00", "crash"); session("dee", date, "12:40", "17:00"); }
    const hours = [2.5, 4.5, 6.25, 8.5, 9.25, 5][i % 6];
    const end = 8 * 60 + Math.round(hours * 60) + (i % 2 ? 30 : 0);
    if (i % 2) { session("solo", date, "08:00", "11:00", "idle"); session("solo", date, "11:30", `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`); }
    else session("solo", date, "08:00", `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`);
  });
}
session("outsider", "2026-09-01", "09:00", "17:00");

wrangler(["d1", "migrations", "apply", "clocked", "--local"]);
const seed = join(directory, "seed.sql");
writeFileSync(seed, sql.join("\n"));
wrangler(["d1", "execute", "clocked", "--local", "--file", seed]);

let log = "";
const server = spawn(process.execPath, [cli, "dev", "--local", "--port", String(port), "--config", config, "--persist-to", state], {
  cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { log = (log + data).slice(-20000); });
process.on("exit", () => server.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const cookies = {};
async function api(actor, path, body, method, origin = base) {
  return fetch(base + path, { method: method || (body === undefined ? "GET" : "POST"), headers: {
    cookie: cookies[actor] || "", ...(origin ? { origin } : {}), "content-type": "application/json",
    // A distinct local address per fixture account keeps better-auth's sign-in limit per person.
    "x-forwarded-for": "10.0.0." + (Object.keys(cookies).indexOf(actor) + 2),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(actor, email) {
  cookies[actor] = "";
  const response = await api(actor, "/api/auth/sign-in/email", { email, password });
  assert.equal(response.status, 200, await response.clone().text());
  cookies[actor] = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
try {
  let ready = false;
  for (let i = 0; i < 160; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(base + "/health")).ok; } catch {}
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, "Local Worker did not start: " + log);
  for (const [actor, email] of [["manager", "manager@example.test"], ["ana", "ana@example.test"], ["solo", "solo@example.test"], ["outsider", "outsider@example.test"]]) {
    await login(actor, email);
  }

  // Workers and other teams cannot read or send this team's timesheets.
  assert.equal((await api("ana", "/api/team/overview?organizationId=team&period=2026-09")).status, 403);
  assert.equal((await api("ana", "/api/team/send?organizationId=team", { period: "2026-09", userIds: ["ana"] })).status, 403);
  assert.equal((await api("ana", "/api/manual-session", { id: "seed-ana-1", date: "2026-09-01", start: "09:00", end: "10:00" }, "PATCH")).status, 403);
  assert.equal((await api("outsider", "/api/team/overview?organizationId=team&period=2026-09")).status, 403);
  assert.equal((await api("outsider", "/api/team/manual-session?organizationId=team&userId=ana", { date: "2026-09-02", start: "09:00", end: "10:00" })).status, 403);
  // Same-origin protection still applies to the new mutating endpoint.
  assert.equal((await api("manager", "/api/team/send?organizationId=team", { period: "2026-09", userIds: ["ana"] }, "POST", "https://evil.example")).status, 403);

  const overview = await (await api("manager", "/api/team/overview?organizationId=team&period=2026-09")).json();
  assert.deepEqual(overview.members.map((m) => m.name), ["Ana Ruiz", "Ben Okafor", "Cy Lindqvist", "Dee Park", "Morgan Hale"]);
  const byName = Object.fromEntries(overview.members.map((m) => [m.name, m]));
  assert.equal(byName["Ana Ruiz"].stats.recordedDays, 22);
  assert.equal(byName["Ana Ruiz"].stats.breaksPerDay, 2);
  assert.equal(byName["Ana Ruiz"].stats.avgBreakMinutes, 60);
  assert.ok(byName["Ben Okafor"].stats.recordedDays < 22);
  assert.equal(byName["Cy Lindqvist"].stats.breaksPerDay, 0.5, "overlapping computers do not create breaks");
  assert.ok(Number.isFinite(overview.team.avgBreakMinutes) && overview.median.members === 5);
  const cross = byName["Dee Park"].days.find((d) => d.date === "2026-09-04");
  assert.ok(cross && cross.start === "20:00" && cross.end === "00:00", "cross-midnight session splits at local midnight");

  // Session edits go through the manager endpoint and show up in the overview.
  const anaMonth = await (await api("manager", "/api/team/hours?organizationId=team&userId=ana&period=2026-09")).json();
  const first = anaMonth.sessions.find((s) => s.date === "2026-09-01" && s.start === "09:00");
  const edit = await api("manager", "/api/team/manual-session?organizationId=team&userId=ana", { id: first.id, date: "2026-09-01", start: "09:00", end: "11:00" }, "PATCH");
  assert.equal(edit.status, 200, await edit.clone().text());
  const after = await (await api("manager", "/api/team/overview?organizationId=team&period=2026-09")).json();
  const ana = after.members.find((m) => m.id === "ana");
  assert.equal(ana.enteredSessions, 1);
  assert.equal(ana.days[0].breakCount, 1);
  assert.equal(ana.stats.workedMinutes, byName["Ana Ruiz"].stats.workedMinutes + 15);

  // Bulk send: refuses outsiders, then sends exactly the reviewed selection through the local mock binding.
  assert.equal((await api("manager", "/api/team/send?organizationId=team", { period: "2026-09", userIds: ["ana", "outsider"] })).status, 403);
  assert.equal((await api("manager", "/api/team/send?organizationId=team", { period: "2026-09", userIds: [] })).status, 400);
  const sent = await api("manager", "/api/team/send?organizationId=team", { period: "2026-09", userIds: ["ana", "ben"] });
  const sentBody = await sent.json();
  assert.equal(sent.status, 200, JSON.stringify(sentBody) + log.slice(-3000));
  assert.deepEqual(sentBody.recipients, ["payroll@example.test"]);
  assert.deepEqual(sentBody.results.map((r) => [r.userId, r.ok]), [["ana", true], ["ben", true]]);
  assert.match(log, /send_email binding called/);

  const solo = await (await api("solo", "/api/hours?period=2026-09")).json();
  assert.equal(solo.stats.recordedDays, 22);
  assert.ok(solo.recordedDays.every((d) => Number.isFinite(d.breakMinutes)));
  assert.equal((await api("solo", "/api/team/overview?organizationId=team&period=2026-09")).status, 403);

  console.log("PASS: team overview, normalized break stats, role boundaries, session edits and reviewed bulk send (mock email binding).");
  if (process.argv.includes("--serve")) {
    console.log(`Browser fixture: ${base}  manager@example.test (team owner), ana@example.test (worker), solo@example.test (personal); password ${password}`);
    await new Promise((done) => server.on("exit", done));
  }
} catch (error) {
  console.error(log);
  throw error;
} finally { server.kill(); }
