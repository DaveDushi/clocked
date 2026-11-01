import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'file:///C:/Users/david/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const base = 'https://clocked.easytomanage.com';
const out = 'artifacts/font-deployment';
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile('worker/fonts/subsets.json'));
for (const file of manifest) {
  const res = await fetch(base + '/fonts/' + file.file);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /font\/woff2/);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), await readFile('worker/public/fonts/' + file.file));
}
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/david/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe' });
const report = [];
try {
  for (const width of [1440, 390]) for (const [name, path] of [['home', '/'], ['press', '/press'], ['extension-privacy', '/privacy/extension'], ['news', '/news'], ['privacy', '/privacy'], ['terms', '/terms']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const fonts = [], issues = [], externalFonts = [];
    page.on('request', r => { if (/fonts\.(googleapis|gstatic)/.test(r.url())) externalFonts.push(r.url()); if (r.resourceType() === 'font') fonts.push(r.url()); });
    page.on('pageerror', e => issues.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /font|OTS|decode/i.test(m.text())) issues.push(m.text()); });
    await page.route('**/*', route => { assert.ok(['GET', 'HEAD'].includes(route.request().method()), 'No production mutations during smoke test'); return route.continue(); });
    await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-30T12:00:00Z'));
    const res = await page.goto(base + path);
    assert.equal(res.status(), 200);
    if (name === 'home') await page.locator('#landingView:not(.hidden)').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(1000);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(externalFonts.length, 0);
    assert.equal(issues.length, 0, issues.join('\n'));
    assert.ok(!fonts.some(x => x.includes('-extended-')), name + ' unexpected extended load');
    if (!['privacy', 'terms'].includes(name)) assert.ok(fonts.some(x => x.includes('space-core-')));
    await page.screenshot({ path: out + '/' + name + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    if (name === 'home') {
      await page.locator('#navSignin').click();
      await page.locator('#authModal:not(.hidden)').waitFor({ state: 'visible' });
      await page.locator('#authClose').click();
      await page.locator('#heroRequestAccess').click();
      await page.locator('#requestKind').waitFor({ state: 'visible' });
      await page.locator('#requestKind').selectOption('team');
      await page.locator('#requestCompany').waitFor({ state: 'visible' });
      await page.locator('#accessRequestClose').click();
      await page.locator('details summary').first().click();
      assert.ok(await page.locator('details').first().evaluate(e => e.open));
    }
    report.push({ page: name, width, status: res.status(), fonts: fonts.map(x => x.split('/').pop()), issues });
    await context.close();
    console.log('PASS ' + name + ' ' + width + 'px; ' + fonts.length + ' font requests');
  }
} finally { await browser.close(); }
await writeFile(out + '/results.json', JSON.stringify({ version: '8ffc0a2e-0999-4a51-830d-fbb29de27f7a', commit: '1edb21e', fontBodiesVerified: 8, pages: report }, null, 2));
