"""The RECON mark -- the "Socket R".

A six-point drive hex with the monogram knocked out of it: the tool a technician
puts on the fastener, not a dealership crest. One source of truth, drawn from
primitives so it stays legible at 16px where a font-rendered letter turns to mush.

Used by `installers/make_icon.py` (favicon + exe icon) and by `tray_app` (the
system-tray glyph, tinted to signal whether the server is up).
"""

from __future__ import annotations

import math

from PIL import Image, ImageDraw, ImageFilter

# The app's default "harbor" theme, so the mark and the UI it launches read as
# the same product.
NAVY = (12, 17, 24, 255)  # --paper
AZURE = (63, 139, 217, 255)  # --accent
AZURE_LT = (103, 163, 225, 255)  # --accent-strong
CRIT = (196, 70, 58, 255)  # --crit, darkened for the tray
CRIT_LT = (224, 86, 74, 255)  # --crit
CLEAR = (0, 0, 0, 0)

R_OUTER = 0.495  # hex radius as a fraction of the canvas
SQUASH = 1.135  # stretch so a flat-top hex fills the square
CORNER = 0.030  # corner radius
CHAMFER_AT = 0.855  # machined bevel, fraction of the hex radius


def hexagon(cx: float, cy: float, r: float, squash: float = 1.0) -> list[tuple[float, float]]:
    """Flat-top hexagon -- vertices left and right, horizontal top and bottom
    edges, the way a bolt head is conventionally drawn."""
    return [
        (cx + r * math.cos(math.radians(60 * i)), cy + r * math.sin(math.radians(60 * i)) * squash) for i in range(6)
    ]


def _round_mask(pts, corner: float, size: int) -> Image.Image:
    """Uniform corner rounding by rasterise -> blur -> threshold. Rounds every
    corner by the same amount whatever angle it sits at; dilating a stroke does
    not, and the unevenness shows badly on a stretched hexagon."""
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.filter(ImageFilter.GaussianBlur(corner)).point(lambda v: 255 if v >= 128 else 0)


def _vertical_gradient(top, bottom, mask: Image.Image, size: int) -> Image.Image:
    g = Image.new("RGBA", (1, size), top)
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4)))
    out = Image.new("RGBA", (size, size), CLEAR)
    out.paste(g.resize((size, size), Image.NEAREST), (0, 0), mask)
    return out


def letter_r_mask(x: float, y: float, w: float, h: float, size: int) -> Image.Image:
    """Geometric R: heavy stem, D-shaped bowl, short kicked leg with flat
    terminals. The leg stops inside the bowl's right edge -- run it past and the
    letter starts reading as a tail rather than an R."""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    stem = w * 0.31
    bar = h * 0.155  # bowl stroke weight
    bowl_h = h * 0.56
    cap = bowl_h / 2

    d.rectangle([x, y, x + w - cap, y + bowl_h], fill=255)
    d.ellipse([x + w - bowl_h, y, x + w, y + bowl_h], fill=255)
    d.rectangle([x, y, x + stem, y + h], fill=255)

    ch = bowl_h - 2 * bar  # counter, same D construction inset
    cl, ct, cr = x + stem + bar, y + bar, x + w - bar
    if cr - ch / 2 > cl:
        d.rectangle([cl, ct, cr - ch / 2, ct + ch], fill=0)
    d.ellipse([cr - ch, ct, cr, ct + ch], fill=0)

    legw = stem * 1.20
    sx = x + stem * 0.55
    sy = y + bowl_h - bar * 1.05
    ex = x + w - legw * 1.02
    d.polygon([(sx, sy), (sx + legw, sy), (ex + legw, y + h), (ex, y + h)], fill=255)
    return m


def render(
    out_size: int = 256, *, body_top=AZURE_LT, body_bottom=AZURE, letter=NAVY, supersample: int = 4
) -> Image.Image:
    """The mark at `out_size` px. Drawn oversized and downsampled with LANCZOS,
    which is what keeps the small sizes from going ragged."""
    size = out_size * supersample
    im = Image.new("RGBA", (size, size), CLEAR)
    cx = cy = size / 2
    r = size * R_OUTER

    body = _round_mask(hexagon(cx, cy, r, SQUASH), size * CORNER, size)
    im = Image.alpha_composite(im, _vertical_gradient(body_top, body_bottom, body, size))

    # The chamfer resolves around 128px and dissolves cleanly below it, so the
    # large exe icon gets depth without the tab favicon picking up noise.
    cp = hexagon(cx, cy, r * CHAMFER_AT, SQUASH)
    ImageDraw.Draw(im).line(cp + [cp[0]], fill=(12, 17, 24, 52), width=max(1, int(size * 0.017)), joint="curve")

    w, h = size * 0.40, size * 0.485
    im.paste(
        Image.new("RGBA", (size, size), letter),
        (0, 0),
        letter_r_mask(cx - w / 2 - size * 0.006, cy - h / 2, w, h, size),
    )

    return im.resize((out_size, out_size), Image.LANCZOS)
