"""Manual inspection of the Google Fonts responses captured by audit-fonts.mjs.

Requires fonttools[woff]. Downloads every declared face, including faces that
were not requested by the three public-page captures. Does not modify the site.
"""
import json
import re
import urllib.request
from pathlib import Path
from fontTools.ttLib import TTFont

directory = Path(__file__).resolve().parents[2] / 'artifacts/font-audit'
network = json.loads((directory / 'network.json').read_text())
sources = {}
for entry in list(network.values()):
    if not entry['file'].endswith('.css'):
        continue
    css = (directory / entry['file']).read_text()
    for block in re.findall(r'@font-face\s*\{([^}]+)\}', css):
        url = re.search(r'src:\s*url\(([^)]+)\)', block)[1]
        sources.setdefault(url, []).append({
            key: re.search(key + r':\s*([^;]+)', block)[1]
            for key in ['font-family', 'font-style', 'font-weight', 'unicode-range']
        })
report = []
for url, declarations in sources.items():
    if url in network:
        path = directory / network[url]['file']
    else:
        path = directory / url.rsplit('/', 1)[1]
        if not path.exists():
            path.write_bytes(urllib.request.urlopen(url).read())
    font = TTFont(path)
    features = {}
    for tag in ['GSUB', 'GPOS']:
        table = font[tag].table if tag in font else None
        features[tag] = sorted({r.FeatureTag for r in table.FeatureList.FeatureRecord}) if table and table.FeatureList else []
    glyphs = [font['glyf'][name] for name in font.getGlyphOrder()] if 'glyf' in font else []
    hint_bytes = sum(len(g.program.getBytecode()) for g in glyphs if hasattr(g, 'program'))
    report.append({
        'url': url, 'file': path.name, 'bytes': path.stat().st_size,
        'declarations': declarations, 'glyphs': font['maxp'].numGlyphs,
        'characters': len(font.getBestCmap()),
        'axes': [{'tag': a.axisTag, 'min': a.minValue, 'default': a.defaultValue, 'max': a.maxValue} for a in font['fvar'].axes] if 'fvar' in font else [],
        'features': features, 'hintTables': {t: len(font.getTableData(t)) for t in ['fpgm', 'prep', 'cvt ', 'hdmx', 'LTSH', 'VDMX'] if t in font},
        'glyphInstructionBytes': hint_bytes,
        'license': sorted({n.toUnicode() for n in font['name'].names if n.nameID in [13, 14]}),
    })
(directory / 'font-inventory.json').write_text(json.dumps(report, indent=2))
print(json.dumps([{'family': x['declarations'][0]['font-family'], 'weight': x['declarations'][0]['font-weight'], 'bytes': x['bytes'], 'glyphs': x['glyphs'], 'axes': x['axes']} for x in report], indent=2))
