# Font optimization results

Clocked now serves checked-in, hashed WOFF2 subsets. Generation is manual and absent from the build. Font display, fallback stacks, weight matching, and synthesized italics are unchanged. No deployment was performed.

## Bytes per font

Original Google Latin and Latin Extended faces versus the two new files. Bytes exclude HTTP headers and CSS. The full inventory of all 18 original language files, with glyph counts, axes, features and hinting, is in `font-inventory.json`.

| Face | Original Latin | Original extended | New core | New extended | Total before | Total after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Space Grotesk, variable | 22,288 | 18,940 | 18,156 | 8,996 | 41,228 | 27,152 |
| Mono 400 | 14,708 | 13,348 | 11,864 | 7,516 | 28,056 | 19,380 |
| Mono 500 | 14,888 | 13,432 | 12,060 | 7,556 | 28,320 | 19,616 |
| Mono 600 | 15,620 | 14,328 | 12,796 | 8,456 | 29,948 | 21,252 |
| All four | 67,504 | 60,048 | 54,876 | 32,524 | 127,552 | 87,400 |

The combined Latin/extended footprint falls 31.5%. This does not mean every page downloads every file. Original Latin/extended glyph counts are Space 291/429 and each Mono 280/285. New core/extended counts are Space 251/199 and each Mono 220/186, including composite/shaping dependencies. Exact cmaps are in `worker/fonts/subsets.json`. Generated-file features, axes, names and hinting are in `artifacts/font-verification/font-inventory.json`.

## Bytes per page

Cold contexts at both 1440 and 390 CSS pixels, Windows Chromium 1248, device scale 1. Home is signed out; news has the same deterministic post in both versions.

| Page/case | Before | After | Saved |
| --- | ---: | ---: | ---: |
| Home | 51,884 | 42,080 | 9,804 |
| Press | 51,884 | 42,080 | 9,804 |
| Extension privacy | 51,884 | 42,080 | 9,804 |
| News fixture | 36,996 | 30,020 | 6,976 |
| Privacy | 0 | 0 | 0 |
| Terms | 0 | 0 | 0 |
| Typography fixture, all faces and extensions | 127,552 | 87,400 | 40,152 |
| Synthetic CJK-only document using home head | 22,288 | 42,080 | -19,792 |

Normal public pages save about 18.9% of font bytes. The artificial CJK-only case pays for preloaded Mono faces it does not render. This is the cost of unconditional core preloads; there is no CJK-only production route. Its CJK glyphs use the same Microsoft YaHei and Malgun Gothic system fonts before and after. The custom font renders only spaces in that run.

Originally no page preloaded fonts. Home/press/extension privacy now preload Space core and Mono 400/500 core. News preloads Space and Mono 400 core. Legal pages still load none. Mono 600 core is demand-loaded rather than preloaded on signed-out pages, avoiding 12,796 unused bytes. All extended files are demand-loaded. Home, press, extension privacy, news, and CJK-only requested zero extended files. The typography fixture requested all four extended files. `artifacts/font-verification/network.json` lists every URL and size.

The original stylesheet added 9,685 body bytes on home and 7,738 on public marketing pages. New stylesheets are local; their filenames and actual sizes are in `worker/public/fonts`. Font-byte tables exclude stylesheet bytes.

## Rendering proof

All 16 full-page comparisons passed with **zero changed RGB pixels out of 29,239,960 pixels**. No tolerance, antialiasing exclusion, or rounding waiver was used. There were no content differences in accepted comparisons and no remaining visible differences to classify.

Before/after/diff PNGs and counts are in `artifacts/font-verification`. Diff images are black because the images are identical. The clock is frozen; both versions receive the same signed-out API responses. The final after captures render current source, including the actual generated head imports, against pinned original content. A built Worker preview separately verified the home head and all eight font response bodies, MIME types, immutable caching, and CORS. Build and TypeScript checks passed.

The typography fixture covers code, Latin-1 and Extended-A accents at all CSS weights, italic/bold combinations, workspace component classes and inline overrides, automatic hyphenation, U+2010, and CJK. This proves the tested Windows Chromium configurations, not every browser/OS. Workspace typography uses the real stylesheet in a fixture rather than a live account. Dynamic account names and future news content require review when introducing characters.

## Actual use and preserved behavior

`source-styles.json` records stylesheets and inline component settings; `pages-before.json` records initial visible text/computed styles. Both families use normal faces only, so italics remain synthesized. Space uses discrete CSS faces 400/500/700; a 600 override still matches 700. Mono has 400/500/600 on the dashboard and 400/500 on public pages. Public 700 headings keep their original matching and synthesis. Tabular numerals remain enabled where requested. No production `font-variation-settings`, explicit `font-feature-settings`, or `hyphens:auto` declarations were found. Hyphenation is included as an explicit test case and U+2010 is retained.

Unused discretionary OpenType features were removed. The allowlist keeps default shaping/positioning plus `tnum`; empty features disappear. Generated Space core has `liga`, `locl`, `tnum`, and `kern`; extended has `locl` and `kern`. Generated Mono GSUB/GPOS lists are empty. No fallback face sits between core and extended. Every unicode range comes from that file's actual cmap; adjacent points are compacted without filling holes.

The IBM OFL reserves Plex. Modified internal names are ClockedMono and ClockedSpace; copyright/license notices remain intact and both licenses ship with the assets. CSS aliases keep the existing family names and fallback stacks. See the pinned OFL files and [IBM license](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt).

## Rejected optimizations and deviations

Rendering takes precedence over savings. Experimental flags reproduce these options but are off by default.

* **ASCII-only core:** saves another 15,652 bytes on normal public pages, but splitting accented words between files changes kerning. The accepted core follows the original Google Latin boundary, including supported Latin-1 and a few existing Extended characters. Remaining Extended-A characters stay lazy. The rejected fixture showed 6,120 changed desktop pixels and 5,486 mobile pixels with the other settings held constant.
* **Axis clipping:** reducing Space from 300-700 to 400-700 saves 164 bytes on a core-only page and 200 across both files. Moving the variable default changes raster rounding, including 1,901 desktop-home pixels and 1,004 mobile-home pixels. The original axis range remains. These are rejected regressions, not accepted subpixel differences.
* **Removing hinting:** saves another 8,564 bytes on a normal page and 23,140 across all eight files. It changes text pixels, including 48 desktop-home pixels and 1,671 desktop extension-privacy pixels. Hinting and raster-related tables remain. Space has no glyph instructions; Mono retains TrueType instructions for retained glyphs.
* **Public Mono 600:** adding this face changed public bold headings. Separate public/dashboard stylesheets preserve the original face availability. Mono 600 is not preloaded because it is unused on signed-out home.

Rejected experiment JSON records are retained here. Earlier filenames differ because internal naming was subsequently finalized; the savings above were remeasured with the final names. No visual differences were approved or shipped. Experimental prototype HTML is outside this production-site change.

## Rerun

See `worker/fonts/README.md` for setup and verification. The default command is:

```powershell
py -3 worker/scripts/subset-fonts.py
```

Rerun after text, font features/weights, inline styles, or source changes; run `verify-fonts.mjs` and `diff-fonts.py` before committing output. Sources and original response bodies are pinned, so regeneration and comparison need no network by default. `--refresh-sources` opts into new upstream files and requires a new review. Embedding core font data in CSS and idle precaching remain deferred.
