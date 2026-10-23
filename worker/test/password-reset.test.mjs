import assert from "node:assert/strict";
import { test } from "node:test";
import { pbkdf2Sync } from "node:crypto";
import { runInNewContext } from "node:vm";
import { makeAuth } from "../.tmp-test/auth-server.js";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { testDatabase } from "./helpers/database.mjs";

let fixtureNumber = 0;
function backend(t) {
  const ip = `192.0.2.${++fixtureNumber}`;
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  const messages = [];
  const base = "http://localhost:8787";
  const auth = makeAuth({ DB, BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: "password-reset-test-secret-at-least-32-characters",
    EMAIL_PROVIDER: "cloudflare", MAIL_FROM: "clocked@example.test",
    EMAIL: { async send(message) { messages.push(message); } } });
  const salt = Buffer.alloc(16, 1);
  const hash = `pbkdf2$100000$${salt.toString("base64")}$${pbkdf2Sync("original-password", salt, 100000, 32, "sha256").toString("base64")}`;
  sqlite.exec("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('reset-user', 'User', 'user@example.test', 1, datetime('now'), datetime('now'))");
  sqlite.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('account', 'reset-user', 'credential', 'reset-user', ?, datetime('now'), datetime('now'))").run(hash);
  const call = (path, body, cookie = "") => auth.handler(new Request(base + "/api/auth/" + path, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-forwarded-for": ip, cookie }, body: JSON.stringify(body),
  }));
  return { auth, base, call, messages, sqlite };
}

test("reset email leads to a single-use password change and revokes old sessions", async (t) => {
  const { auth, base, call, messages } = backend(t);
  const signedIn = await call("sign-in/email", { email: "user@example.test", password: "original-password" });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const redirectTo = base + "/?individualInvitation=kept&reset=1";
  const requested = await call("request-password-reset", { email: "user@example.test", redirectTo });
  assert.equal(requested.status, 200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, "Reset your clocked password");
  const emailURL = messages[0].text.split("\n").find((line) => line.startsWith("http"));
  const callback = await auth.handler(new Request(emailURL));
  assert.equal(callback.status, 302);
  const landing = new URL(callback.headers.get("location"));
  assert.equal(landing.searchParams.get("individualInvitation"), "kept");
  assert.equal(landing.searchParams.get("reset"), "1");
  const token = landing.searchParams.get("token");
  assert.ok(token);
  assert.equal((await call("reset-password", { token, newPassword: "short" })).status, 400);
  assert.equal((await call("reset-password", { token, newPassword: "replacement-password" })).status, 200);
  assert.equal((await call("sign-in/email", { email: "user@example.test", password: "original-password" })).status, 401);
  assert.equal((await call("sign-in/email", { email: "user@example.test", password: "replacement-password" })).status, 200);
  assert.equal((await call("reset-password", { token, newPassword: "another-password" })).status, 400);
  const session = await auth.handler(new Request(base + "/api/auth/get-session?disableCookieCache=true", { headers: { cookie } }));
  assert.equal(await session.json(), null);
});

test("unknown emails get the same response and expired reset links cannot change passwords", async (t) => {
  const { auth, base, call, messages, sqlite } = backend(t);
  const body = { email: "user@example.test", redirectTo: base + "/?reset=1" };
  const known = await call("request-password-reset", body);
  const unknown = await call("request-password-reset", { ...body, email: "unknown@example.test" });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(await unknown.json(), await known.json());
  assert.equal(messages.length, 1);
  const emailURL = messages[0].text.split("\n").find((line) => line.startsWith("http"));
  const token = new URL(emailURL).pathname.split("/").at(-1);
  sqlite.exec("UPDATE verification SET expiresAt = '2000-01-01T00:00:00.000Z'");
  const expired = await auth.handler(new Request(emailURL));
  assert.equal(new URL(expired.headers.get("location")).searchParams.get("error"), "INVALID_TOKEN");
  assert.equal((await call("reset-password", { token, newPassword: "replacement-password" })).status, 400);
});

async function ui(search = "", respond = async () => Response.json({ status: true })) {
  const html = await dashboardResponse().text();
  const script = html.split("<script>")[1].split("</script>")[0];
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: "", textContent: "", className: "", disabled: false,
        classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v),
          toggle(v, on) { if (on) classes.add(v); else classes.delete(v); } },
        setAttribute() {}, focus() {}, addEventListener() {}, querySelector: () => node(id + "-backdrop"),
        checkValidity() { return this.value.includes("@"); } });
    }
    return nodes.get(id);
  }
  let location = new URL("http://localhost:8787/" + search);
  const requests = [];
  const context = { URL, URLSearchParams, get location() { return location; },
    history: { replaceState(_state, _title, url) { location = new URL(url, location); } },
    $: node, document: { querySelectorAll: () => [], querySelector: () => node("backdrop"), addEventListener() {} },
    setTimeout(fn) { fn(); }, show() {}, afterLogin() {},
    async api(path, opts) { requests.push({ path, body: opts?.body && JSON.parse(opts.body) }); return respond(path, opts); },
  };
  runInNewContext(script.slice(script.indexOf("// ---- auth mode"), script.indexOf("async function afterLogin(")), context);
  return { context, node, requests, location: () => location };
}

test("forgot-password button sends the email with invitation context and restores sign-in", async () => {
  const f = await ui("?invitation=kept");
  f.context.openAuth("signin");
  assert.equal(f.node("forgotPassword").classList.contains("hidden"), false);
  f.node("forgotPassword").onclick();
  assert.equal(f.node("passwordField").classList.contains("hidden"), true);
  await f.node("authBtn").onclick();
  assert.equal(f.requests.length, 0);
  f.node("email").value = "user@example.test";
  await f.node("authBtn").onclick();
  assert.deepEqual(f.requests[0], { path: "/api/auth/request-password-reset", body: {
    email: "user@example.test", redirectTo: "http://localhost:8787/?invitation=kept&reset=1",
  } });
  assert.match(f.node("authMsg").textContent, /If an account exists/);
  f.node("backToSignin").onclick();
  assert.equal(f.node("authBtn").textContent, "Sign in");
});

test("email callback opens reset form, validates password and clears the used token", async () => {
  const f = await ui("?invitation=kept&reset=1&token=reset-token");
  await f.context.init();
  assert.equal(f.node("authBtn").textContent, "Reset password");
  assert.equal(f.node("emailField").classList.contains("hidden"), true);
  f.node("password").value = "short";
  await f.node("authBtn").onclick();
  assert.equal(f.requests.length, 0);
  f.node("password").value = "replacement-password";
  await f.node("authBtn").onclick();
  assert.deepEqual(f.requests[0], { path: "/api/auth/reset-password", body: { token: "reset-token", newPassword: "replacement-password" } });
  assert.equal(f.node("authBtn").textContent, "Sign in");
  assert.equal(f.node("password").value, "");
  assert.equal(f.location().search, "?invitation=kept");
  assert.match(f.node("authMsg").textContent, /Password reset/);
});

test("expired links and failed network requests let users try again", async () => {
  const expired = await ui("?reset=1&error=INVALID_TOKEN");
  await expired.context.init();
  assert.equal(expired.node("authBtn").textContent, "Send reset link");
  assert.match(expired.node("authMsg").textContent, /expired/);
  const rejected = await ui("?reset=1&token=used", async () => Response.json({ code: "INVALID_TOKEN" }, { status: 400 }));
  await rejected.context.init();
  rejected.node("password").value = "replacement-password";
  await rejected.node("authBtn").onclick();
  assert.equal(rejected.node("authBtn").textContent, "Send reset link");
  assert.match(rejected.node("authMsg").textContent, /expired/);
  const offline = await ui("", async () => { throw new Error("offline"); });
  offline.context.openAuth("forgot");
  offline.node("email").value = "user@example.test";
  await offline.node("authBtn").onclick();
  assert.equal(offline.node("authBtn").disabled, false);
  assert.match(offline.node("authMsg").textContent, /Check your connection/);
});
