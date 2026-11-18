#!/usr/bin/env python3
"""Draws MinimalTube's logo in every colour theme: an SVG and the PNG sizes the extension and the
launchers use. Run it after changing the logo or a theme's colour; it needs `rsvg-convert` (librsvg),
which only the developer's machine needs: the PNGs are shipped.

    python3 -B .github/make-icons.py

Writes extension/icons/icon<size>.png (Violet, the default: the manifest's icons) and
extension/icons/themes/<theme>/logo.svg + icon<size>.png for every theme, Violet included.
"""
import math
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ICONS = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 64, 128, 256, 512)

# The logo's base colour per theme (the ids are the ones in extension/js/common.js THEMES).
THEMES = {
    "violet": "#8a5cf5",
    "crimson": "#ff0033",
    "clay": "#d97757",
    "mint": "#3fbf8c",
    "sky": "#4a90f0",
    "sakura": "#e56aa0",
}
# The first logo's nine bands, light to dark, around Violet's base colour: every theme keeps the
# same steps from its own base (OKLCH lightness difference, chroma ratio, hue difference).
BANDS = ["#d0b5fe", "#ba9bfe", "#aa80fe", "#9d6dfd", "#945dfb", "#8851f4", "#8350fd", "#7c45fc", "#6b2ff3"]


def hex2rgb(h):
    return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def delin(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def to_oklch(h):
    r, g, b = map(lin, hex2rgb(h))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


def _rgb(L, C, H):
    a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]


def from_oklch(L, C, H):
    def outside(v):
        return any(x < -1e-4 or x > 1 + 1e-4 for x in v)
    rgb = _rgb(L, C, H)
    if outside(rgb):  # out of sRGB: less chroma until it fits, same lightness and hue
        lo, hi = 0.0, C
        for _ in range(24):
            mid = (lo + hi) / 2
            lo, hi = (lo, mid) if outside(_rgb(L, mid, H)) else (mid, hi)
        rgb = _rgb(L, lo, H)
    return "#" + "".join(f"{round(min(1, max(0, delin(min(1, max(0, x))))) * 255):02x}" for x in rgb)


def band_colors(base):
    if base == THEMES["violet"]:
        return BANDS[:]
    bl, bc, bh = to_oklch(THEMES["violet"])
    steps = [(l - bl, c / bc, h - bh) for l, c, h in map(to_oklch, BANDS)]
    L, C, H = to_oklch(base)
    up = max(s[0] for s in steps)
    k = max(0.0, (0.96 - L) / up) if L + up > 0.96 else 1.0  # light bases: smaller upward steps
    return [from_oklch(L + (dl * k if dl > 0 else dl), C * cr, H + dh) for dl, cr, dh in steps]


def logo_svg(base):
    bands = band_colors(base)
    cx, cy = 262, -18  # the waves' centre, past the top-right corner: lightest there, darker down-left
    paths = []
    for k in range(8):
        radius, pts = 330 - k * 34, []
        for a in range(70, 202, 2):
            th = math.radians(a)
            r = radius + 13 * math.sin(th * 3.1 + k * 0.55)
            pts.append(f"{cx + r * math.cos(th):.1f},{cy + r * math.sin(th):.1f}")
        paths.append(f'<path d="M{cx},{cy} L{" L".join(pts)} Z" fill="{bands[7 - k]}"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">'
            '<defs><clipPath id="c"><rect width="256" height="256" rx="58"/></clipPath>'
            '<filter id="s" x="-20%" y="-20%" width="140%" height="140%">'
            '<feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity=".22"/></filter></defs>'
            f'<g clip-path="url(#c)"><rect width="256" height="256" fill="{bands[8]}"/>{"".join(paths)}</g>'
            '<path d="M98 78 Q90 74 90 84 L90 172 Q90 182 98 178 L178 133 Q186 128 178 123 Z" fill="#fdfcfe" '
            'stroke="#fdfcfe" stroke-width="10" stroke-linejoin="round" filter="url(#s)"/></svg>\n')


def main():
    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert (librsvg) is needed")
    for theme, base in THEMES.items():
        out = ICONS / "themes" / theme
        out.mkdir(parents=True, exist_ok=True)
        svg = out / "logo.svg"
        svg.write_text(logo_svg(base), encoding="utf-8")
        for size in SIZES:
            subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out / f"icon{size}.png"),
                            str(svg)], check=True)
        print(theme, " ".join(band_colors(base)))
    for size in SIZES[:-1]:  # the manifest's icons: Violet
        shutil.copyfile(ICONS / "themes" / "violet" / f"icon{size}.png", ICONS / f"icon{size}.png")


if __name__ == "__main__":
    main()
