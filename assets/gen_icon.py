"""Generate assets/clocked.ico — a round black-and-amber clock icon.

A dark disc with a glowing amber rim, amber ticks and hands. Matches the
web favicon's look but stays circular (a clock face) so it reads well as a
Windows tray / taskbar icon. Drawn supersampled then downscaled with LANCZOS
so the ring and hands stay crisp all the way down to 16px.

Run with the Windows Python that has Pillow installed, e.g.
  %LOCALAPPDATA%\\Programs\\Python\\Python313\\python.exe assets/gen_icon.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

S = 1024                       # supersample canvas
CX = CY = S / 2
R = S * 0.46                   # disc radius

DARK = (10, 11, 16, 255)       # near-black clock face
AMBER = (245, 166, 60, 255)    # amber ring / hands
AMBER_HI = (241, 180, 107, 255)  # lighter amber highlight
GLOW = (245, 166, 60)          # glow colour

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# --- amber glow behind the rim, so it pops on dark taskbars ---
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([CX - R, CY - R, CX + R, CY + R], outline=GLOW + (255,),
           width=int(S * 0.10))
glow = glow.filter(ImageFilter.GaussianBlur(radius=S * 0.03))
img = Image.alpha_composite(img, glow)

d = ImageDraw.Draw(img)

# --- dark disc face ---
face_r = R - S * 0.02
d.ellipse([CX - face_r, CY - face_r, CX + face_r, CY + face_r], fill=DARK)

# --- amber rim ---
ring_w = int(S * 0.075)
d.ellipse([CX - R, CY - R, CX + R, CY + R], outline=AMBER, width=ring_w)

# --- hour ticks (majors at 12/3/6/9) ---
for i in range(12):
    a = math.radians(i * 30)
    outer = R - ring_w * 1.1
    inner = outer - (R * 0.10 if i % 3 == 0 else R * 0.06)
    x1, y1 = CX + outer * math.sin(a), CY - outer * math.cos(a)
    x2, y2 = CX + inner * math.sin(a), CY - inner * math.cos(a)
    w = int(S * 0.022) if i % 3 == 0 else int(S * 0.014)
    alpha = 255 if i % 3 == 0 else 150
    d.line([x1, y1, x2, y2], fill=AMBER[:3] + (alpha,), width=w)

def hand(angle_deg, length, width, color):
    a = math.radians(angle_deg)
    x = CX + length * math.sin(a)
    y = CY - length * math.cos(a)
    d.line([CX, CY, x, y], fill=color, width=width)
    r = width / 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)

# minute hand up (12), hour hand to ~5 o'clock — matches the web favicon
hand(0, R * 0.62, int(S * 0.038), AMBER_HI)    # minute
hand(150, R * 0.42, int(S * 0.050), AMBER)     # hour

# --- center hub ---
hub = S * 0.035
d.ellipse([CX - hub, CY - hub, CX + hub, CY + hub], fill=AMBER_HI)

sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clocked.ico")
frames[0].save(out, format="ICO", sizes=[(s, s) for s in sizes],
               append_images=frames[1:])
# preview for eyeballing
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "_icon_preview.png"))
print("wrote", out)
