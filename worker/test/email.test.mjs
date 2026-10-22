import assert from "node:assert/strict";
import { test } from "node:test";
import { sendEmail } from "../.tmp-test/email-provider.js";
import { sendAuthEmail, sendAccessRequest, buildAndSendReport, ADMIN_INBOX } from "../.tmp-test/email.js";
import { testDatabase } from "./helpers/database.mjs";

const message = {
  to: ["alice@example.test", "bob@example.test"],
  subject: "Monthly hours", text: "Hello", html: "<p>Hello</p>",
  replyTo: "manager@example.test",
  attachments: [{ filename: "hours.csv", contentType: "text/csv; charset=utf-8", content: new TextEncoder().encode("Jörg,8\n") }],
};
const sender = { MAIL_FROM: "reports@example.test" };

function captureFetch(t, status = 200) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    requests.push({ request, body: await request.json() });
    return new Response('{}', { status });
  });
  return requests;
}

test("default Resend preserves recipients, reply-to and UTF-8 attachments", async (t) => {
  const requests = captureFetch(t);
  assert.deepEqual(await sendEmail({ ...sender, RESEND_API_KEY: "test-key" }, message), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.url, "https://api.resend.com/emails");
  assert.equal(requests[0].request.headers.get("authorization"), "Bearer test-key");
  assert.deepEqual(requests[0].body, {
    from: "clocked <reports@example.test>", to: ["alice@example.test", "bob@example.test"],
    subject: "Monthly hours", text: "Hello", html: "<p>Hello</p>", reply_to: "manager@example.test",
    attachments: [{ filename: "hours.csv", content: "SsO2cmcsOAo=", content_type: "text/csv; charset=utf-8" }],
  });
});

test("Cloudflare submits each recipient separately with sender and attachment metadata", async (t) => {
  const requests = captureFetch(t);
  const messages = [];
  const env = { ...sender, EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(value) { messages.push(value); return { messageId: "id" }; } } };
  assert.deepEqual(await sendEmail(env, message), { ok: true });
  assert.equal(requests.length, 0);
  assert.deepEqual(messages, ["alice@example.test", "bob@example.test"].map((recipient) => ({
    from: { email: "reports@example.test", name: "clocked" },
    to: [recipient], subject: "Monthly hours",
    text: "Hello", html: "<p>Hello</p>", replyTo: "manager@example.test",
    attachments: [{ filename: "hours.csv", content: "SsO2cmcsOAo=", type: "text/csv; charset=utf-8", disposition: "attachment" }],
  })));
});

for (const rejected of ["alice@example.test", "bob@example.test"]) {
  test(`Cloudflare attempts both recipients and returns failure when ${rejected} is rejected`, async (t) => {
    t.mock.method(console, "error", () => {});
    const attempted = [];
    const env = { ...sender, EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(value) {
      attempted.push(value.to);
      if (value.to.includes(rejected)) throw new Error("rejected");
      return { messageId: "id" };
    } } };
    assert.deepEqual(await sendEmail(env, message), { ok: false, error: "email send failed" });
    assert.deepEqual(attempted, [["alice@example.test"], ["bob@example.test"]]);
  });
}

test("SES sends a SigV4-signed v2 request with attachments and temporary credentials", async (t) => {
  const requests = captureFetch(t);
  const env = { ...sender, EMAIL_PROVIDER: "ses", SES_REGION: "eu-central-1", SES_ACCESS_KEY_ID: "test-access", SES_SECRET_ACCESS_KEY: "test-secret", SES_SESSION_TOKEN: "test-session" };
  assert.deepEqual(await sendEmail(env, message), { ok: true });
  assert.equal(requests.length, 1);
  const { request, body } = requests[0];
  assert.equal(request.url, "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails");
  assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/eu-central-1\/ses\/aws4_request,/);
  assert.equal(request.headers.get("x-amz-security-token"), "test-session");
  assert.deepEqual(body, {
    FromEmailAddress: "clocked <reports@example.test>",
    Destination: { ToAddresses: ["alice@example.test", "bob@example.test"] },
    ReplyToAddresses: ["manager@example.test"],
    Content: { Simple: {
      Subject: { Data: "Monthly hours", Charset: "UTF-8" },
      Body: { Text: { Data: "Hello", Charset: "UTF-8" }, Html: { Data: "<p>Hello</p>", Charset: "UTF-8" } },
      Attachments: [{ FileName: "hours.csv", RawContent: "SsO2cmcsOAo=", ContentType: "text/csv; charset=utf-8", ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64" }],
    } },
  });
});

test("invalid provider configuration fails without sending or falling back", async (t) => {
  const requests = captureFetch(t);
  t.mock.method(console, "error", () => {});
  for (const config of [
    {}, { EMAIL_PROVIDER: "resend" }, { EMAIL_PROVIDER: "cloudflare", RESEND_API_KEY: "unused" },
    { EMAIL_PROVIDER: "ses" }, { EMAIL_PROVIDER: "typo", RESEND_API_KEY: "unused" },
    { EMAIL_PROVIDER: "ses", SES_REGION: "host.invalid/path", SES_ACCESS_KEY_ID: "key", SES_SECRET_ACCESS_KEY: "secret" },
    { MAIL_FROM: "", RESEND_API_KEY: "key" },
  ]) assert.deepEqual(await sendEmail({ ...sender, ...config }, message), { ok: false, error: "email not configured" });
  assert.equal(requests.length, 0);
});

for (const status of [401, 429, 500]) {
  test(`HTTP ${status} returns a failure after a single attempt`, async (t) => {
    const requests = captureFetch(t, status);
    t.mock.method(console, "error", () => {});
    assert.deepEqual(await sendEmail({ ...sender, RESEND_API_KEY: "key" }, message), { ok: false, error: "email send failed" });
    assert.equal(requests.length, 1);
  });
}

test("binding rejection and network exceptions return generic failures without leaking email content", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-reset-link"); });
  for (const env of [
    { ...sender, RESEND_API_KEY: "key" },
    { ...sender, EMAIL_PROVIDER: "cloudflare", EMAIL: { async send() { throw new Error("secret-reset-link"); } } },
  ]) assert.deepEqual(await sendEmail(env, message), { ok: false, error: "email send failed" });
  assert.doesNotMatch(JSON.stringify(logs), /secret-reset-link/);
});

test("auth and sales emails both use the selected provider", async () => {
  const messages = [];
  const env = { ...sender, EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(value) { messages.push(value); return { messageId: "id" }; } } };
  assert.deepEqual(await sendAuthEmail(env, { to: "new@example.test", subject: "Verify", text: "Verify link", html: "<a>Verify</a>" }), { ok: true });
  assert.deepEqual(await sendAccessRequest(env, { name: "Alice <Admin>", email: "lead@example.test", kind: "individual" }), { ok: true });
  assert.deepEqual(messages[0].to, ["new@example.test"]);
  assert.equal(messages[0].text, "Verify link");
  assert.equal(messages[0].attachments, undefined);
  assert.deepEqual(messages[1].to, [ADMIN_INBOX]);
  assert.equal(messages[1].replyTo, "lead@example.test");
  assert.match(messages[1].html, /Alice &lt;Admin&gt;/);
});

test("reports record only successful sends, skip repeats and allow forced sends", async (t) => {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  t.mock.method(console, "error", () => {});
  sqlite.exec("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Alice', 'alice@example.test', 1, 1, 1)");
  sqlite.exec("INSERT INTO sessions (id, user_id, start_utc, end_utc, timezone) VALUES ('session-1', 'user-1', '2026-09-01T09:00:00Z', '2026-09-01T17:00:00Z', 'UTC')");
  const messages = [];
  let fail = true;
  const env = { ...sender, DB, REPORT_TZ: "UTC", EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(value) {
    messages.push(value);
    if (fail) throw new Error("rejected");
    return { messageId: "id" };
  } } };
  const opts = { userId: "user-1", force: false, to: ["alice@example.test"] };
  assert.equal((await buildAndSendReport(env, "2026-09", opts)).ok, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sent_reports").get().count, 0);
  fail = false;
  assert.equal((await buildAndSendReport(env, "2026-09", opts)).ok, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sent_reports").get().count, 1);
  assert.equal((await buildAndSendReport(env, "2026-09", opts)).skipped, true);
  assert.equal(messages.length, 2);
  assert.equal((await buildAndSendReport(env, "2026-09", { ...opts, force: true })).ok, true);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].attachments[0].filename, "clocked-2026-09.csv");
  assert.match(Buffer.from(messages[2].attachments[0].content, "base64").toString("utf8"), /September/);
});

test("large CSV attachments encode without exceeding the JavaScript argument limit", async () => {
  const csv = "Jörg,8\n".repeat(40_000);
  let sent;
  const env = { ...sender, EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(value) { sent = value; return { messageId: "id" }; } } };
  assert.deepEqual(await sendEmail(env, { ...message, attachments: [{
    filename: "large.csv", contentType: "text/csv", content: new TextEncoder().encode(csv),
  }] }), { ok: true });
  assert.equal(Buffer.from(sent.attachments[0].content, "base64").toString("utf8"), csv);
});

test("an empty recipient list fails before contacting a provider", async (t) => {
  const requests = captureFetch(t);
  assert.deepEqual(await sendEmail({ ...sender, RESEND_API_KEY: "key" }, { ...message, to: [] }), { ok: false, error: "email send failed" });
  assert.equal(requests.length, 0);
});
