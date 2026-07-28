"""キャラクター「スプラーシュ / Supra-shu」の配色・発光・質感定義。

配色指定書のカラーコードをそのまま持つ。hex は sRGB なので、
glTF / Blender が扱うリニア色空間へ変換して使う。

発光は加算合成（emissive）で表現し、指定書の強度に従って
グローシアン(強) > グローパープル(強〜中) > エメラルドグリーン(中〜強) > ディープネイビー(弱)
の順に減衰させる。
"""

# --- 指定書のカラーパレット ----------------------------------------------
GLOW_CYAN = "#37E6FF"      # グローシアン
EMERALD = "#35F0C6"        # エメラルドグリーン
GLOW_PURPLE = "#C86BFF"    # グローパープル
DEEP_NAVY = "#0B1330"      # ディープネイビー
LIGHT_AQUA = "#B9F7FF"     # ライトアクア
SKIN = "#FFE7D6"           # スキン(肌)
FACE_BLACK = "#0E0E10"     # フェイスブラック

# 指定書に無いが必要な補助色。
PEARL_WHITE = "#F2F6FF"    # パールコートの白
MOUTH = "#C4607A"
EYE_WHITE = "#FBFDFF"


def hex_to_srgb(code):
    code = code.lstrip("#")
    return tuple(int(code[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear(code):
    """hex(sRGB) -> リニア RGB タプル。"""
    return tuple(srgb_to_linear(c) for c in hex_to_srgb(code))


def mix(a, b, t):
    """hex 2 色をリニア空間で補間する。"""
    la, lb = linear(a), linear(b)
    return tuple(la[i] + (lb[i] - la[i]) * t for i in range(3))


# --- 発光の段階（指定書の GLOW PLACEMENT MAP に対応）---------------------
GLOW_STRONG = 1.0     # (1) グローシアン(強): 頭上パーツ・水滴オーナメント中心
GLOW_MEDIUM = 0.55    # (2)(3) エメラルド(中〜強) / パープル(強〜中)
GLOW_WEAK = 0.12      # (4) ディープネイビー(弱): インナー生地・リボン
GLOW_SUB = 0.30       # (5) ライトアクア(補助ハイライト)


class Material:
    """1 マテリアルの見た目定義。

    base      : ベースカラー(リニア)
    roughness : 粗さ。指定書の質感（パール/グロス/サテン/マット）に対応させる
    emissive  : 発光色(リニア)。None なら発光しない
    texture   : ベースカラーに貼るテクスチャのキー（palette.TEXTURES）
    """

    def __init__(self, base, roughness, emissive=None, emissive_strength=1.0,
                 texture=None, emissive_texture=None):
        self.base = base
        self.roughness = roughness
        self.emissive = emissive
        self.emissive_strength = emissive_strength
        self.texture = texture
        self.emissive_texture = emissive_texture


def glow(code, level):
    """発光色を強度でスケールしたものを返す。"""
    return tuple(c * level for c in linear(code))


# --- 質感プリセット（指定書の MATERIAL 欄）------------------------------
R_MATTE = 0.85        # マット: インナー生地(フリル等)
R_SATIN = 0.42        # サテン: リボン・インナー生地
R_PEARL = 0.26        # パールコート: 髪のメイン・コート生地
R_GLOSS = 0.08        # グロスプラスチック: バブル装飾・靴パーツ
R_TRANSLUCENT = 0.18  # トランスレセント: スプラッシュ装飾・髪の毛先


# --- マテリアル一覧 -------------------------------------------------------
# 名前は build_avatar.py の面タグから引かれる。
MATERIALS = {
    # 肌と顔
    "Skin":      Material(linear(SKIN), 0.68),
    "EyeWhite":  Material(linear(EYE_WHITE), 0.30),
    "Iris":      Material(linear(GLOW_CYAN), 0.15,
                          emissive=glow(GLOW_CYAN, 0.22)),
    "Lash":      Material(linear(FACE_BLACK), 0.55),
    "Brow":      Material(mix(GLOW_CYAN, DEEP_NAVY, 0.45), 0.55),
    "Mouth":     Material(linear(MOUTH), 0.55),

    # 髪: 根元シアン -> 毛先パープルのグラデーションをテクスチャで表現する
    "Hair":      Material(linear(GLOW_CYAN), R_PEARL,
                          emissive=(1.0, 1.0, 1.0),
                          emissive_strength=1.0,
                          texture="hair_base",
                          emissive_texture="hair_glow"),

    # 頭上パーツ・水滴オーナメント（最も明るい発光）
    "Droplet":   Material(linear(GLOW_CYAN), R_TRANSLUCENT,
                          emissive=glow(GLOW_CYAN, GLOW_STRONG)),
    # バブル装飾（グロスプラスチック + パープル発光）
    "Bubble":    Material(linear(LIGHT_AQUA), R_GLOSS,
                          emissive=glow(GLOW_PURPLE, GLOW_MEDIUM)),

    # コート（パールコート）とその柄・ハイライト
    "Coat":      Material(linear(PEARL_WHITE), R_PEARL),
    "CoatTrim":  Material(linear(EMERALD), R_PEARL,
                          emissive=glow(EMERALD, GLOW_MEDIUM)),
    "CoatAqua":  Material(linear(LIGHT_AQUA), R_PEARL,
                          emissive=glow(LIGHT_AQUA, GLOW_SUB)),

    # インナー（ディープネイビー / サテン、発光は弱）
    "Inner":     Material(linear(DEEP_NAVY), R_SATIN,
                          emissive=glow(DEEP_NAVY, GLOW_WEAK)),
    "InnerTeal": Material(linear(EMERALD), R_SATIN,
                          emissive=glow(EMERALD, GLOW_MEDIUM * 0.8)),
    "Frill":     Material(linear(PEARL_WHITE), R_MATTE),
    "Ribbon":    Material(mix(EMERALD, LIGHT_AQUA, 0.35), R_SATIN,
                          emissive=glow(EMERALD, GLOW_WEAK)),

    # 靴下と靴
    "Socks":     Material(linear(LIGHT_AQUA), R_MATTE,
                          emissive=glow(EMERALD, GLOW_SUB * 0.6)),
    "Shoe":      Material(linear(PEARL_WHITE), R_PEARL),
    "ShoeAccent": Material(linear(GLOW_CYAN), R_GLOSS,
                           emissive=glow(GLOW_CYAN, GLOW_MEDIUM)),
}

# 描画順を安定させるための並び。
MATERIAL_ORDER = list(MATERIALS)


# --- 髪のグラデーションテクスチャ ----------------------------------------
# v=0(根元) から v=1(毛先) へ向かう色の並び。指定書の
# 「髪の毛先・髪の内側 = グローパープル」に従い毛先を紫に振る。
HAIR_BASE_STOPS = [
    (0.00, LIGHT_AQUA),
    (0.18, GLOW_CYAN),
    (0.52, "#5FA8FF"),
    (0.78, "#9B7BFF"),
    (1.00, GLOW_PURPLE),
]

# 発光は毛先ほど強い。(強度, 色) の並び。
HAIR_GLOW_STOPS = [
    (0.00, GLOW_CYAN, 0.10),
    (0.35, GLOW_CYAN, 0.16),
    (0.70, GLOW_PURPLE, 0.34),
    (1.00, GLOW_PURPLE, 0.60),
]
