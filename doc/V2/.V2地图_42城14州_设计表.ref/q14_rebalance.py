# -*- coding: utf-8 -*-
"""M11 技能点位均衡：把「设施清单」sheet 的主/副设施改为每技能 6 点位。

主设施改动 9 城 + 副设施改动 4 州府，共 26 个单元格。
"""

import json
import os
import subprocess
import tempfile

SKILL_DIR = r"G:/workBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit"
PY = r"C:/Users/beyondsnk/.workbuddy/binaries/python/versions/3.13.12/python.exe"
FILE_ID = r"I:/buddyWork/sanWalk/doc/V2/V2地图_42城14州_设计表.xlsx"
SHEET_ID = "Q9E250"

# (row_0based, col_0based, new_value)
UPDATES = [
    # —— 副设施 4 处 ——
    (6,  6, "机巧坊"), (6,  7, "机巧"),    # 邺:     酒肆(结义) → 机巧坊(机巧)
    (18, 6, "丹房"),   (18, 7, "丹鼎"),    # 许昌:   酒肆(结义) → 丹房(丹鼎)
    (21, 6, "铁匠铺"), (21, 7, "锻造"),    # 长安:   使馆(出使) → 铁匠铺(锻造)
    (24, 6, "酒肆"),   (24, 7, "结义"),    # 武威:   矿场(采掘) → 酒肆(结义)
    # —— 主设施 9 处 ——
    (9,  4, "道观"),   (9,  5, "访道"),    # 北海:   酒肆(结义) → 道观(访道)   郑玄
    (23, 4, "道观"),   (23, 5, "访道"),    # 安定:   猎场(猎奇) → 道观(访道)   崆峒
    (25, 4, "铁匠铺"), (25, 5, "锻造"),    # 西平:   矿场(采掘) → 铁匠铺(锻造)
    (27, 4, "丹房"),   (27, 5, "丹鼎"),    # 宛:     矿场(采掘) → 丹房(丹鼎)   张仲景
    (28, 4, "道观"),   (28, 5, "访道"),    # 新野:   药圃(采药) → 道观(访道)   水镜
    (29, 4, "铁匠铺"), (29, 5, "锻造"),    # 江夏:   猎场(猎奇) → 铁匠铺(锻造)
    (34, 4, "使馆"),   (34, 5, "出使"),    # 会稽:   矿场(采掘) → 使馆(出使)
    (39, 4, "机巧坊"), (39, 5, "机巧"),    # 梓潼:   矿场(采掘) → 机巧坊(机巧)
    (42, 4, "使馆"),   (42, 5, "出使"),    # 南海:   药圃(采药) → 使馆(出使)
]

assert len(UPDATES) == 26, len(UPDATES)


def call(tool: str, payload: dict) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        path = f.name
    try:
        r = subprocess.run(
            [PY, "edsdk.py", "call", tool, "--json-file", path],
            cwd=SKILL_DIR, capture_output=True, text=True, encoding="utf-8",
        )
        return (r.stdout or "").strip() or (r.stderr or "").strip()
    finally:
        os.unlink(path)


values = [
    {"row": r, "col": c, "value_type": "STRING", "string_value": v}
    for r, c, v in UPDATES
]
print(call("sheet_set_range_value", {"sheet_id": SHEET_ID, "file_id": FILE_ID, "values": values}))
print(call("save_file", {"file_id": FILE_ID, "file_path": FILE_ID, "output_format": "native"}))
