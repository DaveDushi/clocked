import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";

const html = await dashboardResponse().text();
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
function personalView(permission, status, recorded = false) {
  const context = {
    ws: { mode: "worker", period: "2026-09", me: { user: { email: "ana@example.test" }, editPermission: permission, tracking: { status } }, personal: { totalMinutes: recorded ? 480 : 0, recordedDays: recorded ? [{ breakMinutes: 30 }] : [], sessions: [] } },
    wsEsc: value => String(value), wsMonthSelect: () => "<select></select>",
    wsState: () => "loading", wsRecordedThrough: () => "September 2026 complete",
    wsModel: { monthLabel: () => "September 2026", duration: minutes => minutes + "m" },
    wsLedgerHtml: () => "<section id='recorded-days'>Days</section>", BREAK_NOTE: "Break note",
  };
  runInNewContext(between("function wsCanEdit()", "function wsMembers()") + between("function wsPersonalTrackingHtml()", "// Stats"), context);
  return context.wsPersonalHtml();
}

test("worker correction guidance and missing-day actions follow actual permission", () => {
  for (const recorded of [false, true]) {
    const locked = personalView("none", "tracking", recorded);
    assert.match(locked, /Your team manager handles corrections/);
    assert.doesNotMatch(locked, /data-action='add-day'/);
    const addOnly = personalView("add_only", "tracking", recorded);
    assert.match(addOnly, /You can add missing time. Ask your team manager to change existing sessions./);
    assert.match(addOnly, /data-action='add-day' data-user=''/);
    assert.ok(addOnly.indexOf("data-action='add-day'") < addOnly.indexOf("id='recorded-days'"));
    const full = personalView("full", "tracking", recorded);
    assert.match(full, /You can add missing time and edit existing sessions/);
    assert.match(full, /data-action='add-day'/);
    assert.doesNotMatch(full, /Your team manager handles corrections/);
  }
});

test("empty worker months distinguish a missing connection, paused sync and an enabled connection", () => {
  const missing = personalView("none", "no_device");
  assert.match(missing, /No device connected/);
  assert.match(missing, /Creating a device token alone does not connect the app/);
  assert.match(missing, /data-action='settings-desktop'/);
  assert.match(missing, /Connect a device/);
  const paused = personalView("none", "disabled");
  assert.match(paused, /Cloud sync is paused/);
  assert.match(paused, /may still record locally/);
  assert.match(paused, /queued records upload when sync resumes/);
  assert.match(personalView("none", "tracking"), /Device connected and cloud sync enabled/);
  assert.doesNotMatch(personalView("none", "no_device", true), /Connect a device/);
});
