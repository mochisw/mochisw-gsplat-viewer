"""顔パーツ（目・睫毛・眉・口）のパラメータと表情差分の定義。

顔パーツは頭部の楕円体表面に投影した平面パッチとして作る。
表情シェイプキーは「パッチのパラメータを変えて作り直した座標」で表現するので、
どの表情でも顔の曲面から浮いたり沈んだりしない。
"""

import math

# パッチの基本パラメータ。cx は左側（+X）の値で、右側は符号反転して使う。
#   cx, cz : パッチ中心
#   rx, rz : 楕円の半径
#   rot    : 傾き（正 = 外側の端が上がる）
#   curve  : 上向きの反り
#   offset : 頭部表面からの浮かせ量（描画順の制御を兼ねる）
BASE = {
    "brow":     dict(cx=0.041, cz=1.5495, rx=0.024, rz=0.0030, rot=0.10, curve=0.004, offset=0.0030),
    "lash":     dict(cx=0.041, cz=1.5205, rx=0.031, rz=0.0058, rot=0.0, curve=0.008, offset=0.0038),
    "eyeWhite": dict(cx=0.041, cz=1.492, rx=0.029, rz=0.027, rot=0.0, curve=0.0, offset=0.0022),
    "iris":     dict(cx=0.041, cz=1.4905, rx=0.0195, rz=0.0235, rot=0.0, curve=0.0, offset=0.0032),
    "mouth":    dict(cx=0.0, cz=1.424, rx=0.021, rz=0.0035, rot=0.0, curve=0.002, offset=0.0022),
}

# 左右に分かれるパーツと、中央のパーツ。
SIDED = ["brow", "lash", "eyeWhite", "iris"]
CENTERED = ["mouth"]

# パッチの分割数。
SEGMENTS = 16

# 閉じた目のライン高さ。まばたき系の表情はここに睫毛と目を集める。
CLOSED_EYE_Z = 1.4955


def _closed_eye(curve=0.006, extra_lift=0.0):
    """目を閉じた状態のパッチ差分。curve で閉じ方のカーブを変える。"""
    return {
        "lash": dict(lift=CLOSED_EYE_Z - BASE["lash"]["cz"] + extra_lift, curve=curve + 0.004),
        "eyeWhite": dict(rz=0.0012, lift=CLOSED_EYE_Z - BASE["eyeWhite"]["cz"] + extra_lift, curve=curve),
        "iris": dict(rz=0.0010, lift=CLOSED_EYE_Z - BASE["iris"]["cz"] + extra_lift, curve=curve),
    }


# 表情ごとのパッチ差分。
# 値は {パーツ名: 上書きパラメータ}。"sides" を指定すると片目だけに適用する。
EXPRESSIONS = {
    # --- 母音（リップシンク）------------------------------------------
    "aa": {"mouth": dict(rx=0.023, rz=0.026, curve=0.0)},
    "ih": {"mouth": dict(rx=0.030, rz=0.0085, curve=0.004)},
    "ou": {"mouth": dict(rx=0.0125, rz=0.017, curve=0.0)},
    "ee": {"mouth": dict(rx=0.029, rz=0.013, curve=0.003)},
    "oh": {"mouth": dict(rx=0.019, rz=0.023, curve=0.0)},

    # --- まばたき -------------------------------------------------------
    "blink": _closed_eye(),
    "blinkLeft": dict(_closed_eye(), sides=["left"]),
    "blinkRight": dict(_closed_eye(), sides=["right"]),

    # --- 感情 -----------------------------------------------------------
    "happy": dict(
        _closed_eye(curve=0.020, extra_lift=0.002),
        brow=dict(lift=0.004, rot=0.16),
        mouth=dict(rx=0.026, rz=0.010, curve=0.012),
    ),
    "angry": {
        "brow": dict(rot=0.42, lift=-0.012),
        "lash": dict(rot=0.18, lift=-0.006),
        "eyeWhite": dict(rz=0.020, lift=-0.004),
        "iris": dict(rz=0.017, lift=-0.004),
        "mouth": dict(rx=0.018, rz=0.006, curve=-0.008),
    },
    "sad": {
        "brow": dict(rot=-0.35, lift=-0.004),
        "lash": dict(rot=-0.15, lift=-0.005),
        "eyeWhite": dict(rz=0.022, lift=-0.003),
        "iris": dict(rz=0.019, lift=-0.005),
        "mouth": dict(rx=0.017, rz=0.005, curve=-0.010),
    },
    "relaxed": {
        "brow": dict(lift=0.003, rot=-0.10),
        "lash": dict(lift=-0.010, curve=0.012),
        "eyeWhite": dict(rz=0.010, lift=-0.002, curve=0.008),
        "iris": dict(rz=0.009, lift=-0.001, curve=0.008),
        "mouth": dict(rx=0.023, rz=0.006, curve=0.007),
    },
    "surprised": {
        "brow": dict(lift=0.012, rot=0.0),
        "lash": dict(lift=0.008),
        "eyeWhite": dict(rx=0.032, rz=0.033),
        "iris": dict(rx=0.021, rz=0.027),
        "mouth": dict(rx=0.015, rz=0.024),
    },
}


def patch_params(name, side, expression=None):
    """パーツ name / 側 side の最終パラメータを返す。

    expression を指定するとその表情の差分を適用した値になる。
    差分が無い（そのパーツが動かない）場合は None を返す。
    """
    base = dict(BASE[name])
    base.setdefault("lift", 0.0)
    if side == "right":
        base["cx"] = -base["cx"]
        base["rot"] = -base["rot"]

    if expression is None:
        return base

    spec = EXPRESSIONS[expression]
    sides = spec.get("sides")
    if sides is not None and side not in sides:
        return None
    delta = spec.get(name)
    if delta is None:
        return None

    out = dict(base)
    for key, value in delta.items():
        if key == "rot" and side == "right":
            value = -value
        out[key] = value
    return out


def moved_patches(expression):
    """その表情で動くパーツを (name, side) のリストで返す。"""
    spec = EXPRESSIONS[expression]
    sides = spec.get("sides", ["left", "right"])
    out = []
    for name in SIDED:
        if name in spec:
            out.extend((name, s) for s in sides)
    for name in CENTERED:
        if name in spec:
            out.append((name, "center"))
    return out
