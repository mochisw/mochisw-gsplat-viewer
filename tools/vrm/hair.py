"""スプラーシュの髪と頭上パーツの造形。

髪は「ヘアカード」方式。1 房 = 折れ線に沿った 3 レールの帯（リボン）で、
毛先はテクスチャのアルファでスパイク状に抜く。チューブより
シルエットが房らしく、頂点も少ない。

カードの面はスカルプ（頭皮）の外向き法線に沿わせる。幅方向の初期ベクトル
u0 = tangent × outward で「頭の表面を撫でる」向きに立つ。

springBone 用に、長い房の中心線をチェーンとして登録する。
build() 実行後に CHAINS / STRAND_CHAINS が入る:
  CHAINS        : {チェーン名: [ジョイント座標 4 点]}
  STRAND_CHAINS : {頂点グループ名: チェーン名}  ← 揺れに追従させる房
"""

import math

import geom
import rig

# 房の分割数。
STRAND_POINTS = 12

# build() のたびに詰め直すレジストリ。
CHAINS = {}
STRAND_CHAINS = {}
_strand_seq = 0


def scalp_point(phi, theta, k=1.06):
    """頭部楕円体の表面（を k 倍したところ）の点。

    phi: 方位角。0 = キャラの左(+X)、pi/2 = 後頭部(+Y)、-pi/2 = 顔(-Y)
    theta: 天頂角。0 = 頭頂
    """
    cx, cy, cz = rig.HEAD_CENTER
    rx, ry, rz = (r * k for r in rig.HEAD_RADII)
    st, ct = math.sin(theta), math.cos(theta)
    return (cx + rx * st * math.cos(phi),
            cy + ry * st * math.sin(phi),
            cz + rz * ct)


def scalp_normal(phi, theta):
    cx, cy, cz = rig.HEAD_CENTER
    rx, ry, rz = rig.HEAD_RADII
    p = scalp_point(phi, theta, 1.0)
    return geom.normalize(((p[0] - cx) / (rx * rx),
                           (p[1] - cy) / (ry * ry),
                           (p[2] - cz) / (rz * rz)))


def _smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def strand_path(root, direction, length, points=STRAND_POINTS,
                gravity=0.35, wave_amp=0.0, wave_freq=1.3, wave_phase=0.0,
                wave_axis=(1.0, 0.0, 0.0), curl_start=1.0, curl_radius=0.0,
                curl_turns=1.5, spread=0.0):
    """1 房分の折れ線を作る。

    gravity     : 1 ステップごとに向きを真下へ寄せる割合
    wave_amp    : 横ウェーブの振幅
    curl_start  : カールが始まる位置 (0..1)。1.0 でカールなし
    curl_radius : 毛先カールの半径
    spread      : 進むほど外へ開く量
    """
    step = length / (points - 1)
    direction = geom.normalize(direction)
    out = geom.normalize((direction[0], direction[1], 0.0)) \
        if abs(direction[0]) + abs(direction[1]) > 1e-6 else (1.0, 0.0, 0.0)

    centre = [root]
    d = direction
    for i in range(1, points):
        t = i / (points - 1)
        d = geom.normalize(geom.lerp(d, (0.0, 0.0, -1.0), gravity))
        p = geom.add(centre[-1], geom.scale(d, step))
        if spread:
            p = geom.add(p, geom.scale(out, spread * step * t))
        centre.append(p)

    # ウェーブとカールは中心線に沿った連続フレームの上で回す。
    axis = geom.normalize(wave_axis)
    frames = geom.parallel_frames(centre)
    path = []
    for i, p in enumerate(centre):
        t = i / (points - 1)
        q = p
        if wave_amp:
            envelope = _smoothstep(t * 2.2)
            offset = wave_amp * envelope * math.sin(
                2.0 * math.pi * wave_freq * t + wave_phase)
            q = geom.add(q, geom.scale(axis, offset))
        if curl_radius and t > curl_start:
            k = (t - curl_start) / max(1e-6, 1.0 - curl_start)
            angle = curl_turns * 2.0 * math.pi * k
            r = curl_radius * _smoothstep(k)
            u, v = frames[i]
            q = geom.add(q, geom.add(geom.scale(u, r * (math.cos(angle) - 1.0)),
                                     geom.scale(v, r * math.sin(angle))))
        path.append(q)
    return path


def card_widths(width, points=STRAND_POINTS, tip_ratio=0.45, bulge=1.12):
    """根元から毛先へ狭まるカード幅。中程を少し膨らませて束感を出す。"""
    widths = []
    for i in range(points):
        t = i / (points - 1)
        taper = (1.0 - t) ** 0.9
        w = width * (tip_ratio + (1.0 - tip_ratio) * taper)
        w *= 1.0 + (bulge - 1.0) * math.sin(math.pi * min(1.0, t * 1.5)) * 0.5
        widths.append(max(w, width * 0.12))
    return widths


def add_card(mb, root, direction, length, width, chain=None, **kwargs):
    """ヘアカードを 1 枚追加する。chain を渡すと springBone 追従になる。"""
    global _strand_seq
    points = kwargs.pop("points", STRAND_POINTS)
    tip_ratio = kwargs.pop("tip_ratio", 0.45)
    path = strand_path(root, direction, length, points=points, **kwargs)
    widths = card_widths(width, points=points, tip_ratio=tip_ratio)

    # カードの面を頭皮に沿わせる: 幅方向 = 接線 × 外向き
    outward = geom.normalize((root[0] - rig.HEAD_CENTER[0],
                              root[1] - rig.HEAD_CENTER[1],
                              (root[2] - rig.HEAD_CENTER[2]) * 0.3))
    tangent0 = geom.normalize(geom.sub(path[1], path[0]))
    u0 = geom.cross(tangent0, outward)
    if geom.length(u0) < 1e-6:
        u0 = None

    verts, faces, uvs = geom.ribbon(path, widths, u0=u0)

    if chain is None:
        group = "head"
    else:
        _strand_seq += 1
        group = f"hs{_strand_seq}"
        STRAND_CHAINS[group] = chain
    mb.add(verts, faces, "hair", group=group, uvs=uvs)
    return path


# --- 地肌（キャップ）-----------------------------------------------------

def build_cap(mb):
    """頭を覆う地肌。カードの根元を隠す。"""
    center, radii = rig.HEAD_CENTER, rig.HEAD_RADII
    segments, rings = 28, 10
    outer_k, inner_k = 1.045, 1.005
    base_theta, amp_theta = 1.62, 0.62

    def shell(k):
        rx, ry, rz = (r * k for r in radii)
        pts = [(center[0], center[1], center[2] + rz)]
        for r in range(1, rings + 1):
            for s in range(segments):
                phi = 2.0 * math.pi * s / segments
                theta = (base_theta + amp_theta * math.sin(phi)) * r / rings
                st, ct = math.sin(theta), math.cos(theta)
                pts.append((center[0] + rx * st * math.cos(phi),
                            center[1] + ry * st * math.sin(phi),
                            center[2] + rz * ct))
        return pts

    outer, inner = shell(outer_k), shell(inner_k)
    n_shell = len(outer)
    verts = outer + inner
    faces = []

    def grid(base, flip):
        f = []
        for s in range(segments):
            t = (s + 1) % segments
            tri = (base, base + 1 + t, base + 1 + s)
            f.append(tuple(reversed(tri)) if flip else tri)
        for r in range(rings - 1):
            a = base + 1 + r * segments
            b = base + 1 + (r + 1) * segments
            for s in range(segments):
                t = (s + 1) % segments
                quad = (a + s, a + t, b + t, b + s)
                f.append(tuple(reversed(quad)) if flip else quad)
        return f

    faces += grid(0, flip=False)
    faces += grid(n_shell, flip=True)
    rim_o = 1 + (rings - 1) * segments
    rim_i = n_shell + rim_o
    for s in range(segments):
        t = (s + 1) % segments
        faces.append((rim_o + s, rim_o + t, rim_i + t, rim_i + s))

    # 地肌は根元の色（アルファは v<0.8 で常に不透明な領域）。
    uvs = [(0.5, 0.06)] * len(verts)
    mb.add(verts, faces, "hair", group="head", uvs=uvs)


# --- 房の配置 -------------------------------------------------------------

FRONT = -math.pi / 2   # 顔の方向 (-Y)
BACK = math.pi / 2     # 後頭部 (+Y)


def build_bangs(mb):
    """前髪。額を覆う短いカードと、顔の輪郭を縁取る長いカード。"""
    count = 9
    for i in range(count):
        k = i / (count - 1)
        phi = FRONT + (k - 0.5) * 2.4
        theta = 0.55 + 0.14 * abs(k - 0.5) * 2
        root = scalp_point(phi, theta)
        n = scalp_normal(phi, theta)
        direction = geom.normalize(geom.add(geom.scale(n, 0.28),
                                            (0.0, 0.0, -1.0)))
        length = 0.085 + 0.075 * abs(k - 0.5) * 2
        add_card(mb, root, direction, length, 0.052,
                 gravity=0.55, wave_amp=0.004, wave_freq=1.0,
                 wave_phase=k * 3.0, wave_axis=(1.0, 0.3, 0.0),
                 tip_ratio=0.35, points=8)

    # 顔の横を縁取る長い房（サイドチェーンで揺れる）。
    for s, side in ((1.0, "L"), (-1.0, "R")):
        phi = FRONT + s * 1.34
        theta = 0.86
        root = scalp_point(phi, theta)
        n = scalp_normal(phi, theta)
        direction = geom.normalize(geom.add(geom.scale(n, 0.40),
                                            (0.0, 0.0, -1.0)))
        add_card(mb, root, direction, 0.46, 0.055, chain=f"sp_side{side}",
                 gravity=0.50, wave_amp=0.018, wave_freq=1.4,
                 wave_phase=s * 1.1, wave_axis=(s, 0.4, 0.0),
                 spread=0.05, tip_ratio=0.28, points=12)


def build_side_locks(mb):
    """耳の後ろから胸へ落ちる長い房。サイドチェーンで揺れる。"""
    specs = [
        (1.52, 1.02, 0.100, 0.9),
        (1.80, 0.95, 0.095, 2.6),
        (2.08, 0.88, 0.090, 2.1),
    ]
    for s, side in ((1.0, "L"), (-1.0, "R")):
        chain = f"sp_side{side}"
        for offset, length, width, phase in specs:
            phi = FRONT + s * offset
            theta = 1.00
            root = scalp_point(phi, theta)
            n = scalp_normal(phi, theta)
            direction = geom.normalize(geom.add(geom.scale(n, 0.45),
                                                (0.0, 0.0, -1.0)))
            add_card(mb, root, direction, length, width, chain=chain,
                     gravity=0.40, wave_amp=0.030, wave_freq=1.9,
                     wave_phase=phase, wave_axis=(s, 0.35, 0.0),
                     curl_start=0.62, curl_radius=0.042, curl_turns=0.60,
                     spread=0.07, tip_ratio=0.26, points=16)


def build_back_hair(mb):
    """後ろ髪。内側・外側の 2 層。左右と中央のチェーンで揺れる。"""
    layers = [
        # (枚数, 方位の広がり, theta, 長さ, 幅, ウェーブ, カール半径, 外開き)
        # 外層は側頭部までしっかり回して、カードの隙間から地肌が
        # 見えないようにする。
        (9, 1.20, 1.05, 0.84, 0.105, 0.030, 0.050, 0.03),
        (13, 1.90, 1.30, 1.06, 0.115, 0.045, 0.070, 0.07),
    ]
    for li, (count, spread_phi, theta, length, width,
             wave, curl, spread) in enumerate(layers):
        for i in range(count):
            k = (i / (count - 1)) - 0.5 if count > 1 else 0.0
            phi = BACK + k * 2.0 * spread_phi
            # 一番近い後ろ髪チェーンに割り当てる
            if k < -0.22:
                chain = "sp_backL"
            elif k > 0.22:
                chain = "sp_backR"
            else:
                chain = "sp_backC"
            root = scalp_point(phi, theta)
            n = scalp_normal(phi, theta)
            direction = geom.normalize(geom.add(geom.scale(n, 0.40),
                                                (0.0, 0.0, -1.0)))
            add_card(mb, root, direction, length, width, chain=chain,
                     gravity=0.34, wave_amp=wave,
                     wave_freq=1.7 + 0.4 * li,
                     wave_phase=i * 1.7 + li * 0.9,
                     wave_axis=(math.cos(phi + math.pi / 2),
                                math.sin(phi + math.pi / 2), 0.25),
                     curl_start=0.62, curl_radius=curl,
                     curl_turns=0.55 + 0.15 * li,
                     spread=spread, tip_ratio=0.26, points=16)

    # 頭頂から後ろへ流れる短い層。地肌との境目を隠す（揺らさない）。
    for i in range(5):
        k = (i / 4.0) - 0.5
        phi = BACK + k * 1.7
        root = scalp_point(phi, 0.55)
        n = scalp_normal(phi, 0.55)
        direction = geom.normalize(geom.add(geom.scale(n, 0.7),
                                            (0.0, 0.0, -1.0)))
        add_card(mb, root, direction, 0.42, 0.080,
                 gravity=0.42, wave_amp=0.018, wave_freq=1.4,
                 wave_phase=i * 2.2,
                 wave_axis=(math.cos(phi + math.pi / 2),
                            math.sin(phi + math.pi / 2), 0.0),
                 tip_ratio=0.24, points=10)


# --- springBone チェーンの定義 ---------------------------------------------

def register_chains():
    """代表的な房の中心線から揺れ骨チェーンのジョイント位置を作る。"""
    def chain_from(phi, theta, length, gravity=0.38):
        root = scalp_point(phi, theta)
        n = scalp_normal(phi, theta)
        direction = geom.normalize(geom.add(geom.scale(n, 0.42),
                                            (0.0, 0.0, -1.0)))
        path = strand_path(root, direction, length, points=13,
                           gravity=gravity)
        return [path[0], path[4], path[8], path[12]]

    CHAINS["sp_sideL"] = chain_from(FRONT + 1.62, 1.00, 1.02)
    CHAINS["sp_sideR"] = chain_from(FRONT - 1.62, 1.00, 1.02)
    CHAINS["sp_backL"] = chain_from(BACK - 1.05, 1.30, 1.02)
    CHAINS["sp_backR"] = chain_from(BACK + 1.05, 1.30, 1.02)
    CHAINS["sp_backC"] = chain_from(BACK, 1.34, 1.06)


# --- 頭上パーツ（水滴オーナメント）---------------------------------------

def build_headpiece(mb):
    """頭頂の水滴オーナメント。資料の最も明るい発光部。"""
    droplets = [
        (FRONT + 0.00, 0.16, 0.115, 0.021, 0.30),
        (FRONT + 0.95, 0.34, 0.085, 0.017, 0.20),
        (FRONT - 0.95, 0.34, 0.085, 0.017, 0.20),
        (FRONT + 1.85, 0.52, 0.062, 0.014, 0.10),
        (FRONT - 1.85, 0.52, 0.062, 0.014, 0.10),
    ]
    for phi, theta, height, width, lean in droplets:
        base = scalp_point(phi, theta, k=1.02)
        lean_dir = (math.cos(phi) * lean, math.sin(phi) * lean, 1.0)
        add_droplet(mb, base, lean_dir, height, width)

    beads = [
        (FRONT + 0.48, 0.30, 0.013),
        (FRONT - 0.48, 0.30, 0.013),
        (FRONT + 1.40, 0.46, 0.010),
        (FRONT - 1.40, 0.46, 0.010),
    ]
    for phi, theta, radius in beads:
        c = scalp_point(phi, theta, k=1.10)
        verts, faces = geom.ellipsoid(c, (radius, radius, radius),
                                      segments=10, rings=7)
        mb.add(verts, faces, "bubble", group="head")


def add_droplet(mb, base, direction, height, width):
    """下がまるく上が尖った水滴形。"""
    d = geom.normalize(direction)
    points = 7
    path = [geom.add(base, geom.scale(d, height * i / (points - 1)))
            for i in range(points)]
    profile = [0.42, 0.86, 1.0, 0.92, 0.66, 0.32, 0.04]
    radii = [width * p for p in profile]
    verts, faces = geom.tube(path, radii, segments=8)
    mb.add(verts, faces, "droplet", group="head")


# --- まとめ ---------------------------------------------------------------

def build(mb):
    global _strand_seq
    CHAINS.clear()
    STRAND_CHAINS.clear()
    _strand_seq = 0

    register_chains()
    build_cap(mb)
    build_bangs(mb)
    build_side_locks(mb)
    build_back_hair(mb)
    build_headpiece(mb)
