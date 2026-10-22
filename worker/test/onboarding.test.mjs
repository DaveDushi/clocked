import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAuth } from "../.tmp-test/auth-server.js";
import { handleAcceptIndividualInvitation, handleCreateInvitation, handleRequestAccess, hasPendingInvitation } from "../.tmp-test/onboarding.js";
import { isApproved } from "../.tmp-test/approval.js";
import { ADMIN_INBOX } from "../.tmp-test/email.js";
import { testDatabase } from "./helpers/database.mjs";

let fixtureNumber = 0;
function fixture(t) {
  const ip = `192.0.2.${++fixtureNumber}`;
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  const messages = [];
  const env = {
    DB, BETTER_AUTH_URL: "http://localhost:8787", BETTER_AUTH_SECRET: "test-secret-for-onboarding-at-least-32-chars",
    EMAIL_PROVIDER: "cloudflare", MAIL_FROM: "clocked@example.test",
    EMAIL: { async send(message) { messages.push(message); } },
  };
  const operator = { id: "operator", email: ADMIN_INBOX, emailVerified: true };
  sqlite.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Operator', ?, 1, ?, ?)")
    .run(operator.id, operator.email, new Date().toISOString(), new Date().toISOString());
  sqlite.exec("INSERT INTO user_approval (userId, approvedAt) VALUES ('operator', datetime('now'))");
  const auth = makeAuth(env);
  const call = (path, body, cookie = "") => auth.handler(new Request(env.BETTER_AUTH_URL + "/api/auth/" + path, {
    method: "POST", headers: { "content-type": "application/json", origin: env.BETTER_AUTH_URL, "x-forwarded-for": ip, cookie }, body: JSON.stringify(body),
  }));
  const inviteManager = (email, teamName = "Acme", actor = operator) => handleCreateInvitation(
    new Request(env.BETTER_AUTH_URL + "/api/admin/invite", {
      method: "POST", body: JSON.stringify({ kind: "manager", email, teamName }),
    }), env, actor,
  );
  const signup = (email) => call("sign-up/email", { email, password: "test-password-123", name: "Manager", callbackURL: "/?invitation=kept" });
  const inviteIndividual = (email, actor = operator) => handleCreateInvitation(
    new Request(env.BETTER_AUTH_URL + "/api/admin/invite", { method: "POST", body: JSON.stringify({ kind: "individual", email }) }), env, actor,
  );
  const acceptIndividual = (invitationId, user) => handleAcceptIndividualInvitation(
    new Request(env.BETTER_AUTH_URL + "/api/invitations/individual/accept", { method: "POST", body: JSON.stringify({ invitationId }) }), env, user,
  );
  return { env, sqlite, messages, operator, auth, call, inviteManager, signup, inviteIndividual, acceptIndividual };
}

function cookieFrom(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

test("signup requires a pending, unexpired invitation for the exact email", async (t) => {
  const { signup, inviteManager, sqlite, env } = fixture(t);
  assert.equal((await signup("stranger@example.test")).status, 403);
  assert.equal((await inviteManager("Invited@example.test")).status, 200);
  assert.equal(await hasPendingInvitation(env, "INVITED@example.test"), true);
  assert.equal((await signup("other@example.test")).status, 403);
  sqlite.exec("UPDATE invitation SET expiresAt = '2000-01-01T00:00:00.000Z'");
  assert.equal((await signup("invited@example.test")).status, 403);
  sqlite.exec("UPDATE invitation SET expiresAt = '2099-01-01T00:00:00.000Z', status = 'canceled'");
  assert.equal((await signup("invited@example.test")).status, 403);
  sqlite.exec("UPDATE invitation SET status = 'pending'");
  const response = await signup("invited@example.test");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE email != ?").get(ADMIN_INBOX).n, 1);
});

test("operator invites an independent owner who verifies, accepts, then invites workers", async (t) => {
  const { env, sqlite, messages, auth, call, inviteManager, signup } = fixture(t);
  const invitation = await (await inviteManager("manager@example.test", "Acme")).json();
  const id = new URL(invitation.url).searchParams.get("invitation");
  assert.equal(invitation.emailSent, true);
  assert.equal(messages[0].to[0], "manager@example.test");
  assert.match(messages[0].text, /manage Acme/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member").get().n, 0);
  const signedUp = await signup("manager@example.test");
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const { user } = await signedUp.json();
  let cookie = cookieFrom(signedUp);
  const detailsRequest = () => auth.handler(new Request(env.BETTER_AUTH_URL + "/api/auth/organization/get-invitation?id=" + id, { headers: { cookie } }));
  assert.equal((await detailsRequest()).status, 403);
  assert.equal((await call("organization/accept-invitation", { invitationId: id }, cookie)).status, 403);
  assert.equal((await call("organization/create", { name: "Bypass", slug: "bypass" }, cookie)).status, 403);
  const verificationEmail = messages.find((message) => message.subject === "Verify your clocked email");
  const verificationUrl = verificationEmail.text.split("\n").find((line) => line.startsWith("http"));
  assert.match(new URL(verificationUrl).searchParams.get("callbackURL"), /invitation=kept/);
  const verified = await auth.handler(new Request(verificationUrl, { headers: { cookie } }));
  assert.equal(verified.status, 302);
  cookie = cookieFrom(verified) || cookie;
  for (const [invalidate, restore] of [
    ["UPDATE invitation SET email = 'someone-else@example.test'", "UPDATE invitation SET email = 'manager@example.test'"],
    ["UPDATE invitation SET expiresAt = '2000-01-01'", "UPDATE invitation SET expiresAt = '2099-01-01'"],
    ["UPDATE invitation SET status = 'canceled'", "UPDATE invitation SET status = 'pending'"],
    ["UPDATE invitation SET role = 'member'", "UPDATE invitation SET role = 'owner'"],
    ["UPDATE user SET email = 'former-operator@example.test' WHERE id = 'operator'", "UPDATE user SET email = '" + ADMIN_INBOX + "' WHERE id = 'operator'"],
    ["UPDATE user_approval SET approvedAt = NULL WHERE userId = 'operator'", "UPDATE user_approval SET approvedAt = datetime('now') WHERE userId = 'operator'"],
  ]) {
    sqlite.exec(invalidate);
    assert.notEqual((await detailsRequest()).status, 200, invalidate);
    sqlite.exec(restore);
  }
  const details = await detailsRequest();
  assert.equal(details.status, 200, await details.clone().text());
  assert.equal((await details.json()).organizationName, "Acme");
  const accepted = await call("organization/accept-invitation", { invitationId: id }, cookie);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(await isApproved(env, user.id), true);
  const membership = sqlite.prepare("SELECT m.role, o.name, o.metadata FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ?").get(user.id);
  assert.equal(membership.role, "owner");
  assert.equal(membership.name, "Acme");
  assert.deepEqual(JSON.parse(membership.metadata), { plan: "team" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member WHERE userId = 'operator'").get().n, 0);
  const { organizationId } = sqlite.prepare("SELECT organizationId FROM invitation WHERE id = ?").get(id);
  const workerInvite = await call("organization/invite-member", { email: "worker@example.test", role: "member", organizationId }, cookie);
  assert.equal(workerInvite.status, 200, await workerInvite.clone().text());
  const workerInvitation = await workerInvite.json();
  assert.equal((await call("organization/accept-invitation", { invitationId: workerInvitation.id }, cookie)).status, 403);
  const workerSignup = await signup("worker@example.test");
  assert.equal(workerSignup.status, 200);
  const worker = (await workerSignup.json()).user;
  const workerCookie = cookieFrom(workerSignup);
  const workerMail = messages.filter((message) => message.subject === "Verify your clocked email").at(-1);
  const workerVerifyUrl = workerMail.text.split("\n").find((line) => line.startsWith("http"));
  const workerVerified = await auth.handler(new Request(workerVerifyUrl, { headers: { cookie: workerCookie } }));
  const workerSession = cookieFrom(workerVerified) || workerCookie;
  const workerDetails = () => auth.handler(new Request(env.BETTER_AUTH_URL + "/api/auth/organization/get-invitation?id=" + workerInvitation.id, { headers: { cookie: workerSession } }));
  assert.equal((await workerDetails()).status, 200);
  sqlite.prepare("DELETE FROM member WHERE userId = ?").run(user.id);
  const removedSender = await workerDetails();
  assert.equal(removedSender.status, 400);
  assert.equal((await removedSender.json()).code, "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION");
  sqlite.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)")
    .run(crypto.randomUUID(), organizationId, user.id, new Date().toISOString());
  assert.equal((await call("organization/accept-invitation", { invitationId: workerInvitation.id }, workerSession)).status, 200);
  assert.equal(await isApproved(env, worker.id), true);
  assert.equal(sqlite.prepare("SELECT role FROM member WHERE userId = ?").get(worker.id).role, "member");
  assert.equal((await call("organization/invite-member", { email: "other@example.test", role: "member", organizationId }, workerSession)).status, 403);
});

test("manager invitation endpoint rejects other users and preserves link when email fails", async (t) => {
  const { inviteManager, env, sqlite, operator } = fixture(t);
  assert.equal((await inviteManager("person@example.test", "Team", { ...operator, email: "other@example.test" })).status, 403);
  assert.equal((await inviteManager("person@example.test", "Team", { ...operator, emailVerified: false })).status, 403);
  assert.equal((await inviteManager("invalid", "Team")).status, 400);
  assert.equal((await inviteManager("person@example.test", " ")).status, 400);
  env.EMAIL.send = async () => { throw new Error("provider offline"); };
  const result = await (await inviteManager("person@example.test")).json();
  assert.equal(result.emailSent, false);
  const id = new URL(result.url).searchParams.get("invitation");
  assert.equal(sqlite.prepare("SELECT email FROM invitation WHERE id = ?").get(id).email, "person@example.test");
});

test("social account creation also requires an invitation", async (t) => {
  const { auth, inviteManager } = fixture(t);
  const { internalAdapter } = await auth.$context;
  const user = { name: "Google user", email: "google@example.test", emailVerified: true };
  const account = { providerId: "google", accountId: "google-account" };
  await assert.rejects(internalAdapter.createOAuthUser(user, account), /invite-only/);
  await inviteManager(user.email);
  const created = await internalAdapter.createOAuthUser(user, account);
  assert.equal(created.user.email, "google@example.test");
  assert.equal(created.account.providerId, "google");
});

test("individual invitation verifies and approves access without creating a team", async (t) => {
  const { env, sqlite, messages, auth, call, signup, inviteIndividual, acceptIndividual } = fixture(t);
  const invitation = await (await inviteIndividual("Individual@example.test")).json();
  const id = new URL(invitation.url).searchParams.get("individualInvitation");
  assert.equal(invitation.emailSent, true);
  assert.deepEqual(messages[0].to, ["individual@example.test"]);
  assert.match(messages[0].text, /without a team/);
  const signedUp = await signup("individual@example.test");
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const { user } = await signedUp.json();
  assert.equal((await acceptIndividual(id, user)).status, 403);
  assert.equal(await isApproved(env, user.id), false);
  const verificationUrl = messages.find((mail) => mail.subject === "Verify your clocked email").text.split("\n").find((line) => line.startsWith("http"));
  const verified = await auth.handler(new Request(verificationUrl, { headers: { cookie: cookieFrom(signedUp) } }));
  assert.equal(verified.status, 302);
  const cookie = cookieFrom(verified);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.equal(session.user.emailVerified, true);
  assert.equal((await acceptIndividual(id, session.user)).status, 200);
  assert.equal(await isApproved(env, user.id), true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM organization").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member").get().n, 0);
  assert.equal(await hasPendingInvitation(env, user.email), false);
  const acceptedAt = sqlite.prepare("SELECT acceptedAt FROM individual_invitation WHERE id = ?").get(id).acceptedAt;
  assert.equal(typeof acceptedAt, "string");
  assert.equal((await acceptIndividual(id, session.user)).status, 200);
  assert.equal(sqlite.prepare("SELECT acceptedAt FROM individual_invitation WHERE id = ?").get(id).acceptedAt, acceptedAt);
  assert.equal((await call("organization/create", { name: "Uninvited team", slug: "uninvited-team" }, cookie)).status, 403);
});

test("individual invites reject unauthorized senders, wrong recipients and expired links", async (t) => {
  const { env, sqlite, operator, signup, inviteIndividual, acceptIndividual } = fixture(t);
  assert.equal((await inviteIndividual("person@example.test", { ...operator, email: "other@example.test" })).status, 403);
  assert.equal((await inviteIndividual("person@example.test", { ...operator, emailVerified: false })).status, 403);
  assert.equal((await inviteIndividual("bad-email")).status, 400);
  const invitation = await (await inviteIndividual("person@example.test")).json();
  const id = new URL(invitation.url).searchParams.get("individualInvitation");
  const user = (await (await signup("person@example.test")).json()).user;
  assert.equal((await acceptIndividual(id, operator)).status, 403);
  sqlite.prepare("UPDATE individual_invitation SET expiresAt = '2000-01-01' WHERE id = ?").run(id);
  assert.equal((await acceptIndividual(id, { ...user, emailVerified: true })).status, 403);
  assert.equal(await isApproved(env, user.id), false);
  assert.equal(await hasPendingInvitation(env, user.email), false);
  const expired = await (await inviteIndividual("expired@example.test")).json();
  sqlite.prepare("UPDATE individual_invitation SET expiresAt = '2000-01-01' WHERE id = ?").run(new URL(expired.url).searchParams.get("individualInvitation"));
  assert.equal((await signup("expired@example.test")).status, 403);
});

test("failed individual acceptance rolls back approval and can be retried", async (t) => {
  const { env, sqlite, signup, inviteIndividual, acceptIndividual } = fixture(t);
  const invitation = await (await inviteIndividual("retry@example.test")).json();
  const id = new URL(invitation.url).searchParams.get("individualInvitation");
  const signedUp = await signup("retry@example.test");
  const user = { ...(await signedUp.json()).user, emailVerified: true };
  sqlite.exec(`CREATE TRIGGER reject_acceptance BEFORE UPDATE ON individual_invitation BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  await assert.rejects(acceptIndividual(id, user), /test failure/);
  assert.equal(await isApproved(env, user.id), false);
  assert.equal(await hasPendingInvitation(env, user.email), true);
  sqlite.exec("DROP TRIGGER reject_acceptance");
  assert.equal((await acceptIndividual(id, user)).status, 200);
  assert.equal(await isApproved(env, user.id), true);
});

test("public individual and team requests email the operator without granting access", async (t) => {
  const { env, sqlite, messages, signup } = fixture(t);
  for (const kind of ["individual", "team"]) {
    const response = await handleRequestAccess(new Request("http://localhost:8787/api/request-access", {
      method: "POST", body: JSON.stringify({ name: "Alex <Applicant>", email: "applicant@example.test", kind, company: "Acme", teamSize: "12", message: "I'd like to try Clocked." }),
    }), env);
    assert.equal(response.status, 200);
    const email = messages.at(-1);
    assert.deepEqual(email.to, [ADMIN_INBOX]);
    assert.equal(email.replyTo, "applicant@example.test");
    assert.equal(email.subject, "Clocked access request - Alex <Applicant>");
    assert.match(email.text, new RegExp(`Access: ${kind === "team" ? "Team" : "Individual"}`));
    assert.match(email.text, /I'd like to try Clocked/);
    assert.match(email.html, /Alex &lt;Applicant&gt;/);
    assert.equal(await hasPendingInvitation(env, "applicant@example.test"), false);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user").get().n, 1);
  assert.equal((await signup("applicant@example.test")).status, 403);
});

test("access requests reject invalid data and report email delivery failures", async (t) => {
  const { env, messages } = fixture(t);
  const send = (body) => handleRequestAccess(new Request("http://localhost:8787/api/request-access", { method: "POST", body: JSON.stringify(body) }), env);
  const request = { name: "Alex", email: "alex@example.test", kind: "individual" };
  assert.equal((await send({ ...request, email: "bad-email" })).status, 400);
  assert.equal((await send({ ...request, kind: "admin" })).status, 400);
  assert.equal(messages.length, 0);
  env.EMAIL.send = async () => { throw new Error("offline"); };
  assert.equal((await send(request)).status, 503);
});
