"""烘焙 Plan C 稀有掉率权重表（rareDropWeight）。

权重来源 = 配方 needRare 计数（同一 C 技能池内归一化）。
为什么用「需求计数」而非 E8 实测饥饿数：实测饥饿集中在高需求 subCat、低需求 subCat 显示 0（因供给过剩，非零需求）。
若直接按实测饥饿数加权，会把当前过剩的 subCat 权重压到 0 → 它们停产后反而饥饿，自相矛盾。
正确权重 = 需求占比；E8 实测已验证该占比的排序（jingtie/zhusha/cansi 为各池最缺）。

用法：
    python tools/gen_rare_weight.py            # 写回 config/firstShow_V4.xlsx
    python tools/gen_rare_weight.py --dry      # 只打印
"""
from __future__ import annotations
import sys
from pathlib import Path
import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SRC = Path(r"I:/buddyWork/sanWalk/config/firstShow_V4.xlsx")

HDR_FILL = PatternFill("solid", fgColor="FF4472C4")
HDR_FONT = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFFFF")
CELL_FONT = Font(name="Microsoft YaHei", size=10)
THIN = Side(style="thin", color="FFBFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="center")


def _rows(wb, name):
    ws = wb[name]
    it = list(ws.iter_rows(values_only=True))
    hdr = [str(c) if c is not None else "" for c in it[0]]
    return [dict(zip(hdr, r)) for r in it[1:] if any(x is not None for x in r)]


def _sub(tag: str) -> str:
    return tag.rsplit("_", 1)[0] if tag and "_" in tag else tag


def build(dry: bool):
    wb = openpyxl.load_workbook(SRC)
    recipes = _rows(wb, "recipe")
    bps = _rows(wb, "blueprint")

    # 1) 推导池（C 技能 → subCat 列表），与 parse.ts::rareSubCatBySkill 一致
    pool_of: dict[str, str] = {}
    pools: dict[str, list[str]] = {}
    for bp in bps:
        fs = str(bp.get("fromSkill") or "").strip()
        if not fs:
            continue
        direct: set[str] = set()
        gated: set[str] = set()
        for r in recipes:
            if str(r.get("needBlueprint") or "") == str(bp.get("tag")).strip():
                gated.add(str(r.get("skill") or ""))
                if r.get("needRare"):
                    direct.add(_sub(str(r["needRare"])))
        for r in recipes:
            if str(r.get("skill") or "") in gated and r.get("needRare"):
                direct.add(_sub(str(r["needRare"])))
        pools[fs] = sorted(direct)
        for s in direct:
            pool_of[s] = fs

    # 2) 需求计数（配方 needRare 出现次数）—— 仅作回退
    demand: dict[str, int] = {}
    for r in recipes:
        nr = r.get("needRare")
        if nr:
            s = _sub(str(nr))
            demand[s] = demand.get(s, 0) + 1

    # 2b) Plan C v2：优先用 E8 实测的「B 类实际稀有需求」(rareDemand.json)
    #     权重 = 各池内按实际 B 需求归一化；需求为 0（无人消费的孤儿稀有）→ 权重 0，C 不再掉
    import json
    actual: dict[str, int] = {}
    demand_path = Path(__file__).resolve().parent / "out" / "rareDemand.json"
    if demand_path.exists():
        try:
            with open(demand_path, encoding="utf-8") as f:
                actual = json.load(f)
            print(f"  读实测 B 需求 → {demand_path}")
        except Exception as e:  # noqa
            print(f"  ⚠ 读 rareDemand.json 失败，回退配方计数：{e}")

    # 3) 池内归一化权重
    rows = []
    print("稀有掉率权重（池内归一化）：")
    for sk, subs in sorted(pools.items()):
        actual_sum = sum(actual.get(s, 0) for s in subs)
        if actual_sum > 0:
            tot = actual_sum
            src = "实测B需求"
            w_of = lambda s: actual.get(s, 0)  # noqa
        else:
            tot = sum(demand.get(s, 0) for s in subs)
            src = "配方需求占比(回退)"
            w_of = lambda s: demand.get(s, 0)  # noqa
        print(f"  {sk:10s} 池{len(subs)}  [{src}]")
        for s in subs:
            w = w_of(s) / tot if tot else 1.0 / len(subs)
            rows.append([s, sk, round(w, 4), f"PlanCv2 {src}；手改后重跑以表为准"])
            print(f"      {s:12s} 权重 {w:.4f}")

    if dry:
        print("\n(--dry：未写文件)")
        return

    # 4) 写回 rareDropWeight 表
    if "rareDropWeight" in wb.sheetnames:
        del wb["rareDropWeight"]
    ws = wb.create_sheet("rareDropWeight")
    headers = ["subCat", "skillPool", "weight", "note"]
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.fill, cell.font, cell.border = HDR_FILL, HDR_FONT, BORDER
    for r, row in enumerate(rows, 2):
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.border, cell.alignment = CELL_FONT, BORDER, WRAP
    for c, w in enumerate([14, 12, 9, 46], 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A2"
    wb.save(SRC)
    print(f"\n已写 rareDropWeight 表 → {SRC}（{len(rows)} 行）")


if __name__ == "__main__":
    build("--dry" in sys.argv)
