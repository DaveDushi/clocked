import assert from "node:assert/strict";
import { test } from "node:test";
import { getEffectiveDelivery, getTeamDelivery, handleDeliverySettings, listDeliveries } from "../.tmp-test/delivery.js";
import { buildAndSendReport, sendMonthlyReports } from "../.tmp-test/email.js";
import { testDatabase } from "./helpers/database.mjs";

const defaults = { day: 1, time: "06:00", timezone: "UTC" };
const chosen = { recipients: ["reports@example.test"], sendDay: 12, sendTime: "09:30", sendTimezone: "Europe/Berlin" };
const personal = { kind: "personal", userId: "solo", email: "solo@example.test" };
const team = { kind: "team", organizationId: "a" };

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  for (const id of ["solo", "worker", "owner", "admin", "otherOwner"]) {
    sqlite.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)")
      .run(id, id, id + "@example.test");
  }
  sqlite.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('a', 'Acme', 'acme', 1), ('b', 'Other', 'other', 1);
    UPDATE organization SET metadata = '{"plan":"team"}';
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
    ('owner-a', 'a', 'owner', 'owner', 1), ('admin-a', 'a', 'admin', 'admin', 2),
    ('worker-a', 'a', 'worker', 'member', 1), ('owner-b', 'b', 'otherOwner', 'owner', 1);`);
  const env = { DB, REPORT_TZ: "UTC" };
  const request = (target, input) => handleDeliverySettings(new Request("https://example.test/api/settings", {
    method: input === undefined ? "GET" : "POST",
    ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { "content-type": "application/json" } }),
  }), env, target);
  return { env, sqlite, request };
}

test("solo delivery defaults to the account email and historical schedule", async (t) => {
  const { env, request } = fixture(t);
  assert.deepEqual(await (await request(personal)).json(), {
    recipients: ["solo@example.test"], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC", managed: false,
  });
  assert.deepEqual(await getEffectiveDelivery(env, { userId: "solo", email: "current@example.test" }), {
    recipients: ["current@example.test"], schedule: defaults, managed: false,
  });
});

test("saving trims recipients, preserves duplicates, and replaces omitted schedule fields", async (t) => {
  const { request, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO user_settings (userId, track_projects) VALUES ('solo', 1)");
  assert.deepEqual(await (await request(personal, chosen)).json(), { ok: true, ...chosen });
  const response = await request(personal, { recipients: [null, "  a@example.test ", "", 1, "a@example.test", "A@example.test"] });
  assert.deepEqual(await response.json(), {
    ok: true, recipients: ["a@example.test", "a@example.test", "A@example.test"],
    sendDay: 1, sendTime: "06:00", sendTimezone: "UTC",
  });
  assert.equal(sqlite.prepare("SELECT mail_to FROM user_settings WHERE userId = 'solo'").get().mail_to,
    "a@example.test\na@example.test\nA@example.test");
  assert.equal(sqlite.prepare("SELECT track_projects FROM user_settings WHERE userId = 'solo'").get().track_projects, 1);
  assert.deepEqual(await (await request(personal)).json(), {
    recipients: ["a@example.test", "A@example.test"], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC", managed: false,
  });
});

test("delivery saves retain day coercion and trim schedule strings", async (t) => {
  const { request } = fixture(t);
  for (const [sendDay, expected] of [["12", 12], [null, 0], [false, 0], [true, 1], [99, 99]]) {
    const response = await request(personal, { ...chosen, sendDay, sendTime: " 09:30 ", sendTimezone: " Europe/Berlin " });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ...chosen, sendDay: expected });
  }
});

test("invalid delivery settings fail in the existing order and leave settings unchanged", async (t) => {
  const { env, request } = fixture(t);
  await request(personal, chosen);
  const cases = [
    [null, "at least one recipient required"],
    [{}, "at least one recipient required"],
    [{ ...chosen, recipients: "a@example.test" }, "at least one recipient required"],
    [{ ...chosen, recipients: Array(21).fill("bad") }, "too many recipients"],
    [{ ...chosen, recipients: ["bad"], sendDay: 29 }, "invalid email"],
    [{ ...chosen, sendDay: 29, sendTime: "bad" }, "invalid send day"],
    [{ ...chosen, sendTime: "24:00", sendTimezone: "bad" }, "invalid send time"],
    [{ ...chosen, sendTimezone: "Unknown/Timezone" }, "invalid timezone"],
  ];
  for (const [body, error] of cases) {
    const response = await request(personal, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
    assert.deepEqual(await (await request(personal)).json(), { ...chosen, managed: false });
  }
  const malformed = await handleDeliverySettings(new Request("https://example.test", { method: "POST", body: "{" }),
    env, personal);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "at least one recipient required" });
});

test("team defaults override personal settings and members cannot save personal delivery", async (t) => {
  const { request, env, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO user_settings (userId, mail_to, send_day, send_time, send_timezone) VALUES ('worker', 'old@example.test', 12, '12:00', 'Asia/Tokyo')");
  const worker = { kind: "personal", userId: "worker", email: "worker@example.test" };
  assert.deepEqual(await (await request(worker)).json(), {
    recipients: ["owner@example.test", "admin@example.test"], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC", managed: true,
  });
  assert.deepEqual(await (await request(team)).json(), {
    recipients: [], sendDay: 1, sendTime: "06:00", sendTimezone: "UTC",
    defaultRecipients: ["owner@example.test", "admin@example.test"],
  });
  const forbidden = await request(worker, {});
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "your team manager controls timesheet delivery" });
  await request(team, chosen);
  assert.deepEqual(await (await request(worker)).json(), { ...chosen, managed: true });
  assert.deepEqual(await getTeamDelivery(env, "a"), {
    recipients: ["reports@example.test"], schedule: { day: 12, time: "09:30", timezone: "Europe/Berlin" },
    defaultRecipients: ["owner@example.test", "admin@example.test"],
  });
});

test("team recipients deduplicate managers and fall back to the account when none remain", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-again', 'a', 'owner', 'admin', 3)");
  assert.deepEqual((await getEffectiveDelivery(env, { userId: "worker", email: "worker@example.test" })).recipients,
    ["owner@example.test", "admin@example.test"]);
  sqlite.exec("DELETE FROM member WHERE userId IN ('owner', 'admin')");
  assert.deepEqual((await getEffectiveDelivery(env, { userId: "worker", email: "worker@example.test" })).recipients,
    ["worker@example.test"]);
});

test("invalid stored fields default independently and comma-separated recipients remain supported", async (t) => {
  const { env, sqlite } = fixture(t);
  sqlite.exec(`INSERT INTO user_settings (userId, mail_to, send_day, send_time, send_timezone)
    VALUES ('solo', 'a@example.test, b@example.test\na@example.test', 29, '09:30', 'Invalid/Timezone')`);
  assert.deepEqual(await getEffectiveDelivery(env, personal), {
    recipients: ["a@example.test", "b@example.test"],
    schedule: { day: 1, time: "09:30", timezone: "UTC" }, managed: false,
  });
});

test("individual and bulk delivery choose the earliest membership including tied dates", async (t) => {
  const { env, request, sqlite } = fixture(t);
  await request(team, chosen);
  await request({ kind: "team", organizationId: "b" }, {
    recipients: ["other@example.test"], sendDay: 99, sendTime: "08:00", sendTimezone: "Asia/Tokyo",
  });
  sqlite.exec("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('aa', 'b', 'worker', 'member', 1)");
  const expected = {
    recipients: ["other@example.test"],
    schedule: { day: 99, time: "08:00", timezone: "Asia/Tokyo" }, managed: true,
  };
  assert.deepEqual(await getEffectiveDelivery(env, { userId: "worker", email: "worker@example.test" }), expected);
  assert.deepEqual((await listDeliveries(env)).find((delivery) => delivery.id === "worker"), {
    id: "worker", email: "worker@example.test", ...expected,
  });
});

for (const [target, table, column, id] of [[personal, "user_settings", "userId", "solo"], [team, "org_settings", "organizationId", "a"]]) {
  test(`${target.kind} delivery saves leave every field unchanged when the database rejects the schedule`, async (t) => {
    const { request, sqlite } = fixture(t);
    await request(target, chosen);
    sqlite.exec(`CREATE TRIGGER reject_schedule BEFORE UPDATE OF send_time ON ${table}
      BEGIN SELECT RAISE(ABORT, 'schedule rejected'); END`);
    await assert.rejects(request(target, {
      recipients: ["changed@example.test"], sendDay: 0, sendTime: "12:00", sendTimezone: "Asia/Tokyo",
    }), /schedule rejected/);
    assert.deepEqual(await (await request(target)).json(), {
      ...chosen, ...(target.kind === "team" ? { defaultRecipients: ["owner@example.test", "admin@example.test"] } : { managed: false }),
    });
    assert.equal(sqlite.prepare(`SELECT mail_to FROM ${table} WHERE ${column} = ?`).get(id).mail_to, "reports@example.test");
  });
}

test("scheduled and forced sends use the same effective delivery and report timezone", async (t) => {
  const { env, request, sqlite } = fixture(t);
  await request(personal, { recipients: ["reports@example.test"], sendDay: 1, sendTime: "09:00", sendTimezone: "Asia/Tokyo" });
  sqlite.exec("INSERT INTO sessions (id, user_id, start_utc, end_utc) VALUES ('solo-session', 'solo', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')");
  const messages = [];
  Object.assign(env, { MAIL_FROM: "reports@example.test", EMAIL_PROVIDER: "cloudflare", EMAIL: { async send(message) {
    messages.push(message);
    return { messageId: "id" };
  } } });
  await sendMonthlyReports(env, new Date("2026-10-01T00:00:00Z"));
  assert.equal(messages.length, 1);
  const delivery = await getEffectiveDelivery(env, personal);
  const sent = await buildAndSendReport(env, "2026-09", {
    force: true, userId: "solo", to: delivery.recipients, timezone: delivery.schedule.timezone,
  });
  assert.equal(sent.ok, true);
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.deepEqual(message.to, ["reports@example.test"]);
    assert.equal(message.attachments[0].filename, "clocked-2026-09.csv");
    assert.match(Buffer.from(message.attachments[0].content, "base64").toString("utf8"), /September 1, 2026",09:00,10:00/);
  }
  await sendMonthlyReports(env, new Date("2026-10-01T00:00:00Z"));
  assert.equal(messages.length, 2);
});
