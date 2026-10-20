"""Render the iOS app icon (1024x1024, opaque) in the Clocked amber clock style.

    py mobile/ios/scripts/gen_app_icon.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 2
S = SIZE * SS
BG = (10, 11, 16, 255)
AMBER = (242, 169, 80, 255)
AMBER2 = (255, 138, 61, 255)
cx = cy = S / 2

img = Image.new("RGBA", (S, S), BG)
ring_r = S * 0.30
ring_w = int(S * 0.055)

glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse(
    [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], outline=AMBER[:3] + (255,), width=ring_w * 2
)
img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.04)))
draw = ImageDraw.Draw(img)
for i in range(12):
    ang = math.radians(i * 30 - 90)
    r_out = ring_r - ring_w * 0.9
    r_in = r_out - (S * 0.03 if i % 3 == 0 else S * 0.018)
    a = 210 if i % 3 == 0 else 110
    draw.line(
        [cx + r_out * math.cos(ang), cy + r_out * math.sin(ang), cx + r_in * math.cos(ang), cy + r_in * math.sin(ang)],
        fill=AMBER[:3] + (a,), width=int(S * 0.012),
    )
draw.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], outline=AMBER, width=ring_w)


def hand(angle_deg, length, width, color):
    ang = math.radians(angle_deg - 90)
    draw.line([cx, cy, cx + length * math.cos(ang), cy + length * math.sin(ang)], fill=color, width=width)
    r = width / 2
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)


hand(300, ring_r * 0.5, int(S * 0.04), AMBER)
hand(60, ring_r * 0.72, int(S * 0.028), AMBER2)

out = Path(__file__).resolve().parent.parent / "App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
img.resize((SIZE, SIZE), Image.LANCZOS).convert("RGB").save(out)
print(out)
