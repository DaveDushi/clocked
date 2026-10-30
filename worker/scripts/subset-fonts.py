"""Manual only: py -3 worker/scripts/subset-fonts.py.
Requires fonttools[woff]==4.66.0. Sources are pinned in worker/fonts/source.
Rerun after text, font styles/features/weights, or upstream fonts change.
"""
import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

parser = argparse.ArgumentParser()
parser.add_argument('--drop-hinting', action='store_true', help='Experimental: requires pixel review')
parser.add_argument('--clip-weight', action='store_true', help='Experimental: requires pixel review')
parser.add_argument('--ascii-core', action='store_true', help='Experimental: changes shaping boundaries; requires pixel review')
parser.add_argument('--refresh-sources', action='store_true', help='Download current upstream sources; requires a new baseline and pixel review')
args = parser.parse_args()
args.keep_hinting = not args.drop_hinting
root = Path(__file__).resolve().parents[1]
output = root / 'public/fonts'
output.mkdir(parents=True, exist_ok=True)
core = set(range(32, 127)) | {0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026}
characters = set(range(32, 384)) | core
for path in (root / 'src').glob('*'):
    if path.suffix in ['.ts', '.html']:
        characters.update(ord(c) for c in path.read_text(encoding='utf-8') if ord(c) < 0x2e80)
inventory = json.loads((root.parent / 'artifacts/font-audit/font-inventory.json').read_text())
if args.refresh_sources:
    requested = sorted(p for p in characters if p >= 32)
    url = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap&text=' + urllib.parse.quote(''.join(map(chr, requested)))
    css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'})).read().decode()
    urls = list(dict.fromkeys(re.findall(r'url\(([^)]+)\)', css)))
    assert len(urls) == 4, 'Unexpected upstream face count; inspect before proceeding'
    for name, source_url in zip(['plex-400', 'plex-500', 'plex-600', 'space'], urls):
        (root / 'fonts/source' / (name + '.woff2')).write_bytes(urllib.request.urlopen(source_url).read())
    (root / 'fonts/source/google.css').write_text(css)
    (root / 'fonts/source/request.json').write_text(json.dumps({'url': url, 'codepoints': requested}, indent=2))
rules = []
report = []
files = {}
for name, family, weights in [('space', 'Space Grotesk', [400, 500, 700]), ('plex-400', 'IBM Plex Mono', [400]), ('plex-500', 'IBM Plex Mono', [500]), ('plex-600', 'IBM Plex Mono', [600])]:
    path = root / 'fonts/source' / (name + '.woff2')
    original = TTFont(path)
    source_names = {n.toUnicode() for n in original['name'].names if n.nameID in [1, 16]}
    assert any(family in n for n in source_names), f'Unexpected source family: {source_names}'
    if name != 'space': assert original['OS/2'].usWeightClass == weights[0]
    # Preserve original webfont coverage: characters outside it keep using fallback.
    supported = set()
    matching_core = set(core)
    for item in inventory:
        if item['declarations'][0]['font-family'].strip("'") == family:
            cmap = set(TTFont(root.parent / 'artifacts/font-audit' / item['file']).getBestCmap())
            supported.update(cmap)
            if 'U+0000-00FF' in item['declarations'][0]['unicode-range']:
                matching_core.update(cmap)
    missing = {p for p in characters & supported - set(original.getBestCmap()) if p >= 32}
    assert not missing, f'{name}: pinned source lacks {sorted(missing)}; refresh sources and review pixels'
    wanted = set(original.getBestCmap()) & characters & supported
    if args.ascii_core: matching_core = core
    for part, points in [('core', wanted & matching_core), ('extended', wanted - matching_core)]:
        font = TTFont(path, recalcTimestamp=False)
        # Axis clipping is tested separately: moving the default can alter rounding.
        if args.clip_weight and 'fvar' in font:
            font = instantiateVariableFont(font, {'wght': (400, 700)}, inplace=True)
        options = subset.Options()
        options.hinting = args.keep_hinting
        options.layout_features = ['ccmp', 'locl', 'liga', 'clig', 'calt', 'kern', 'mark', 'mkmk', 'rvrn', 'tnum']
        options.recalc_timestamp = False
        options.name_IDs = ['*']
        tool = subset.Subsetter(options=options)
        tool.populate(unicodes=points)
        tool.subset(font)
        # Rename modified fonts even when no Reserved Font Name is present.
        for record in font['name'].names:
            if record.nameID in [1, 2, 3, 4, 6, 16, 17, 18, 21, 22, 25]:
                value = ('ClockedSpace' if name == 'space' else 'ClockedMono' + name[5:])
                if record.nameID in [2, 17]: value = 'Regular'
                record.string = value.encode(record.getEncoding(), errors='replace')
        font.flavor = 'woff2'
        buf = BytesIO()
        font.save(buf)
        data = buf.getvalue()
        filename = f'{name}-{part}-{hashlib.sha256(data).hexdigest()[:12]}.woff2'
        (output / filename).write_bytes(data)
        check = TTFont(BytesIO(data))
        actual = set(check.getBestCmap())
        assert actual == points, (name, part, actual ^ points)
        assert args.keep_hinting or not any(t in check for t in ['fpgm', 'prep', 'cvt '])
        groups = []
        for point in sorted(actual):
            if groups and point == groups[-1][1] + 1: groups[-1][1] = point
            else: groups.append([point, point])
        ranges = ','.join(f'U+{a:X}' + (f'-{b:X}' if b != a else '') for a, b in groups)
        for weight in weights:
            rules.append(f"@font-face{{font-family:'{family}';font-style:normal;font-weight:{weight};font-display:swap;src:url('/fonts/{filename}') format('woff2');unicode-range:{ranges};}}")
        files[name + '-' + part] = filename
        report.append({'face': name, 'part': part, 'file': filename, 'bytes': len(data), 'glyphs': check['maxp'].numGlyphs, 'codepoints': sorted(actual), 'hinting': args.keep_hinting})
css = '\n'.join(rules) + '\n'
cssname = 'fonts-' + hashlib.sha256(css.encode()).hexdigest()[:12] + '.css'
(output / cssname).write_text(css, encoding='utf-8', newline='\n')
publiccss = '\n'.join(r for r in rules if 'font-weight:600;' not in r) + '\n'
publicname = 'fonts-' + hashlib.sha256(publiccss.encode()).hexdigest()[:12] + '.css'
(output / publicname).write_text(publiccss, encoding='utf-8', newline='\n')
def head(dashboard, news=False):
    names = ['space', 'plex-400'] + ([] if news else ['plex-500'])
    return '\n'.join(f'<link rel="preload" href="/fonts/{files[n + "-core"]}" as="font" type="font/woff2" crossorigin />' for n in names) + f'\n<link rel="stylesheet" href="/fonts/{cssname if dashboard else publicname}" />'
(root / 'src/font-head.ts').write_text('// Generated by scripts/subset-fonts.py. Do not edit.\nexport const FONT_HEAD = ' + json.dumps(head(True)) + ';\nexport const PUBLIC_FONT_HEAD = ' + json.dumps(head(False)) + ';\nexport const NEWS_FONT_HEAD = ' + json.dumps(head(False, True)) + ';\n', encoding='utf-8')
(root / 'fonts/subsets.json').write_text(json.dumps(report, indent=2) + '\n')
keep = set(files.values()) | {cssname, publicname}
for old in output.iterdir():
    if old.suffix in ['.woff2', '.css'] and old.name not in keep:
        old.unlink()
print(json.dumps([{k: v for k, v in row.items() if k != 'codepoints'} for row in report], indent=2))
