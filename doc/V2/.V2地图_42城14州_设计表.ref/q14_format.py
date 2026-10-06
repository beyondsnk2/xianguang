# -*- coding: utf-8 -*-
"""「设施清单」sheet 的样式：州府行高亮 + 筛选 + 下拉枚举。"""

import json
import os
import subprocess
import tempfile

SKILL_DIR = r"G:/workBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit"
PY = r"C:/Users/beyondsnk/.workbuddy/binaries/python/versions/3.13.12/python.exe"
FILE_ID = r"I:/buddyWork/sanWalk/doc/V2/V2地图_42城14州_设计表.xlsx"
SHEET_ID = "Q9E250"

# 州府行（0-based 行索引，含表头行占位）：蓟晋阳邺北海洛阳濮阳下邳许昌长安武威襄阳建业成都交趾
SEAT_ROWS = [1, 4, 6, 9, 11, 13, 15, 18, 21, 24, 26, 32, 37, 41]
assert len(SEAT_ROWS) == 14, len(SEAT_ROWS)

LAST_ROW = 42   # 0-based，第 43 行
LAST_COL = 10   # 0-based，K 列


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


# 1) 州府行浅底
for r in SEAT_ROWS:
    out = call("sheet_set_cell_style", {
        "sheet_id": SHEET_ID, "file_id": FILE_ID,
        "start_row": r, "start_col": 0, "end_row": r, "end_col": LAST_COL,
        "format": {"background_color": "FFD9E2F3"},
    })
    print("seat row", r, "->", out)

# 2) 筛选（表头 0 行，数据 1~42 行）
print("filter ->", call("sheet_set_filter", {
    "sheet_id": SHEET_ID, "file_id": FILE_ID,
    "start_row": 0, "start_col": 0, "end_row": LAST_ROW, "end_col": LAST_COL,
    "header_start_row": 0, "header_end_row": 0,
}))

# 3) 下拉：是否州府（C）＋ 港口（K）共享 是/否
print("dv 是/否 ->", call("sheet_set_data_validation", {
    "sheet_id": SHEET_ID, "file_id": FILE_ID, "type": "LIST",
    "col_indexes": [{"start": 2, "end": 2}, {"start": 10, "end": 10}],
    "ignore_rows": 1,
    "select_options": [{"id": "y", "text": "是"}, {"id": "n", "text": "否"}],
}))

# 4) 下拉：城级（D）
print("dv 城级 ->", call("sheet_set_data_validation", {
    "sheet_id": SHEET_ID, "file_id": FILE_ID, "type": "LIST",
    "col_indexes": [{"start": 3, "end": 3}],
    "ignore_rows": 1,
    "select_options": [
        {"id": "1", "text": "都城"}, {"id": "2", "text": "大城"},
        {"id": "3", "text": "中城"}, {"id": "4", "text": "小城"},
    ],
}))
