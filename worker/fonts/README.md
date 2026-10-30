# Regenerate the fonts

Run from the repository root:

```powershell
py -3 -m pip install -r worker/fonts/requirements.txt
py -3 worker/scripts/subset-fonts.py
```

Commit `worker/public/fonts`, `worker/src/font-head.ts`, and `worker/fonts/subsets.json` together. The normal build only copies these assets; it never processes fonts. Filenames include a content hash and use immutable caching.

Rerun after changing text, inline component styles, weights, font features, or font sources. News and account/team/project names are dynamic, so review their character requirements too. Supported Latin-1 and Latin Extended-A are retained regardless of current content. Used characters outside those blocks are retained when present in the pinned sources and the original Google faces. CJK continues through the existing system stacks. If a newly used character is absent from the pinned sources, the script stops. Run `--refresh-sources` to fetch a new source set, then review the source diff and repeat the pixel checks. A source update may also require refreshing the original coverage inventory and establishing a new baseline.

The default command preserves hinting and the original Space Grotesk axis range because removing either caused pixel regressions. `--drop-hinting` and `--clip-weight` are experiments only. They overwrite generated assets, so rerun the default command after any rejected experiment.

The core deliberately follows the original Google Latin face boundary rather than ASCII alone. Splitting accented words between files changed kerning. The extended face has only characters outside that boundary; both CSS ranges are generated from the actual output cmap, without overlap or a generated fallback face. Core preload lists match the public page's use: news preloads Space and Mono 400; home/press/extension privacy also preload Mono 500. Mono 600 remains demand-loaded for dashboard components. Public pages keep their original 400/500 Mono face list because adding 600 changes bold matching. Space retains separate CSS declarations for 400/500/700, even though all three share one variable file.

Modified font names are ClockedSpace and ClockedMono internally. CSS family aliases and fallback stacks stay unchanged. The IBM source reserves the name Plex; both OFL notices are shipped with the assets. CSS keeps `font-display: swap`.

## Verify pixels and downloads

Install Playwright separately, then set the two paths for your machine:

```powershell
$env:FONT_AUDIT_PLAYWRIGHT='C:/path/to/node_modules/playwright/index.mjs'
# Optional when using Playwright's matching installed browser:
$env:FONT_AUDIT_CHROMIUM='C:/path/to/chrome.exe'
node worker/scripts/verify-fonts.mjs
py -3 worker/scripts/diff-fonts.py
npm --prefix worker run build
npm --prefix worker run typecheck
```

`verify-fonts.mjs` uses the checked-in original HTML and Google response bodies in `artifacts/font-audit`, then renders the current source against the same content. It freezes the clock and mocks signed-out API responses. News uses an explicit deterministic post fixture. It checks desktop and mobile, accents, code, italic/bold combinations, inline weights, workspace component styles, automatic hyphenation, and CJK system font selection. It rejects font decoder errors and extended downloads on core-only pages. `diff-fonts.py` compares every RGB channel exactly and fails on any changed pixel or image size. It writes before/after/diff PNGs plus JSON to `artifacts/font-verification`.

These checks cover Chromium on Windows at device scale 1. They do not establish equivalence on every browser/OS or cover arbitrary authenticated account data. Workspace typography uses a fixture with the real stylesheet, including component overrides, rather than a live account.

`audit-fonts.mjs` and `inspect-fonts.py` produced the original baseline. Preserve that baseline before using the capture script again; it overwrites files and fetches current Google responses. Do not overwrite it with the optimized site and use that as proof against the original.

See the measured results and rejected experiments in `artifacts/font-audit/README.md`. Embedding font data in CSS and idle precaching remain deferred.
