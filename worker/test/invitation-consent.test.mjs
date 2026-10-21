import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";

async function fixture({ verified = true, approved = true, metadataStatus = 200, acceptStatus = 200, offline = false } = {}) {
  const html = await dashboardResponse().text();
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(["hidden"]);
      nodes.set(id, { textContent: "", disabled: false, className: "", classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
      } });
    }
    return nodes.get(id);
  }
  const location = new URL("https://clocked.test/?invitation=invite-1");
  const requests = [];
  let starts = 0;
  const context = {
    URL, URLSearchParams, location, $: node,
    history: { replaceState(_state, _unused, next) { location.href = new URL(next, location).href; } },
    document: { body: node("body") }, meEmail: "", show() {}, setMode() {},
    async startWorkspace() { starts++; },
    async api(url, init = {}) {
      requests.push({ url, init });
      if (url === "/api/me") return Response.json({ user: { emailVerified: verified, approved, email: "me@example.test" } });
      if (url.startsWith("/api/auth/organization/get-invitation")) return Response.json(metadataStatus === 200 ? {
        id: "invite-1", organizationName: "Acme <team>", role: "member", status: "pending",
      } : { message: "Invitation not found!" }, { status: metadataStatus });
      if (url === "/api/auth/organization/accept-invitation") {
        if (offline) throw new Error("Network unavailable");
        return Response.json(acceptStatus === 200 ? {} : { message: "This invitation expired." }, { status: acceptStatus });
      }
      throw new Error("Unexpected request: " + url);
    },
  };
  const login = script.slice(script.indexOf("async function afterLogin("), script.indexOf('if ($("resendVerifyGate"))'));
  const invites = script.slice(script.indexOf("function isManagerRoleC("), script.indexOf('$("operatorInviteKind").onchange'));
  runInNewContext(login + "\n" + invites, context);
  return { context, node, location, requests, starts: () => starts,
    posts: () => requests.filter(({ init }) => init.method === "POST") };
}

test("opening a verified team invitation asks for consent without accepting it", async () => {
  const f = await fixture();
  await f.context.afterLogin(false);
  assert.equal(f.posts().length, 0);
  assert.equal(f.starts(), 0);
  assert.equal(f.node("approvalGate").classList.contains("hidden"), false);
  assert.equal(f.node("teamInvitationDetails").classList.contains("hidden"), false);
  assert.equal(f.node("teamInvitationName").textContent, "Acme <team>");
  assert.equal(f.node("teamInvitationRole").textContent, "Worker");
  assert.match(await dashboardResponse().text(), /Earlier sessions stay private/);
});

test("only an explicit Accept invitation click posts acceptance and opens the dashboard", async () => {
  const f = await fixture();
  await f.context.afterLogin(false);
  await f.node("acceptTeamInvitation").onclick();
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].url, "/api/auth/organization/accept-invitation");
  assert.deepEqual(JSON.parse(f.posts()[0].init.body), { invitationId: "invite-1" });
  assert.equal(f.location.search, "");
  assert.equal(f.starts(), 1);
});

test("Not now leaves the invitation pending and lets an approved personal user continue", async () => {
  const f = await fixture();
  await f.context.afterLogin(false);
  await f.node("dismissTeamInvitation").onclick();
  assert.equal(f.posts().length, 0);
  assert.equal(f.location.search, "");
  assert.equal(f.starts(), 1);
});

test("Not now leaves a new account at the access gate", async () => {
  const f = await fixture({ approved: false });
  await f.context.afterLogin(false);
  await f.node("dismissTeamInvitation").onclick();
  assert.equal(f.posts().length, 0);
  assert.equal(f.starts(), 0);
  assert.equal(f.node("approvalGate").classList.contains("hidden"), false);
});

test("an acceptance failure retains the invitation and allows retry", async () => {
  const f = await fixture({ acceptStatus: 400 });
  await f.context.afterLogin(false);
  await f.node("acceptTeamInvitation").onclick();
  assert.equal(f.posts().length, 1);
  assert.equal(f.location.search, "?invitation=invite-1");
  assert.equal(f.starts(), 0);
  assert.equal(f.node("invitationMsg").textContent, "This invitation expired.");
  assert.equal(f.node("acceptTeamInvitation").disabled, false);
});

test("invalid metadata never offers acceptance and unverified accounts never load the invitation", async () => {
  const invalid = await fixture({ metadataStatus: 403 });
  await invalid.context.afterLogin(false);
  assert.equal(invalid.posts().length, 0);
  assert.equal(invalid.node("teamInvitationDetails").classList.contains("hidden"), true);
  assert.match(invalid.node("invitationMsg").textContent, /Invitation not found/);
  const unverified = await fixture({ verified: false });
  await unverified.context.afterLogin(false);
  assert.deepEqual(unverified.requests.map(({ url }) => url), ["/api/me"]);
  assert.equal(unverified.node("verifyGate").classList.contains("hidden"), false);
});

test("an offline acceptance keeps consent visible and preserves the pending invitation", async () => {
  const f = await fixture({ offline: true });
  await f.context.afterLogin(false);
  await f.node("acceptTeamInvitation").onclick();
  assert.equal(f.starts(), 0);
  assert.equal(f.location.search, "?invitation=invite-1");
  assert.equal(f.node("teamInvitationDetails").classList.contains("hidden"), false);
  assert.equal(f.node("acceptTeamInvitation").disabled, false);
  assert.equal(f.node("dismissTeamInvitation").disabled, false);
  assert.match(f.node("invitationMsg").textContent, /Check your connection/);
});
