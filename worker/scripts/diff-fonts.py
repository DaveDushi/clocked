"""Strict pixel comparison, without a tolerance or anti-aliasing exclusions."""
import json
from pathlib import Path
from PIL import Image, ImageChops
root = Path(__file__).resolve().parents[2] / 'artifacts/font-verification'
results = []
for path in sorted(root.glob('*-before.png')):
    if path.name.startswith('crop-'): continue
    before = Image.open(path).convert('RGB')
    after = Image.open(str(path).replace('-before.png', '-after.png')).convert('RGB')
    if before.size != after.size:
        results.append({'case': path.stem[:-7], 'sizeBefore': before.size, 'sizeAfter': after.size, 'pixelsChanged': 'size mismatch'})
        continue
    diff = ImageChops.difference(before, after)
    count = sum(pixel != (0, 0, 0) for pixel in diff.getdata())
    diff.save(str(path).replace('-before.png', '-diff.png'))
    results.append({'case': path.stem[:-7], 'pixelsChanged': count, 'pixels': before.width * before.height, 'bbox': diff.getbbox()})
(root / 'pixels.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
raise SystemExit(any(r['pixelsChanged'] != 0 for r in results))
