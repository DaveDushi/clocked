// Manual pixel and network comparison. Baseline HTML and Google responses are pinned.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const baseline = resolve(root, '../artifacts/font-audit');
const out = resolve(root, '../artifacts/font-verification');
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.FONT_AUDIT_PLAYWRIGHT).href);
await mkdir(join(out, 'modules'), { recursive: true });
await writeFile(join(out, 'modules/package.json'), '{"type":"module"}');
for (const file of await readdir(join(root, 'src'))) {
  if (file.endsWith('.ts')) await writeFile(join(out, 'modules', file.replace(/\.ts$/, '.js')), ts.transpileModule(await readFile(join(root, 'src', file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
}
const currentDashboard = await import(pathToFileURL(join(out, 'modules/dashboard.js')).href);
const currentMarketing = await import(pathToFileURL(join(out, 'modules/marketing-pages.js')).href);
const currentNews = await import(pathToFileURL(join(out, 'modules/marketing-agent.js')).href);
const currentLegal = await import(pathToFileURL(join(out, 'modules/legal-pages.js')).href);
const newsEnv = { DB: { prepare: () => ({ all: async () => ({ results: [{ title: 'Clocked update', body: 'Automatic time tracking for teams.', created_at: '2026-10-30', channel: 'site' }] }) }) } };
const current = {
  home: await currentDashboard.dashboardResponse().text(),
  press: await currentMarketing.pressPageResponse().text(),
  'extension-privacy': await currentMarketing.extensionPrivacyPageResponse().text(),
  news: await (await currentNews.newsPageResponse(newsEnv)).text(),
  privacy: await currentLegal.privacyPageResponse().text(), terms: await currentLegal.termsPageResponse().text(),
};
const network = JSON.parse(await readFile(join(baseline, 'network.json')));
const inventory = JSON.parse(await readFile(join(baseline, 'font-inventory.json')));
const fixtures = `<section style="padding:24px;max-width:850px"><h1>Font verification</h1><p>ASCII text 0123456789 “quotes” ‘apostrophes’ – dash — dash … ellipsis ‐ hyphen</p><p>Crème brûlée, Ångström, Łódź, Œuvre, naïve, São Paulo, Dvořák.</p><p><em>Italic <strong>bold inside italic</strong></em> <strong>Bold</strong></p><p>中文 日本語 한국어</p><code>const café = 123; // → 456</code><p style="hyphens:auto;width:95px" lang="en">internationalization extraordinary responsibilities</p><div class="ws"><button class="primary">Weight 600 override</button><div class="ws-person-name">Zoë<small>Component override</small></div><div class="ws-person-initials">ŽŁ</div></div>` + [400, 500, 600, 700].map(w => `<p style="font-weight:${w}">Space ${w}: AV office café Œuvre \u0141\u00f3d\u017a \u017dlu\u0165ou\u010dk\u00fd <i>italic <b>bold</b></i></p><p style="font-family:var(--mono);font-weight:${w};font-variant-numeric:tabular-nums">Plex ${w}: 0123456789 café Œuvre \u0141\u00f3d\u017a \u017dlu\u0165ou\u010dk\u00fd <i>italic <b>bold</b></i></p>`).join('') + '</section>';
const cases = [];
for (const name of ['home', 'press', 'extension-privacy', 'news', 'privacy', 'terms']) {
  const html = await readFile(join(baseline, `${name}.html`), 'utf8');
  cases.push([name, html]);
  if (name === 'home') cases.push(['typography-fixture', html.replace('</body>', fixtures + '</body>')]);
  if (name === 'home') {
    const head = html.slice(0, html.indexOf('<body'));
    cases.push(['cjk-fixture', head + '<body><p id="cjk">中文 日本語 한국어</p></body></html>']);
  }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.FONT_AUDIT_CHROMIUM });
const results = [];
try {
  for (const [name, original] of cases) for (const width of [1440, 390]) for (const version of ['before', 'after']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const requested = new Map();
    const errors = [];
    page.on('console', msg => { if (/font|decode|OTS/i.test(msg.text())) errors.push(msg.text()); });
    await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-30T12:00:00Z'));
    let html = original;
    if (version === 'after') {
      if (current[name]) html = current[name];
      else if (name === 'typography-fixture') html = current.home.replace('</body>', fixtures + '</body>');
      else if (name === 'cjk-fixture') html = current.home.slice(0, current.home.indexOf('<body')) + '<body><p id="cjk">中文 日本語 한국어</p></body></html>';
    }
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://font-audit.invalid/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.includes('/api/')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
      let file, type;
      if (network[url]) { file = join(baseline, network[url].file); type = network[url].contentType; }
      else if (inventory.some(x => x.url === url)) { file = join(baseline, inventory.find(x => x.url === url).file); type = 'font/woff2'; }
      else if (url.startsWith('https://font-audit.invalid/fonts/')) { file = join(root, 'public', new URL(url).pathname); type = url.endsWith('.css') ? 'text/css' : 'font/woff2'; }
      else return route.abort();
      const body = await readFile(file);
      if (type.startsWith('font/')) requested.set(url, body.length);
      return route.fulfill({ contentType: type, body, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('https://font-audit.invalid/');
    if (name === 'home' || name === 'typography-fixture') await page.locator('#landingView:not(.hidden)').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(1000);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, `${name}-${width}-${version}.png`), fullPage: true, animations: 'disabled' });
    let platformFonts;
    if (name === 'cjk-fixture') {
      const session = await context.newCDPSession(page);
      await session.send('DOM.enable'); await session.send('CSS.enable');
      const doc = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#cjk' });
      platformFonts = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    results.push({ page: name, width, version, bytes: [...requested.values()].reduce((a,b) => a+b,0), fonts: Object.fromEntries(requested), platformFonts, errors });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(join(out, 'network.json'), JSON.stringify(results, null, 2));
for (const row of results) {
  if (row.errors.length) throw new Error(`${row.page}: font decoding errors: ${row.errors}`);
  if (row.version === 'after' && ['home', 'press', 'extension-privacy', 'news', 'cjk-fixture'].includes(row.page) && Object.keys(row.fonts).some(url => url.includes('-extended-'))) throw new Error(`${row.page}: unexpected extended font download`);
}
for (const width of [1440, 390]) {
  const system = version => results.find(x => x.page === 'cjk-fixture' && x.width === width && x.version === version).platformFonts.filter(x => !x.isCustomFont);
  if (JSON.stringify(system('before')) !== JSON.stringify(system('after'))) throw new Error('CJK system font fallback changed');
}
console.log(results.map(x => `${x.page} ${x.width} ${x.version}: ${x.bytes} bytes, errors ${x.errors.length}`).join('\n'));
