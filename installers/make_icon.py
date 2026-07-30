"""Writes the RECON mark out to static/ as browser and exe icons.

The mark itself lives in `app/mark.py` so the tray glyph and these files can
never drift apart. This script only rasterises it and emits the vector twin.

Outputs, all into static/:
    favicon.ico   multi-resolution 16/24/32/48/64/128/256 -- browser fallback
                  and the PyInstaller `icon=` in DiscountAutoOps.spec
    favicon.svg   crisp scalable version for modern browsers
    icon-180.png  apple-touch-icon / large PNG fallback

Regenerate with:  .venv/Scripts/python installers/make_icon.py
"""

from __future__ import annotations

import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # so `app.mark` imports when run directly

from app import mark

STATIC = ROOT / "static"
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
VB = 1024  # SVG viewBox units


def rounded_polygon_path(pts, radius: float) -> str:
    """SVG path for a polygon with uniformly rounded corners: trim `radius` back
    along both edges of each vertex, then join the trimmed ends with an arc."""
    n = len(pts)
    trims = []
    for i in range(n):
        prv, cur, nxt = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        pair = []
        for other in (prv, nxt):
            vx, vy = other[0] - cur[0], other[1] - cur[1]
            ln = math.hypot(vx, vy) or 1.0
            d = min(radius, ln / 2)
            pair.append((cur[0] + vx / ln * d, cur[1] + vy / ln * d))
        trims.append(tuple(pair))  # (incoming, outgoing)

    parts = [f"M {trims[0][0][0]:.2f},{trims[0][0][1]:.2f}"]
    for i, (a, b) in enumerate(trims):
        if i:
            parts.append(f"L {a[0]:.2f},{a[1]:.2f}")
        parts.append(f"A {radius:.2f},{radius:.2f} 0 0 1 {b[0]:.2f},{b[1]:.2f}")
    parts.append("Z")
    return " ".join(parts)


def build_svg() -> str:
    """The same geometry as `mark.render`, expressed as vectors. The R is one
    path whose counter is wound the opposite way, so the nonzero fill rule
    punches it out rather than filling it."""
    cx = cy = VB / 2
    r = VB * mark.R_OUTER
    body = rounded_polygon_path(mark.hexagon(cx, cy, r, mark.SQUASH), VB * mark.CORNER)
    cp = mark.hexagon(cx, cy, r * mark.CHAMFER_AT, mark.SQUASH)
    chamfer = "M " + " L ".join(f"{x:.2f},{y:.2f}" for x, y in cp) + " Z"

    w, h = VB * 0.40, VB * 0.485
    x, y = cx - w / 2 - VB * 0.006, cy - h / 2
    stem, bar = w * 0.31, h * 0.155
    bowl_h = h * 0.56
    cap = bowl_h / 2
    legw = stem * 1.20
    sx, sy = x + stem * 0.55, y + bowl_h - bar * 1.05
    ex = x + w - legw * 1.02
    ch = bowl_h - 2 * bar
    cl, ct, cr = x + stem + bar, y + bar, x + w - bar
    ccx = cr - ch / 2  # centre x of the counter's arc

    r_path = (
        # bowl + stem, clockwise
        f"M {x:.2f},{y:.2f} L {x + w - cap:.2f},{y:.2f} "
        f"A {cap:.2f},{cap:.2f} 0 0 1 {x + w - cap:.2f},{y + bowl_h:.2f} "
        f"L {x + stem:.2f},{y + bowl_h:.2f} L {x + stem:.2f},{y + h:.2f} "
        f"L {x:.2f},{y + h:.2f} Z "
        # Counter, wound anticlockwise so nonzero cuts it out. sweep-flag 0 is
        # what bulges the cap to the right; with 1 the arc doubles back through
        # the stem and the hole collapses to a crescent.
        f"M {cl:.2f},{ct:.2f} L {cl:.2f},{ct + ch:.2f} L {ccx:.2f},{ct + ch:.2f} "
        f"A {ch / 2:.2f},{ch / 2:.2f} 0 0 0 {ccx:.2f},{ct:.2f} Z "
        # leg
        f"M {sx:.2f},{sy:.2f} L {sx + legw:.2f},{sy:.2f} "
        f"L {ex + legw:.2f},{y + h:.2f} L {ex:.2f},{y + h:.2f} Z"
    )

    def hx(c):
        r, g, b = c[:3]
        return f"#{r:02x}{g:02x}{b:02x}"

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB} {VB}" width="{VB}" height="{VB}">
  <title>RECON</title>
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{hx(mark.AZURE_LT)}"/>
      <stop offset="1" stop-color="{hx(mark.AZURE)}"/>
    </linearGradient>
  </defs>
  <path d="{body}" fill="url(#body)"/>
  <path d="{chamfer}" fill="none" stroke="{hx(mark.NAVY)}" stroke-opacity=".20"
        stroke-width="{VB * 0.017:.1f}" stroke-linejoin="round"/>
  <path d="{r_path}" fill="{hx(mark.NAVY)}" fill-rule="nonzero"/>
</svg>
"""


def main() -> None:
    master = mark.render(256, supersample=4)
    master.save(STATIC / "favicon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    mark.render(180, supersample=4).save(STATIC / "icon-180.png")
    (STATIC / "favicon.svg").write_text(build_svg(), encoding="utf-8")

    for name in ("favicon.ico", "favicon.svg", "icon-180.png"):
        p = STATIC / name
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
