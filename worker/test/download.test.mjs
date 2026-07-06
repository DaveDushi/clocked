import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { DOWNLOAD_URL, downloadResponse, isDownloadMethod } from "../.tmp-test/download.js";

test("download route redirects to the GitHub release installer", () => {
  assert.equal(
    DOWNLOAD_URL,
    "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup.exe",
  );

  const response = downloadResponse();

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), DOWNLOAD_URL);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("download route accepts browser GETs and HEAD probes", () => {
  assert.equal(isDownloadMethod("GET"), true);
  assert.equal(isDownloadMethod("HEAD"), true);
  assert.equal(isDownloadMethod("POST"), false);
});

test("dashboard advertises the Windows installer download", async () => {
  const html = await dashboardResponse().text();

  assert.match(html, /href="\/download"/);
  assert.match(html, /Download for Windows/);
  assert.match(html, /clocked-setup\.exe/);
});
