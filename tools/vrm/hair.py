"""スプラーシュの髪と頭上パーツの造形。

資料の「ロングウェーブ + 毛先カール」を、房（ストランド）を並べる方式で作る。
1 房は折れ線に沿ったチューブで、根元から毛先へ向かって
  ・重力で徐々に真下へ向きを変える
  ・横方向のウェーブを乗せる
  ・毛先で螺旋を描いてカールする
という 3 つの変形を重ねている。

色は房ごとではなく UV の v（0=根元, 1=毛先）でグラデーションテクスチャを引く。
資料の「髪の毛先・髪の内側 = グローパープル」がこれで表現される。
"""

import math

import geom
import rig

CAP_TAG = "hair"
STRAND_TAG = "hair"

# 房の分割数。ring を増やすと滑らかになるが頂点数が増える。
STRAND_POINTS = 12
STRAND_SEGMENTS = 6


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

    # まず重力で曲がる中心線を作る。
    centre = [root]
    d = direction
    for i in range(1, points):
        t = i / (points - 1)
        d = geom.normalize(geom.lerp(d, (0.0, 0.0, -1.0), gravity))
        p = geom.add(centre[-1], geom.scale(d, step))
        if spread:
            p = geom.add(p, geom.scale(out, spread * step * t))
        centre.append(p)

    # ウェーブとカールを重ねる。
    # カールは中心線に沿った連続フレームの上で回すこと。節点ごとに
    # basis_from_axis() を取り直すと基底が反転してカールが折れる。
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


def strand_radii(root_radius, tip_ratio=0.30, points=STRAND_POINTS, bulge=1.18):
    """根元から毛先へ細くなる半径。少し手前で膨らませて束感を出す。"""
    radii = []
    for i in range(points):
        t = i / (points - 1)
        taper = (1.0 - t) ** 1.35
        r = root_radius * (tip_ratio + (1.0 - tip_ratio) * taper)
        r *= 1.0 + (bulge - 1.0) * math.sin(math.pi * min(1.0, t * 1.6)) * 0.5
        radii.append(max(r, root_radius * 0.05))
    return radii


def add_strand(mb, root, direction, length, root_radius, **kwargs):
    """房を 1 本 MeshBuilder に足す。UV の v は根元 0 / 毛先 1。"""
    points = kwargs.pop("points", STRAND_POINTS)
    tip_ratio = kwargs.pop("tip_ratio", 0.30)
    v_start = kwargs.pop("v_start", 0.0)
    path = strand_path(root, direction, length, points=points, **kwargs)
    radii = strand_radii(root_radius, tip_ratio=tip_ratio, points=points)
    verts, faces = geom.tube(path, radii, segments=STRAND_SEGMENTS)
    v_values = [v_start + (1.0 - v_start) * (i / (points - 1))
                for i in range(points)]
    uvs = geom.tube_uvs(points, STRAND_SEGMENTS, v_values)
    mb.add(verts, faces, STRAND_TAG, group="head", uvs=uvs)


# --- 地肌（キャップ）-----------------------------------------------------

def build_cap(mb):
    """頭を覆う地肌。前は浅く後ろは深く取り、房の根元を隠す。"""
    center, radii = rig.HEAD_CENTER, rig.HEAD_RADII
    segments, rings = 28, 10
    outer_k, inner_k = 1.048, 1.006
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

    # 地肌は根元の色。UV の v を小さく取る。
    uvs = [(0.5, 0.06)] * len(verts)
    mb.add(verts, faces, CAP_TAG, group="head", uvs=uvs)


# --- 房の配置 -------------------------------------------------------------

FRONT = -math.pi / 2   # 顔の方向 (-Y)
BACK = math.pi / 2     # 後頭部 (+Y)


def build_bangs(mb):
    """前髪。額を覆う短い段と、顔の輪郭を縁取る長い段の 2 種類。

    正面の房を長くすると顔が完全に隠れてしまうので、
    中央は目の上で切り、長い房は外側に寄せる。
    """
    # 額の前髪。房を細く多くしないと、短い房が団子状の塊に見えてしまう。
    count = 11
    for i in range(count):
        k = i / (count - 1)
        phi = FRONT + (k - 0.5) * 2.4
        theta = 0.55 + 0.14 * abs(k - 0.5) * 2
        root = scalp_point(phi, theta)
        n = scalp_normal(phi, theta)
        direction = geom.normalize(geom.add(geom.scale(n, 0.28),
                                            (0.0, 0.0, -1.0)))
        # 中央ほど短く、外へ行くほど長い（分けめのある前髪）
        length = 0.080 + 0.075 * abs(k - 0.5) * 2
        add_strand(mb, root, direction, length, 0.0155,
                   gravity=0.55, wave_amp=0.004, wave_freq=1.0,
                   wave_phase=k * 3.0, wave_axis=(1.0, 0.3, 0.0),
                   tip_ratio=0.07, points=9)

    # 顔の横を縁取る長い房。顔にかからないよう、こめかみより外に根を置き、
    # さらに外向きに開かせる。
    for s in (1.0, -1.0):
        phi = FRONT + s * 1.34
        theta = 0.86
        root = scalp_point(phi, theta)
        n = scalp_normal(phi, theta)
        direction = geom.normalize(geom.add(geom.scale(n, 0.40),
                                            (0.0, 0.0, -1.0)))
        add_strand(mb, root, direction, 0.46, 0.026,
                   gravity=0.50, wave_amp=0.018, wave_freq=1.4,
                   wave_phase=s * 1.1, wave_axis=(s, 0.4, 0.0),
                   spread=0.05, tip_ratio=0.14, points=12)


def build_side_locks(mb):
    """顔の横に落ちる長い房。資料では胸から腰まで届く。"""
    # 顔にかからないよう、耳のあたり（正面から 1.6rad 以上）に根を置く。
    specs = [
        (1.62, 1.02, 0.050, 0.9),
        (1.98, 0.88, 0.044, 2.1),
    ]
    for side in (1.0, -1.0):
        for offset, length, radius, phase in specs:
            phi = FRONT + side * offset
            theta = 1.00
            root = scalp_point(phi, theta)
            n = scalp_normal(phi, theta)
            direction = geom.normalize(geom.add(geom.scale(n, 0.45),
                                                (0.0, 0.0, -1.0)))
            add_strand(mb, root, direction, length, radius,
                       gravity=0.40, wave_amp=0.030, wave_freq=1.9,
                       wave_phase=phase, wave_axis=(side, 0.35, 0.0),
                       curl_start=0.62, curl_radius=0.042, curl_turns=0.60,
                       spread=0.07, tip_ratio=0.22, points=16)


def build_back_hair(mb):
    """後ろ髪。内側・外側の 2 層に分けてボリュームを出す。"""
    layers = [
        # (本数, 方位の広がり, theta, 長さ, 半径, ウェーブ, カール半径, 外開き)
        (7, 1.15, 1.05, 0.84, 0.052, 0.030, 0.050, 0.03),
        (9, 1.55, 1.34, 1.06, 0.058, 0.045, 0.070, 0.07),
    ]
    for li, (count, spread_phi, theta, length, radius,
             wave, curl, spread) in enumerate(layers):
        for i in range(count):
            k = (i / (count - 1)) - 0.5 if count > 1 else 0.0
            phi = BACK + k * 2.0 * spread_phi
            root = scalp_point(phi, theta)
            n = scalp_normal(phi, theta)
            direction = geom.normalize(geom.add(geom.scale(n, 0.40),
                                                (0.0, 0.0, -1.0)))
            add_strand(mb, root, direction, length, radius,
                       gravity=0.34, wave_amp=wave,
                       wave_freq=1.7 + 0.4 * li,
                       wave_phase=i * 1.7 + li * 0.9,
                       wave_axis=(math.cos(phi + math.pi / 2),
                                  math.sin(phi + math.pi / 2), 0.25),
                       curl_start=0.62, curl_radius=curl,
                       # カールは分割数を確保できる巻き数に抑える。
                       # 巻きすぎると点が足りずカクカクの折れ線になる。
                       curl_turns=0.55 + 0.15 * li,
                       spread=spread, tip_ratio=0.24, points=16)

    # 頭頂から後ろへ流れる短めの層。地肌との境目を隠す。
    for i in range(5):
        k = (i / 4.0) - 0.5
        phi = BACK + k * 1.7
        root = scalp_point(phi, 0.55)
        n = scalp_normal(phi, 0.55)
        direction = geom.normalize(geom.add(geom.scale(n, 0.7),
                                            (0.0, 0.0, -1.0)))
        add_strand(mb, root, direction, 0.42, 0.040,
                   gravity=0.42, wave_amp=0.018, wave_freq=1.4,
                   wave_phase=i * 2.2,
                   wave_axis=(math.cos(phi + math.pi / 2),
                             math.sin(phi + math.pi / 2), 0.0),
                   tip_ratio=0.16, points=10)


# --- 頭上パーツ（水滴オーナメント）---------------------------------------

def build_headpiece(mb):
    """頭頂の水滴オーナメント。資料の最も明るい発光部。"""
    droplets = [
        # (方位, 天頂角, 高さ, 太さ, 前後の傾き)
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

    # 水滴の間に浮かぶ小さな球。
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
    build_cap(mb)
    build_bangs(mb)
    build_side_locks(mb)
    build_back_hair(mb)
    build_headpiece(mb)
