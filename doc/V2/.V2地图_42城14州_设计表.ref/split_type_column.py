# -*- coding: utf-8 -*-
"""把「类型」单列拆成「是否州府」+「城级」两列（通过 editor_sdk MCP 写入）"""
import json
import os
import subprocess
import sys

SKILL_DIR = r"G:/workBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit"
PY = r"C:/Users/beyondsnk/.workbuddy/binaries/python/versions/3.13.12/python.exe"
FILE_ID = "vxwzfycnu9d"
SHEET_ID = "000001"

# 与 A/B 列同序：(是否州府, 城级)
DATA = [
    ("是", "中城"),  # 蓟
    ("否", "中城"),  # 北平
    ("否", "中城"),  # 襄平
    ("是", "中城"),  # 晋阳
    ("否", "小城"),  # 上党
    ("是", "大城"),  # 邺
    ("否", "中城"),  # 南皮
    ("否", "小城"),  # 平原
    ("是", "中城"),  # 北海
    ("否", "小城"),  # 济南
    ("是", "都城"),  # 洛阳
    ("否", "中城"),  # 河内
    ("是", "中城"),  # 濮阳
    ("否", "中城"),  # 陈留
    ("是", "中城"),  # 下邳
    ("否", "小城"),  # 小沛
    ("否", "中城"),  # 广陵
    ("是", "大城"),  # 许昌
    ("否", "中城"),  # 汝南
    ("否", "中城"),  # 谯
    ("是", "大城"),  # 长安
    ("否", "中城"),  # 天水
    ("否", "小城"),  # 安定
    ("是", "中城"),  # 武威
    ("否", "小城"),  # 西平
    ("是", "大城"),  # 襄阳
    ("否", "中城"),  # 宛
    ("否", "小城"),  # 新野
    ("否", "中城"),  # 江夏
    ("否", "中城"),  # 江陵
    ("否", "中城"),  # 长沙
    ("是", "大城"),  # 建业
    ("否", "中城"),  # 吴
    ("否", "中城"),  # 会稽
    ("否", "中城"),  # 柴桑
    ("否", "小城"),  # 庐江
    ("是", "大城"),  # 成都
    ("否", "中城"),  # 汉中
    ("否", "小城"),  # 梓潼
    ("否", "中城"),  # 江州
    ("是", "中城"),  # 交趾
    ("否", "中城"),  # 南海
]
assert len(DATA) == 42, len(DATA)

values = [
    {"row": 0, "col": 2, "value_type": "STRING", "string_value": "是否州府"},
    {"row": 0, "col": 3, "value_type": "STRING", "string_value": "城级"},
]
for i, (seat, level) in enumerate(DATA):
    values.append({"row": 1 + i, "col": 2, "value_type": "STRING", "string_value": seat})
    values.append({"row": 1 + i, "col": 3, "value_type": "STRING", "string_value": level})

args_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "set_values_args.json")
with open(args_path, "w", encoding="utf-8") as f:
    json.dump({"file_id": FILE_ID, "sheet_id": SHEET_ID, "values": values}, f, ensure_ascii=False)

cmd = [PY, "edsdk.py", "call", "sheet_set_range_value", "--json-file", args_path]
r = subprocess.run(cmd, cwd=SKILL_DIR, capture_output=True, text=True, encoding="utf-8")
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
