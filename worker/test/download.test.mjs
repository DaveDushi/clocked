import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import {
  DOWNLOAD_URL,
  DOWNLOAD_URL_EXTENSION,
  downloadExtensionResponse,
  downloadResponse,
  isDownloadMethod,
} from "../.tmp-test/download.js";

test("download route redirects to the GitHub release installer", () => {
  assert.equal(
    DOWNLOAD_URL,
    "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup.exe",
  );

  const response = downloadResponse(null);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), DOWNLOAD_URL);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("extension download redirects to stable chrome zip on latest release", () => {
  assert.equal(
    DOWNLOAD_URL_EXTENSION,
    "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-chrome.zip",
  );
  const response = downloadExtensionResponse();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), DOWNLOAD_URL_EXTENSION);
});

test("download route accepts browser GETs and HEAD probes", () => {
  assert.equal(isDownloadMethod("GET"), true);
  assert.equal(isDownloadMethod("HEAD"), true);
  assert.equal(isDownloadMethod("POST"), false);
});

test("dashboard advertises the Windows installer and Chrome extension", async () => {
  const html = await dashboardResponse().text();

  assert.match(html, /href="\/download\/win"/);
  assert.match(html, /Download for Windows/);
  assert.match(html, /href="\/download\/extension"/);
  assert.match(html, /Chrome extension/);
});

test("landing page shows hosted vs self-hosted compare table and timeline UI", async () => {
  const html = await dashboardResponse().text();
  assert.match(html, /Hosted vs self-hosted/);
  assert.match(html, /compare-table/);
  assert.match(html, /Self-hosted Worker/);
  assert.match(html, /timelinePanel/);
  assert.match(html, /Local first/);
  assert.match(html, /Optional projects/);
});

test("dashboard exposes additive device tokens instead of a revoke-all control", async () => {
  const html = await dashboardResponse().text();
  assert.match(html, /id="mintToken"/);
  assert.match(html, /id="tokenList"/);
  assert.match(html, /Add device/);
  assert.doesNotMatch(html, /id="regenToken"/);
});

test("dashboard exposes the complete monthly delivery schedule", async () => {
  const html = await dashboardResponse().text();
  assert.match(html, /id="sendDay"/);
  assert.match(html, /id="sendTime" type="time"/);
  assert.match(html, /id="sendTimezone"/);
  assert.match(html, /Intl\.supportedValuesOf\("timeZone"\)/);
});
