"""Generate assets/clocked.ico — a simple, legible clock icon.

Drawn supersampled then downscaled with LANCZOS so it stays crisp at 16px.
White clock face + hands on an indigo disc reads well on light and dark taskbars.
"""
import math
import os
from PIL import Image, ImageDraw

S = 1024                      # supersample canvas
CX = CY = S / 2
R = S * 0.46                  # disc radius

INDIGO = (79, 70, 229, 255)   # #4F46E5
INDIGO_DK = (55, 48, 163, 255)  # ring
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Disc + slightly darker ring for depth.
d.ellipse([CX - R, CY - R, CX + R, CY + R], fill=INDIGO, outline=INDIGO_DK,
          width=int(S * 0.03))

# Hour ticks at 12/3/6/9.
tick_w = int(S * 0.028)
for ang in (0, 90, 180, 270):
    a = math.radians(ang)
    outer = R * 0.82
    inner = R * 0.66
    x1, y1 = CX + outer * math.sin(a), CY - outer * math.cos(a)
    x2, y2 = CX + inner * math.sin(a), CY - inner * math.cos(a)
    d.line([x1, y1, x2, y2], fill=WHITE, width=tick_w)

def hand(angle_deg, length, width):
    a = math.radians(angle_deg)
    x = CX + length * math.sin(a)
    y = CY - length * math.cos(a)
    d.line([CX, CY, x, y], fill=WHITE, width=width)
    # rounded cap
    r = width / 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)

# Classic 10:10 pose.
hand(305, R * 0.42, int(S * 0.045))   # hour
hand(60, R * 0.60, int(S * 0.035))    # minute

# Center hub.
hub = S * 0.035
d.ellipse([CX - hub, CY - hub, CX + hub, CY + hub], fill=WHITE)

sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clocked.ico")
frames[0].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
print("wrote", out)
