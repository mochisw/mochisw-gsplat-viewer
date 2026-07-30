"""手続き生成するテクスチャ。

アニメ調アバターの見た目はテクスチャが大半を決める。瞳のグラデーション、
ハイライト、睫毛、頬の赤み、髪の毛先アルファ、コートのバブル柄をすべて
ここで Pillow により描画する。bpy には依存しない。

UV の約束事:
- Blender / glTF 変換後の v=0 は画像の下端。髪は v=0 が根元なので、
  根元の色は画像の下端に描く。
- 顔パーツ(扇形パッチ)は「単位円 → パッチ楕円」でマッピングされる。
  画像上の上方向 = キャラの上方向。
"""

import math
import os
import random

from PIL import Image, ImageDraw

import palette

SS = 4  # スーパーサンプリング倍率。描画後に縮小してアンチエイリアスを得る


def _c255(rgb, a=255):
    return tuple(max(0, min(255, round(c * 255))) for c in rgb) + (a,)


def _save(img, path, size):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    img.resize(size, Image.LANCZOS).save(path)
    return path


def _lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# --- 瞳 ---------------------------------------------------------------------

def draw_iris(path, size=256):
    """瞳。中心が明るいシアン、縁が深い青。瞳孔と二段ハイライト付き。

    パッチの楕円全体に貼るので不透明で描く（形はジオメトリが決める）。
    """
    S = size * SS
    img = Image.new("RGBA", (S, S))
    px = img.load()
    C = S / 2.0
    R = S * 0.5

    inner = palette.hex_to_srgb("#A6F7FF")
    mid = palette.hex_to_srgb(palette.GLOW_CYAN)
    rim = palette.hex_to_srgb("#175C9C")
    navy = palette.hex_to_srgb(palette.DEEP_NAVY)

    for y in range(S):
        for x in range(S):
            dx, dy = (x - C) / R, (y - C) / R
            r = math.hypot(dx, dy)
            if r >= 1.0:
                col = rim
            elif r < 0.55:
                col = _lerp(inner, mid, r / 0.55)
            else:
                col = _lerp(mid, rim, (r - 0.55) / 0.45)
            # 上 1/3 は瞼の影。下 1/3 は透過光で明るく。
            if dy < -0.30:
                k = min(1.0, (-dy - 0.30) / 0.5) * 0.42
                col = _lerp(col, navy, k)
            elif dy > 0.30:
                k = min(1.0, (dy - 0.30) / 0.6) * 0.30
                col = _lerp(col, palette.hex_to_srgb(palette.LIGHT_AQUA), k)
            px[x, y] = _c255(col)

    dr = ImageDraw.Draw(img)

    def ellipse(cx, cy, rx, ry, fill):
        dr.ellipse([C + (cx - rx) * R, C + (cy - ry) * R,
                    C + (cx + rx) * R, C + (cy + ry) * R], fill=fill)

    # 瞳孔（縦長）
    ellipse(0.0, 0.02, 0.30, 0.42, _c255(navy))
    ellipse(0.0, 0.10, 0.18, 0.24, _c255(palette.hex_to_srgb("#052040")))
    # 瞳孔の中の淡い反射
    ellipse(0.0, 0.28, 0.10, 0.08, _c255(palette.hex_to_srgb("#2FB9E8"), 200))
    # メインハイライト（上・キャラの右側 = 画像左）
    ellipse(-0.38, -0.32, 0.26, 0.26, (255, 255, 255, 255))
    # サブハイライト（下・反対側）
    ellipse(0.34, 0.38, 0.11, 0.11, (255, 255, 255, 220))
    ellipse(0.16, -0.52, 0.07, 0.05, (255, 255, 255, 160))

    return _save(img, path, (size, size))


def draw_eye_white(path, size=128):
    """白目。上端に瞼の落ち影を入れる。"""
    S = size * SS
    img = Image.new("RGBA", (S, S))
    px = img.load()
    base = palette.hex_to_srgb(palette.EYE_WHITE)
    shadow = palette.hex_to_srgb("#B9C9DE")
    for y in range(S):
        t = y / (S - 1)
        k = max(0.0, (0.30 - t) / 0.30) * 0.55   # 上端ほど影
        col = _lerp(base, shadow, k)
        row = _c255(col)
        for x in range(S):
            px[x, y] = row
    return _save(img, path, (size, size))


# --- 睫毛と眉 ---------------------------------------------------------------

def _stroke_band(path, size, color, thickness_fn, yc_fn, spikes=()):
    """横方向に走る帯ストローク。睫毛・眉の共通描画。

    thickness_fn(t), yc_fn(t): t=0..1 に対する太さと中心線 (0..1 基準)。
    spikes: (t, 長さ, 幅) の下向きスパイク。
    """
    W, H = size
    SW, SH = W * SS, H * SS
    img = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    px = img.load()
    col = _c255(color)

    for x in range(SW):
        t = x / (SW - 1)
        end_fade = min(1.0, t / 0.10, (1.0 - t) / 0.10)
        if end_fade <= 0:
            continue
        th = thickness_fn(t) * SH * end_fade
        yc = yc_fn(t) * SH
        y0, y1 = int(yc - th / 2), int(yc + th / 2)
        for y in range(max(0, y0), min(SH, y1)):
            px[x, y] = col

    dr = ImageDraw.Draw(img)
    for t, ln, wd in spikes:
        x = t * SW
        yc = yc_fn(t) * SH + thickness_fn(t) * SH * 0.4
        dr.polygon([(x - wd * SW / 2, yc), (x + wd * SW / 2, yc),
                    (x, yc + ln * SH)], fill=col)
    return _save(img, path, size)


def draw_lash(path):
    """睫毛。中央が太い弧 + 下向きの小さなスパイク 3 本。"""
    return _stroke_band(
        path, (256, 128), palette.hex_to_srgb(palette.FACE_BLACK),
        thickness_fn=lambda t: 0.09 + 0.20 * math.sin(math.pi * t) ** 0.9,
        yc_fn=lambda t: 0.50 - 0.08 * math.sin(math.pi * t),
        spikes=[(0.20, 0.15, 0.035), (0.50, 0.19, 0.04), (0.80, 0.15, 0.035)],
    )


def draw_brow(path):
    """眉。中央がやや太いシンプルなストローク。"""
    return _stroke_band(
        path, (256, 64), palette.mix(palette.GLOW_CYAN, palette.DEEP_NAVY, 0.55),
        thickness_fn=lambda t: 0.16 + 0.22 * math.sin(math.pi * t),
        yc_fn=lambda t: 0.5,
    )


def draw_blush(path, size=128):
    """頬の赤み。柔らかい楕円グラデーション。"""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = img.load()
    pink = palette.hex_to_srgb("#FF9FB0")
    C = S / 2.0
    for y in range(S):
        for x in range(S):
            dx = (x - C) / (S * 0.48)
            dy = (y - C) / (S * 0.36)
            r = math.hypot(dx, dy)
            if r < 1.0:
                a = int(150 * (1.0 - r) ** 1.6)
                px[x, y] = _c255(pink, a)
    return _save(img, path, (size, size))


# --- 髪 ---------------------------------------------------------------------

def _sample_stops(stops, t):
    if t <= stops[0][0]:
        return palette.hex_to_srgb(stops[0][1])
    for i in range(len(stops) - 1):
        p0, c0 = stops[i][0], stops[i][1]
        p1, c1 = stops[i + 1][0], stops[i + 1][1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            return _lerp(palette.hex_to_srgb(c0), palette.hex_to_srgb(c1), k)
    return palette.hex_to_srgb(stops[-1][1])


def _sample_glow(stops, t):
    if t <= stops[0][0]:
        c, s = palette.hex_to_srgb(stops[0][1]), stops[0][2]
        return tuple(x * s for x in c)
    for i in range(len(stops) - 1):
        p0, c0, s0 = stops[i]
        p1, c1, s1 = stops[i + 1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            c = _lerp(palette.hex_to_srgb(c0), palette.hex_to_srgb(c1), k)
            s = s0 + (s1 - s0) * k
            return tuple(x * s for x in c)
    c, s = palette.hex_to_srgb(stops[-1][1]), stops[-1][2]
    return tuple(x * s for x in c)


def _tip_alpha(u, v):
    """毛先のスパイク形アルファ。v は根元 0 → 毛先 1。"""
    if v < 0.80:
        return 255
    wave = (0.5 + 0.35 * math.sin(2 * math.pi * 3.3 * u + 1.3)
            + 0.15 * math.sin(2 * math.pi * 7.1 * u))
    vmax = 0.84 + 0.15 * max(0.0, min(1.0, wave))
    if v < vmax - 0.015:
        return 255
    if v > vmax + 0.015:
        return 0
    return int(255 * (vmax + 0.015 - v) / 0.03)


def draw_hair_base(path, w=128, h=512):
    """髪のベースカラー。根元シアン → 毛先パープル + 毛先アルファ。"""
    img = Image.new("RGBA", (w, h))
    px = img.load()
    for y in range(h):
        v = 1.0 - y / (h - 1)          # 画像下端が v=0 = 根元
        rgb = _c255(_sample_stops(palette.HAIR_BASE_STOPS, v))[:3]
        # 束感を出す縦スジ（列ごとに僅かに明暗）
        for x in range(w):
            u = x / (w - 1)
            streak = 1.0 + 0.06 * math.sin(2 * math.pi * 9.0 * u + v * 2.0)
            col = tuple(max(0, min(255, round(c * streak))) for c in rgb)
            px[x, y] = col + (_tip_alpha(u, v),)
    img.save(path)
    return path


def draw_hair_glow(path, w=128, h=512):
    """髪の発光。毛先ほど強いパープル。アルファ形状はベースと同じ。"""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        v = 1.0 - y / (h - 1)
        rgb = _c255(_sample_glow(palette.HAIR_GLOW_STOPS, v))[:3]
        for x in range(w):
            px[x, y] = rgb
    img.save(path)
    return path


# --- コート -----------------------------------------------------------------

def draw_coat(path, size=512):
    """パールコート地 + バブル柄。裾(画像下端)ほど密度が高い。

    横方向にタイルするので、円は左右にラップして描く。
    """
    S = size
    img = Image.new("RGB", (S, S), _c255(palette.hex_to_srgb(palette.PEARL_WHITE))[:3])
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(overlay)
    rng = random.Random(7)

    colors = [
        (palette.hex_to_srgb(palette.GLOW_CYAN), 78),
        (palette.hex_to_srgb(palette.EMERALD), 62),
        (palette.hex_to_srgb(palette.GLOW_PURPLE), 50),
        (palette.hex_to_srgb(palette.LIGHT_AQUA), 88),
    ]

    def circle(x, y, r, fill, outline_only):
        for ox in (-S, 0, S):   # 横ラップ
            box = [x + ox - r, y - r, x + ox + r, y + r]
            if outline_only:
                dr.ellipse(box, outline=fill, width=max(2, r // 6))
            else:
                dr.ellipse(box, fill=fill)

    for _ in range(46):
        # 下(裾)ほど出やすく、大きい
        y = S * (1.0 - rng.random() ** 1.9)
        depth = y / S
        r = int(S * (0.012 + 0.055 * depth * rng.random()))
        if r < 3:
            continue
        x = rng.random() * S
        rgb, alpha = colors[rng.randrange(len(colors))]
        a = int(alpha * (0.55 + 0.45 * rng.random()))
        circle(x, y, r, _c255(rgb, a), outline_only=(rng.random() < 0.4))
        # 大きな泡にはハイライト
        if r > S * 0.03 and rng.random() < 0.7:
            circle(x - r * 0.3, y - r * 0.35, max(2, r // 4),
                   (255, 255, 255, 120), outline_only=False)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    img.save(path)
    return path


# --- まとめ -----------------------------------------------------------------

def generate(outdir):
    """必要なテクスチャを書き出し、キー -> パス の辞書を返す。"""
    os.makedirs(outdir, exist_ok=True)
    j = os.path.join
    return {
        "hair_base": draw_hair_base(j(outdir, "hair_base.png")),
        "hair_glow": draw_hair_glow(j(outdir, "hair_glow.png")),
        "iris": draw_iris(j(outdir, "iris.png")),
        "eye_white": draw_eye_white(j(outdir, "eye_white.png")),
        "lash": draw_lash(j(outdir, "lash.png")),
        "brow": draw_brow(j(outdir, "brow.png")),
        "blush": draw_blush(j(outdir, "blush.png")),
        "coat": draw_coat(j(outdir, "coat.png")),
    }


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "build/textures"
    for key, p in generate(out).items():
        print(f"{key}: {p}")
