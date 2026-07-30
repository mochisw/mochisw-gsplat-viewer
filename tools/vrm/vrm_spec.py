"""VRM 1.0 (VRMC_vrm) の仕様定数。

build_avatar.py（Blender 側）と glb_to_vrm.py（GLB 後処理側）の両方から
import され、ボーン名と表情名の取り決めを一箇所に集約する。
"""

# --- ヒューマノイドボーン -------------------------------------------------
# VRM 1.0 の humanBones キーをそのまま Blender のボーン名として使う。
# (name, parent) の順。親が None のものがアーマチュアのルート。
HUMAN_BONES = [
    ("hips", None),
    ("spine", "hips"),
    ("chest", "spine"),
    ("upperChest", "chest"),
    ("neck", "upperChest"),
    ("head", "neck"),
    ("leftEye", "head"),
    ("rightEye", "head"),
    ("leftShoulder", "upperChest"),
    ("leftUpperArm", "leftShoulder"),
    ("leftLowerArm", "leftUpperArm"),
    ("leftHand", "leftLowerArm"),
    ("rightShoulder", "upperChest"),
    ("rightUpperArm", "rightShoulder"),
    ("rightLowerArm", "rightUpperArm"),
    ("rightHand", "rightLowerArm"),
    ("leftUpperLeg", "hips"),
    ("leftLowerLeg", "leftUpperLeg"),
    ("leftFoot", "leftLowerLeg"),
    ("leftToes", "leftFoot"),
    ("rightUpperLeg", "hips"),
    ("rightLowerLeg", "rightUpperLeg"),
    ("rightFoot", "rightLowerLeg"),
    ("rightToes", "rightFoot"),
]

FINGERS = [
    ("Thumb", ["Metacarpal", "Proximal", "Distal"]),
    ("Index", ["Proximal", "Intermediate", "Distal"]),
    ("Middle", ["Proximal", "Intermediate", "Distal"]),
    ("Ring", ["Proximal", "Intermediate", "Distal"]),
    ("Little", ["Proximal", "Intermediate", "Distal"]),
]


def finger_bones():
    """指ボーンの (name, parent) を列挙する。"""
    out = []
    for side in ("left", "right"):
        for finger, joints in FINGERS:
            parent = f"{side}Hand"
            for joint in joints:
                name = f"{side}{finger}{joint}"
                out.append((name, parent))
                parent = name
    return out


def all_bones():
    """全ボーンを親→子の順で返す。"""
    return HUMAN_BONES + finger_bones()


# VRM 1.0 が必須とするボーン。検証で使う。
REQUIRED_BONES = [
    "hips", "spine", "head",
    "leftUpperArm", "leftLowerArm", "leftHand",
    "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
]


# --- 表情 (expressions) ---------------------------------------------------
# VRM 1.0 のプリセット表情名。シェイプキー名としてもこの名前を使う。
PRESET_EXPRESSIONS = [
    "aa", "ih", "ou", "ee", "oh",
    "blink", "blinkLeft", "blinkRight",
    "happy", "angry", "sad", "relaxed", "surprised",
    "lookUp", "lookDown", "lookLeft", "lookRight",
    "neutral",
]

# シェイプキーとして実際に生成する表情（neutral はベース形状なので作らない、
# 視線はボーン lookAt に任せるので lookXX も作らない）。
MORPH_EXPRESSIONS = [
    "aa", "ih", "ou", "ee", "oh",
    "blink", "blinkLeft", "blinkRight",
    "happy", "angry", "sad", "relaxed", "surprised",
]

# 口の形（リップシンク）。同時再生すると破綻するので override 対象。
MOUTH_EXPRESSIONS = ["aa", "ih", "ou", "ee", "oh"]
BLINK_EXPRESSIONS = ["blink", "blinkLeft", "blinkRight"]
