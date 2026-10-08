"""The site's poster for the hero video: its first frame, slightly dimmed, with a play button.

    uv run --with pillow python scripts/hero-video/poster.py ~/demos/obeya-hero/demo.mp4 site/img/hero-poster.jpg
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

video, out = sys.argv[1], sys.argv[2]
with tempfile.TemporaryDirectory() as tmp:
    frame = Path(tmp) / "frame.png"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "0.6", "-i", video, "-frames:v", "1", str(frame)], check=True)
    im = Image.open(frame).convert("RGBA")
w, h = im.size
s = 4  # drawn four times larger and scaled down, for smooth edges
button = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
d = ImageDraw.Draw(button)
cx, cy, r, ring, t = w * s // 2, h * s // 2, 60 * s, 14 * s, 26 * s
d.ellipse([cx - r - ring, cy - r - ring, cx + r + ring, cy + r + ring], fill=(255, 255, 255, 96))
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(28, 27, 25, 215))
d.polygon([(cx - t * 0.75 + 6 * s, cy - t), (cx - t * 0.75 + 6 * s, cy + t), (cx + t * 1.05 + 6 * s, cy)], fill=(255, 255, 255, 255))
button = button.resize((w, h), Image.LANCZOS)
dim = Image.new("RGBA", (w, h), (28, 27, 25, 18))
Image.alpha_composite(Image.alpha_composite(im, dim), button).convert("RGB").save(out, quality=82, optimize=True, progressive=True)
