import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimesheetView } from "../.tmp-test/timesheet-view.js";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { Script, runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function target(user = "alice", period = "2026-09", team = false) {
  const query = team ? "organizationId=team&userId=" + user : "";
  return {
    key: user + ":" + period, period, label: user,
    hoursUrl: (team ? "/api/team/hours?" + query + "&" : "/api/hours?") + "period=" + period,
    editUrl: team ? "/api/team/manual-session?" + query : "/api/manual-session",
  };
}

function month(minutes = 60, period = "2026-09") {
  return { period, tz: "UTC", totalMinutes: minutes, activeDays: 1,
    days: [{ date: period + "-01", label: "First day", minutes }], sessions: [] };
}

function fixture() {
  const requests = [];
  const visible = { data: null, day: "", message: "", retry: null, busy: false };
  const view = createTimesheetView({
    request(url, init) {
      const response = deferred();
      requests.push({ url, init, respondWith: response.resolve,
        respond: (data, status = 200) => response.resolve(Response.json(data, { status })) });
      return response.promise;
    },
    loading(next, retained) { if (!retained) visible.data = null; },
    render(data, next) { visible.data = data; visible.target = next; },
    selection(day) { visible.day = day; },
    busy(pending) { visible.busy = pending; },
    message(text, retry) { visible.message = text; visible.retry = retry; },
  });
  return { view, requests, visible };
}

async function loaded(f, next) {
  const load = f.view.load(next);
  f.requests.at(-1).respond(month(60, next.period));
  await load;
}

test("month and account navigation only render the latest response", async () => {
  const f = fixture();
  const old = f.view.load(target());
  const latest = f.view.load(target("bob", "2026-10", true));
  f.requests[1].respond(month(120, "2026-10"));
  await latest;
  f.requests[0].respond(month(900));
  await old;
  assert.equal(f.visible.data.totalMinutes, 120);
  assert.equal(f.visible.target.label, "bob");
  const staleFailure = f.view.load(target());
  await loaded(f, target("bob", "2026-10", true));
  f.requests.at(-2).respond({}, 500);
  await staleFailure;
  assert.equal(f.visible.message, "");
});

test("a previous response whose body arrives late cannot replace the latest month", async () => {
  const f = fixture();
  let finish;
  const body = new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(month(900)))); controller.close(); };
  } });
  const old = f.view.load(target());
  f.requests[0].respondWith(new Response(body));
  await loaded(f, target("alice", "2026-10"));
  finish();
  await old;
  assert.equal(f.visible.data.period, "2026-10");
  assert.equal(f.visible.data.totalMinutes, 60);
});

for (const team of [false, true]) {
  test((team ? "team" : "personal") + " edits reload server totals, retain selection, and retry only the failed refresh", async () => {
    const f = fixture(), next = target("alice", "2026-09", team);
    await loaded(f, next);
    f.view.select("2026-09-01");
    const edit = f.view.edit("POST", { date: "2026-09-01", start: "09:00", end: "11:00" });
    assert.equal(f.visible.busy, true);
    assert.equal(await f.view.edit("POST", {}), false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].url, next.editUrl);
    f.requests[1].respond({ ok: true });
    await new Promise(setImmediate);
    assert.equal(f.requests[2].url, next.hoursUrl);
    f.requests[2].respond({}, 500);
    assert.equal(await edit, true);
    assert.equal(f.visible.data.totalMinutes, 60);
    assert.equal(f.visible.day, "2026-09-01");
    assert.match(f.visible.message, /^Saved, but refresh failed/);
    assert.equal(f.visible.busy, false);
    f.visible.retry();
    assert.equal(f.requests[3].init, undefined);
    f.requests[3].respond(month(120));
    await new Promise(setImmediate);
    assert.equal(f.visible.data.totalMinutes, 120);
    assert.equal(f.visible.day, "2026-09-01");
    assert.equal(f.visible.message, "Saved.");
    assert.equal(f.visible.retry, undefined);
    assert.equal(f.requests.filter((r) => r.init?.method === "POST").length, 1);
  });
}

test("a pending team deletion stays tied to its original member during navigation", async () => {
  const f = fixture();
  await loaded(f, target("alice", "2026-09", true));
  const edit = f.view.edit("DELETE", { id: "alice-session" });
  const mutation = f.requests[1];
  await loaded(f, target("bob", "2026-10", true));
  mutation.respond({ ok: true });
  await edit;
  assert.equal(mutation.url, "/api/team/manual-session?organizationId=team&userId=alice");
  assert.equal(mutation.init.body, '{"id":"alice-session"}');
  assert.equal(f.visible.target.label, "bob");
  assert.equal(f.visible.data.period, "2026-10");
  assert.equal(f.visible.message, "");
  assert.equal(f.requests.length, 3);
});

test("saving after month navigation refreshes the selected month without reverting it", async () => {
  const f = fixture();
  await loaded(f, target());
  const edit = f.view.edit("POST", { date: "2026-09-01", start: "09:00", end: "10:00" });
  const mutation = f.requests[1];
  await loaded(f, target("alice", "2026-10"));
  mutation.respond({ ok: true });
  await new Promise(setImmediate);
  assert.equal(f.requests.at(-1).url, "/api/hours?period=2026-10");
  f.requests.at(-1).respond(month(180, "2026-10"));
  await edit;
  assert.equal(f.visible.data.period, "2026-10");
  assert.equal(f.visible.data.totalMinutes, 180);
  assert.equal(f.visible.day, "");
});

test("clearing a view cancels late renders, but reopening still sees a pending save complete", async () => {
  const f = fixture();
  const old = f.view.load(target());
  f.view.clear();
  f.requests[0].respond(month(900));
  await old;
  assert.equal(f.visible.data, null);
  await loaded(f, target());
  const edit = f.view.edit("DELETE", { id: "session" });
  const mutation = f.requests.at(-1);
  f.view.clear();
  await loaded(f, target());
  mutation.respond({ ok: true });
  await new Promise(setImmediate);
  f.requests.at(-1).respond(month(0));
  await edit;
  assert.equal(f.visible.data.totalMinutes, 0);
});

test("rejected edits leave data intact and allow another attempt", async () => {
  const f = fixture();
  await loaded(f, target());
  const edit = f.view.edit("DELETE", { id: "session" });
  f.requests.at(-1).respond({ error: "forbidden" }, 403);
  assert.equal(await edit, false);
  assert.equal(f.visible.data.totalMinutes, 60);
  assert.equal(f.visible.message, "forbidden");
  assert.equal(f.visible.busy, false);
  assert.equal(f.requests.length, 2);
});

test("account reset isolates old pending saves from the new account", async () => {
  const f = fixture();
  await loaded(f, target());
  const oldEdit = f.view.edit("POST", { date: "2026-09-01" });
  const oldRequest = f.requests.at(-1);
  f.view.clear(true);
  await loaded(f, target("bob"));
  assert.equal(f.visible.busy, false);
  const newEdit = f.view.edit("DELETE", { id: "bob-session" });
  const newRequest = f.requests.at(-1);
  oldRequest.respond({ ok: true });
  await oldEdit;
  assert.equal(f.visible.busy, true);
  assert.equal(await f.view.edit("DELETE", { id: "bob-session" }), false);
  newRequest.respond({ ok: true });
  await new Promise(setImmediate);
  f.requests.at(-1).respond(month(0));
  await newEdit;
  assert.equal(f.visible.busy, false);
  assert.equal(f.visible.target.label, "bob");
  assert.equal(f.visible.data.totalMinutes, 0);
});

test("the shipped inline script parses and its serialized lifecycle runs without imports", async () => {
  const html = await dashboardResponse().text();
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new Script(script);
  const embeddedFactory = script.slice(0, script.indexOf("const $ ="));
  const factory = runInNewContext(embeddedFactory + "; createTimesheetView");
  let rendered;
  const view = factory({ request: async () => Response.json(month(75)), loading() {},
    render(data) { rendered = data; }, selection() {}, busy() {}, message() {} });
  await view.load(target());
  assert.equal(rendered.totalMinutes, 75);
});

test("bundler function-name preservation does not add dependencies to the embedded lifecycle", async () => {
  const { code } = await transformWithEsbuild(createTimesheetView.toString(), "timesheet-view.js", {
    keepNames: true, target: "es2022",
  });
  const bundled = runInNewContext(code + "; createTimesheetView");
  const embedded = runInNewContext("(" + bundled.toString() + ")");
  let rendered;
  const view = embedded({ request: async () => Response.json(month(90)), loading() {},
    render(data) { rendered = data; }, selection() {}, busy() {}, message() {} });
  await view.load(target());
  assert.equal(rendered.totalMinutes, 90);
});
