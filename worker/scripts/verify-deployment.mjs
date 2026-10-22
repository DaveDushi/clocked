import assert from "node:assert/strict";

const primary = process.env.CLOCKED_URL ?? "https://clocked.easytomanage.com";
const legacy = process.env.CLOCKED_LEGACY_URL ?? "https://clocked.daviddusi.com";

async function request(base, path, init) {
  return fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
}

for (const base of [primary, legacy]) {
  const health = await request(base, "/health");
  assert.equal(health.status, 200, `${base} health`);
  assert.equal((await health.text()).trim(), "clocked-worker ok");
  const ingest = await request(base, "/sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(ingest.status, 401, `${base} rejects unauthenticated sync`);
  for (const path of ["/desktop/working-hours", "/desktop/inactivity"]) {
    const policy = await request(base, path);
    assert.equal(policy.status, 401, `${base}${path} rejects unauthenticated policy requests`);
  }
}

const home = await request(primary, "/");
assert.equal(home.status, 200);
const html = await home.text();
assert.ok(html.includes(`<link rel="canonical" href="${primary}/"`), "new canonical URL");
assert.ok(!html.includes("clocked.daviddusi.com"), "no old-domain links in homepage");
const session = await request(primary, "/api/auth/get-session");
assert.equal(session.status, 200);
assert.equal(await session.json(), null);
const download = await request(primary, "/download/win");
assert.equal(download.status, 302);
assert.ok(download.headers.get("location").startsWith("https://github.com/DaveDushi/clocked/releases/"));
for (const path of ["/", "/download", "/privacy/extension"]) {
  const response = await request(legacy, path);
  assert.equal(response.status, 308, `${path} redirects from legacy`);
  assert.equal(response.headers.get("location"), new URL(path, primary).toString());
}
console.log("Verified new homepage, auth, downloads, legacy redirects, health, and sync authentication.");
