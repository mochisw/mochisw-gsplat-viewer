"""アバターの骨格寸法（ジョイント座標）定義。

メッシュ生成とアーマチュア生成の両方がここを参照するので、
体型を変えたいときはこのファイルだけ触ればよい。

座標系は Blender 準拠:
  +X = キャラクターから見て左, -Y = キャラクターの正面, +Z = 上
glTF/VRM へは (x, y, z) -> (x, z, -y) で変換されるため、
この向きで作ると VRM 1.0 が要求する「+Z を向いた Y-up」になる。
単位はメートル。素立ちは VRM 必須の T ポーズ。
"""

from vrm_spec import FINGERS

# 全高の目安（頭頂）。プロポーションは約 7 頭身。
HEIGHT = 1.615

# --- 体幹 -----------------------------------------------------------------
JOINTS = {
    "hips":        (0.0, 0.0, 0.880),
    "spine":       (0.0, 0.0, 0.990),
    "chest":       (0.0, 0.0, 1.100),
    "upperChest":  (0.0, 0.0, 1.200),
    "neck":        (0.0, 0.0, 1.345),
    "head":        (0.0, 0.0, 1.425),
    "headTop":     (0.0, 0.0, HEIGHT),
}

# 頭部の楕円体（中心と半径）。顔パーツはこの表面に投影される。
HEAD_CENTER = (0.0, 0.008, 1.500)
HEAD_RADII = (0.098, 0.107, 0.115)

# 目のボーン原点。虹彩だけをこのボーンに追従させて視線を動かす。
EYE_ORIGIN = (0.041, -0.058, 1.492)

# --- 腕（T ポーズなので +X 方向へまっすぐ伸ばす）-------------------------
ARM = {
    "shoulder":  (0.030, 0.0, 1.305),
    "upperArm":  (0.115, 0.0, 1.315),
    "lowerArm":  (0.370, 0.0, 1.315),
    "hand":      (0.598, 0.0, 1.315),
    "handEnd":   (0.672, 0.0, 1.315),
}

# 指の付け根と各節の長さ。x が指の伸びる向き、y が指の並ぶ向き。
FINGER_ROOTS = {
    "Thumb":  (0.612, -0.030, 1.302),
    "Index":  (0.685, -0.030, 1.313),
    "Middle": (0.688, -0.010, 1.315),
    "Ring":   (0.686, 0.010, 1.314),
    "Little": (0.680, 0.030, 1.312),
}

# 各節の (dx, dy, dz)。親指だけ手前に開く。
FINGER_SEGMENTS = {
    "Thumb":  [(0.040, -0.022, -0.004), (0.027, -0.016, -0.002), (0.021, -0.012, -0.001)],
    "Index":  [(0.030, -0.002, -0.001), (0.026, -0.002, -0.002), (0.022, -0.001, -0.002)],
    "Middle": [(0.032, 0.000, 0.000), (0.028, 0.000, -0.002), (0.023, 0.000, -0.002)],
    "Ring":   [(0.029, 0.002, -0.001), (0.025, 0.002, -0.002), (0.021, 0.001, -0.002)],
    "Little": [(0.025, 0.004, -0.002), (0.021, 0.003, -0.002), (0.018, 0.002, -0.002)],
}

FINGER_RADII = {
    "Thumb": 0.0105, "Index": 0.0095, "Middle": 0.0098,
    "Ring": 0.0090, "Little": 0.0080,
}

# --- 脚 -------------------------------------------------------------------
LEG = {
    "upperLeg": (0.075, 0.0, 0.880),
    "lowerLeg": (0.078, 0.0, 0.470),
    "foot":     (0.080, 0.005, 0.075),
    "toes":     (0.080, -0.095, 0.022),
    "toeEnd":   (0.080, -0.165, 0.020),
}


def mirror(p):
    """左側の座標を右側に反転する。"""
    return (-p[0], p[1], p[2])


def side_sign(side):
    return 1.0 if side == "left" else -1.0


def bone_positions():
    """ボーン名 -> (head, tail) を返す。左右両方を含む。"""
    j, a, l = JOINTS, ARM, LEG
    pos = {
        "hips": (j["hips"], j["spine"]),
        "spine": (j["spine"], j["chest"]),
        "chest": (j["chest"], j["upperChest"]),
        "upperChest": (j["upperChest"], j["neck"]),
        "neck": (j["neck"], j["head"]),
        "head": (j["head"], j["headTop"]),
    }
    for side in ("left", "right"):
        s = side_sign(side)

        def m(p):
            return (p[0] * s, p[1], p[2])

        pos[f"{side}Eye"] = (m(EYE_ORIGIN), m((EYE_ORIGIN[0], EYE_ORIGIN[1] - 0.04, EYE_ORIGIN[2])))
        pos[f"{side}Shoulder"] = (m(a["shoulder"]), m(a["upperArm"]))
        pos[f"{side}UpperArm"] = (m(a["upperArm"]), m(a["lowerArm"]))
        pos[f"{side}LowerArm"] = (m(a["lowerArm"]), m(a["hand"]))
        pos[f"{side}Hand"] = (m(a["hand"]), m(a["handEnd"]))
        pos[f"{side}UpperLeg"] = (m(l["upperLeg"]), m(l["lowerLeg"]))
        pos[f"{side}LowerLeg"] = (m(l["lowerLeg"]), m(l["foot"]))
        pos[f"{side}Foot"] = (m(l["foot"]), m(l["toes"]))
        pos[f"{side}Toes"] = (m(l["toes"]), m(l["toeEnd"]))

        for finger, joints in FINGERS:
            p = FINGER_ROOTS[finger]
            cur = (p[0] * s, p[1], p[2])
            for joint, seg in zip(joints, FINGER_SEGMENTS[finger]):
                nxt = (cur[0] + seg[0] * s, cur[1] + seg[1], cur[2] + seg[2])
                pos[f"{side}{finger}{joint}"] = (cur, nxt)
                cur = nxt
    return pos
