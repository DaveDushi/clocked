// Manual baseline capture. Requires Playwright, supplied through FONT_AUDIT_PLAYWRIGHT.
// Run before changing fonts; captured responses pin the baseline for comparisons.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '../artifacts/font-audit');
await mkdir(join(out, 'modules'), { recursive: true });
await writeFile(join(out, 'modules/package.json'), '{"type":"module"}');
const sourceAudit = [];
for (const name of await readdir(join(root, 'src'))) {
  if (!name.endsWith('.ts')) continue;
  const source = await readFile(join(root, 'src', name), 'utf8');
  await writeFile(join(out, 'modules', name.replace(/\.ts$/, '.js')), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  source.split('\n').forEach((line, i) => {
    if (/font[-:]|--mono|hyphens|preload/.test(line)) sourceAudit.push({ file: name, line: i + 1, text: line.trim() });
  });
}
await writeFile(join(out, 'source-styles.json'), JSON.stringify(sourceAudit, null, 2));
const { chromium } = await import(pathToFileURL(process.env.FONT_AUDIT_PLAYWRIGHT).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.FONT_AUDIT_CHROMIUM });
const dashboard = await import(pathToFileURL(join(out, 'modules/dashboard.js')).href);
const marketing = await import(pathToFileURL(join(out, 'modules/marketing-pages.js')).href);
const pages = [
  ['home', await dashboard.dashboardResponse().text()],
  ['press', await marketing.pressPageResponse().text()],
  ['extension-privacy', await marketing.extensionPrivacyPageResponse().text()],
];
const inventory = {};
const report = [];
try {
  for (const [name, html] of pages) {
    await writeFile(join(out, `${name}.html`), html);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const fonts = new Set();
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://font-audit.invalid/') return route.fulfill({ contentType: 'text/html', body: html });
      if (/fonts\.(googleapis|gstatic)\.com/.test(url)) {
        const response = await route.fetch();
        const body = await response.body();
        const id = Buffer.from(url).toString('base64url');
        const file = `${id}.${url.includes('gstatic') ? 'woff2' : 'css'}`;
        await writeFile(join(out, file), body);
        inventory[url] = { file, bytes: body.length, contentType: response.headers()['content-type'] };
        if (url.includes('gstatic')) fonts.add(url);
        return route.fulfill({ response, body });
      }
      return route.abort();
    });
    await page.goto('https://font-audit.invalid/');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, `${name}-before.png`), fullPage: true, animations: 'disabled' });
    const use = await page.evaluate(() => ({
      preloads: [...document.querySelectorAll('link[rel=preload]')].map(x => x.outerHTML),
      text: document.body.innerText,
      runs: [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => {
        const s = getComputedStyle(e);
        return { text: [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''), family: s.fontFamily, weight: s.fontWeight, style: s.fontStyle, features: s.fontFeatureSettings, numeric: s.fontVariantNumeric, axes: s.fontVariationSettings, hyphens: s.hyphens };
      }),
    }));
    report.push({ page: name, fontBytes: [...fonts].reduce((sum, url) => sum + inventory[url].bytes, 0), fonts: [...fonts], ...use });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(join(out, 'network.json'), JSON.stringify(inventory, null, 2));
await writeFile(join(out, 'pages-before.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.map(({ page, fontBytes, fonts, preloads }) => ({ page, fontBytes, files: fonts.length, preloads })), null, 2));
