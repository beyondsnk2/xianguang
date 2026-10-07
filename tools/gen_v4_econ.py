"""生成 V4 经济侧配置：price 骨架表 / subCatRatio 稀缺系数表 / item.price / item.sellable。

定价四层框架（产品文档 §3.2）：
  ① 锚点  材料 tier 1-9  → 手调骨架 3/4/5 · 9/11/13 · 27/32/38（三阶当量 1/3/9）
  ② 稀缺  稀有 54        → 材料基准(tier) × RARE_MULT × 稀缺系数(subCat)
  ③ 加成  成品 108       → (基础层 料×投喂量 + 稀有×1 + 额外层 料×投喂量 + 稀有×1) × CRAFT_MARKUP
  ④ 名品  3              → sellable = 0（不可售，tierRaw 是「名品」字符串）

关键设计：不做人工逐条定价，全部由本脚本从 item/recipe/blueprint 推导。
策划只手调第 ① 层骨架（price 表的材料 9 行）与第 ② 层系数（subCatRatio 表 9 行）。

**可重跑 & 手改优先**：
  - 若 xlsx 里已存在 `price` 表    → 以表里的材料 base 为准（改骨架后重跑即生效）
  - 若 xlsx 里已存在 `subCatRatio` → 以表里的 ratio 为准（改系数后重跑即生效）
  所以「先跑一遍 → 看落表结果 → 手改 → 再跑」是标准工作流，不会锁死在黑箱里。

用法：
    python tools/gen_v4_econ.py            # 生成并写回 config/firstShow_V4.xlsx
    python tools/gen_v4_econ.py --dry      # 只打印，不写文件
"""
from __future__ import annotations

import sys
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SRC = Path(r"I:/buddyWork/sanWalk/config/firstShow_V4.xlsx")

# ── 第 ① 层：材料 tier 骨架（三阶当量 1/3/9；段内 +1/+2）──
MAT_BASE_DEFAULT = {1: 3, 2: 4, 3: 5, 4: 9, 5: 11, 6: 13, 7: 27, 8: 32, 9: 38}
# ── 第 ② 层：稀有相对同 tier 材料的倍数 ──
RARE_MULT = 3
# ── 第 ② 层：稀缺系数 clamp（防剧烈波动）──
SCARCITY_MIN, SCARCITY_MAX = 0.7, 1.5
# ── 第 ③ 层：加工溢价 ──
CRAFT_MARKUP = 1.5
# ── sellRatio：卖出折率（未来市集用；本版只入 item 表不参与计算）──
SELL_RATIO = {"材料": 0.9, "稀有": 1.0, "成品": 1.0}

HDR_FILL = PatternFill("solid", fgColor="FF4472C4")
HDR_FONT = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFFFF")
CELL_FONT = Font(name="Microsoft YaHei", size=10)
TIER_FILL = {
    "材料": PatternFill("solid", fgColor="FFE8F5E9"),
    "成品": PatternFill("solid", fgColor="FFE6F1FB"),
    "名品": PatternFill("solid", fgColor="FFFCE4E4"),
    "稀有": PatternFill("solid", fgColor="FFFCE4E4"),
}
THIN = Side(style="thin", color="FFBFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="center")


def _write(wb, title, headers, rows, widths, tier_col=None):
    if title in wb.sheetnames:
        del wb[title]
    ws = wb.create_sheet(title)
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.fill, cell.font, cell.border = HDR_FILL, HDR_FONT, BORDER
    for r, row in enumerate(rows, 2):
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.border, cell.alignment = CELL_FONT, BORDER, WRAP
            if tier_col and row[tier_col - 1] in TIER_FILL:
                cell.fill = TIER_FILL[row[tier_col - 1]]
    for c, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A2"


def _rows(wb, name):
    ws = wb[name]
    it = list(ws.iter_rows(values_only=True))
    if not it:
        return []
    hdr = [str(c) if c is not None else "" for c in it[0]]
    return [dict(zip(hdr, r)) for r in it[1:] if any(x is not None for x in r)]


def _sub(tag: str) -> str:
    """'jingtie_9' → 'jingtie'"""
    return tag.rsplit("_", 1)[0] if tag and "_" in tag else tag


# ───────────────────────── 步骤 1：读现有表 ─────────────────────────

def step1_load(wb):
    items = _rows(wb, "item")
    recipes = _rows(wb, "recipe")
    blueprints = _rows(wb, "blueprint")
    if not items:
        raise SystemExit("item 表为空，先跑 gen_v2_content.py")
    return items, recipes, blueprints


# ───────────────────────── 步骤 2：推导稀有分池 ─────────────────────────

def step2_pools(recipes, blueprints):
    """复现 parse.ts::rareSubCatBySkill：图纸 → 它锁的 B 制造族 → 该族配方用到的稀有料。

    C 类技能一次产出是在**自己的池内均匀随机**（produce.ts::settleSocial → pickOne），
    所以每个 subCat 的供给份额 = (1/池大小) / 池数归一化。
    """
    pool_of: dict[str, str] = {}  # subCat → C 技能
    pools: dict[str, list[str]] = {}  # C 技能 → [subCat]
    for bp in blueprints:
        fs = str(bp.get("fromSkill") or "").strip()
        if not fs:
            continue
        gated: set[str] = set()
        direct: set[str] = set()
        for r in recipes:
            if str(r.get("needBlueprint") or "").strip() == str(bp.get("tag")).strip():
                gated.add(str(r.get("skill") or ""))
                if r.get("needRare"):
                    direct.add(_sub(str(r["needRare"])))
        for r in recipes:
            if str(r.get("skill") or "") in gated and r.get("needRare"):
                direct.add(_sub(str(r["needRare"])))
        pools[fs] = sorted(direct)
        for s in direct:
            pool_of[s] = fs
    return pool_of, pools


# ───────────────────────── 步骤 3：算 subCatRatio ─────────────────────────

def step3_ratio(recipes, pool_of, pools):
    """稀缺系数 = (需求份额 ÷ 供给份额) 再按均值归一，最后 clamp。

    方向：需求旺 / 供给少 → 价高；需求弱 / 供给多 → 价低（打到 clamp 下沿）。
    """
    demand: dict[str, int] = {}
    for r in recipes:
        nr = r.get("needRare")
        if nr:
            s = _sub(str(nr))
            demand[s] = demand.get(s, 0) + 1
    # 供给份额：池内均匀 → 1/池大小，再全局归一
    supply_w = {s: 1.0 / len(pools[sk]) for s, sk in pool_of.items() if sk in pools}
    tot_s = sum(supply_w.values()) or 1.0
    tot_d = sum(demand.values()) or 1.0

    raw = {}
    for s in sorted(set(demand) | set(supply_w)):
        d = demand.get(s, 0) / tot_d
        w = supply_w.get(s, 0.0) / tot_s
        raw[s] = (d / w) if w > 0 else 0.0
    mean = (sum(raw.values()) / len(raw)) if raw else 1.0
    ratio = {s: min(SCARCITY_MAX, max(SCARCITY_MIN, v / mean)) for s, v in raw.items()}
    return demand, supply_w, raw, ratio, tot_d, tot_s


# ───────────────────────── 步骤 4~6：定价 ─────────────────────────

def step_price(items, recipes, mat_base, ratio):
    """返回 {itemTag: price} 与 {itemTag: sellable}"""
    by_tag = {str(i["tag"]): i for i in items}
    # 成品：resultItem → recipe（取投喂量与稀有）
    rec_by_result: dict[str, dict] = {}
    for r in recipes:
        ri = r.get("resultItem")
        if ri:
            rec_by_result[str(ri)] = r

    price: dict[str, float] = {}
    sellable: dict[str, int] = {}

    # ① 材料：同 tier 同价（不区分 subCat）
    for i in items:
        if str(i.get("cat")) == "材料":
            t = int(i["tier"])
            price[str(i["tag"])] = float(mat_base.get(t, 0))

    # ② 稀有：材料基准(tier) × RARE_MULT × 稀缺系数(subCat)
    for i in items:
        if str(i.get("cat")) == "稀有":
            t = int(i["tier"])
            sc = ratio.get(str(i.get("subCat")), 1.0)
            price[str(i["tag"])] = round(mat_base.get(t, 0) * RARE_MULT * sc)

    # ③ 成品：(基础层 料×投喂量 + 稀有×1 + 额外层 料×投喂量 + 稀有×1) × CRAFT_MARKUP
    #    额外层（needItem2 / needRare2，取 q-1 阶的「其他行当」产出）是段内 4 个物品族
    #    唯一的成本差异来源 —— 不算它的话，同段同阶的 4 个成品价格会完全一样。
    for i in items:
        if str(i.get("cat")) != "成品":
            continue
        r = rec_by_result.get(str(i["tag"]))
        if not r:
            price[str(i["tag"])] = 0
            continue
        mat_p = price.get(str(r.get("needItem1")), 0.0)
        n = float(r.get("needItem1Num") or 0)
        rare_p = price.get(str(r["needRare"]), 0.0) if r.get("needRare") else 0.0
        # 额外层
        mat2_p = price.get(str(r.get("needItem2")), 0.0) if r.get("needItem2") else 0.0
        n2 = float(r.get("needItem2Num") or 0)
        rare2_p = price.get(str(r["needRare2"]), 0.0) if r.get("needRare2") else 0.0
        price[str(i["tag"])] = round((mat_p * n + rare_p + mat2_p * n2 + rare2_p) * CRAFT_MARKUP)

    # ④ 名品：不可售
    for i in items:
        tag = str(i["tag"])
        cat = str(i.get("cat"))
        if tag not in price:
            price[tag] = 0
        sellable[tag] = 0 if cat == "名品" else 1
    return price, sellable, by_tag


# ───────────────────────── 主流程 ─────────────────────────

def build(dry: bool):
    wb = openpyxl.load_workbook(SRC)
    items, recipes, blueprints = step1_load(wb)

    # 手改优先：已存在 price / subCatRatio 表则以表为准
    mat_base = dict(MAT_BASE_DEFAULT)
    if "price" in wb.sheetnames:
        for r in _rows(wb, "price"):
            if str(r.get("cat")) == "材料" and r.get("tier") is not None:
                try:
                    mat_base[int(r["tier"])] = int(float(r["base"]))
                except (TypeError, ValueError):
                    pass
        print("(price 表已存在 → 以表里的材料骨架为准)")

    pool_of, pools = step2_pools(recipes, blueprints)
    demand, supply_w, raw, ratio_calc, tot_d, tot_s = step3_ratio(recipes, pool_of, pools)
    ratio = dict(ratio_calc)
    if "subCatRatio" in wb.sheetnames:
        for r in _rows(wb, "subCatRatio"):
            s = str(r.get("subCat"))
            try:
                if s and r.get("ratio") is not None:
                    ratio[s] = float(r["ratio"])
            except (TypeError, ValueError):
                pass
        print("(subCatRatio 表已存在 → 以表里的 ratio 为准)")

    price, sellable, _ = step_price(items, recipes, mat_base, ratio)

    # ── 报表 ──
    print(f"\n稀有分池（C 技能 → subCat，池内均匀随机）：")
    for sk, subs in sorted(pools.items()):
        print(f"  {sk:10s} 池{len(subs)}: {'/'.join(subs)}")
    print(f"\n稀缺系数（需求 {int(tot_d)} 条 / 供给权重合计 {tot_s:.2f}）：")
    print(f"  {'subCat':12s} {'池':10s} {'需求':>5s} {'供给份额':>9s} {'裸比值':>7s} {'系数':>6s}")
    for s in sorted(ratio):
        print(
            f"  {s:12s} {pool_of.get(s,'-'):10s} {demand.get(s,0):>5d} "
            f"{supply_w.get(s,0)/tot_s:>9.3f} {raw[s]:>7.3f} {ratio[s]:>6.3f}"
        )

    print("\n材料骨架（cat=材料）：")
    print("  " + " ".join(f"t{t}={mat_base[t]}" for t in sorted(mat_base)))
    print("\n价格样例（tier 9）：")
    for cat in ("材料", "稀有", "成品"):
        g = [i for i in items if str(i.get("cat")) == cat and str(i.get("tier")) == "9"]
        for i in g[:3]:
            print(f"  {cat} {str(i['tag']):22s} {price[str(i['tag'])]:>7.0f} 文")

    prices = [p for p in price.values() if p > 0]
    print(f"\n统计：物品 {len(items)} 个 · 有价 {len(prices)} 个 · 不同价格 {len(set(prices))} 个")
    print(f"      价格区间 {min(prices):.0f} ~ {max(prices):.0f} 文 · 不可售 {sum(1 for v in sellable.values() if v==0)} 个")

    if dry:
        print("\n(--dry：未写文件)")
        return

    # ── 写回 item 表（原列 + price + sellable）──
    hdr = ["tag", "name", "cat", "subCat", "tier", "qMin", "qMax", "stack", "source", "price", "sellable", "note"]
    rows = []
    for i in items:
        tag = str(i["tag"])
        rows.append([
            tag, i.get("name"), i.get("cat"), i.get("subCat"), i.get("tier"),
            i.get("qMin"), i.get("qMax"), i.get("stack"), i.get("source"),
            int(price[tag]), sellable[tag], i.get("note"),
        ])
    _write(wb, "item", hdr, rows, [16, 14, 8, 12, 6, 6, 6, 6, 10, 8, 9, 30], tier_col=3)

    # ── price 表（骨架，生成器输入 + 策划手调面）──
    pr = []
    for t in sorted(mat_base):
        pr.append(["材料", t, mat_base[t], SELL_RATIO["材料"], f"三阶当量骨架；工钱/赏金/补货均读此值"])
    for t in range(4, 10):
        pr.append(["稀有", t, round(mat_base[t] * RARE_MULT), SELL_RATIO["稀有"],
                   f"= 材料t{t} × {RARE_MULT}；最终价再乘 subCatRatio 系数"])
    _write(wb, "price", ["cat", "tier", "base", "sellRatio", "note"], pr, [8, 6, 8, 9, 46], tier_col=1)

    # ── subCatRatio 表（系数，生成器算完落表供 review，手改后重跑以表为准）──
    sr = []
    for s in sorted(ratio):
        sr.append([
            s, pool_of.get(s, ""), len(pools.get(pool_of.get(s, ""), [])), demand.get(s, 0),
            round(supply_w.get(s, 0.0) / tot_s, 4), round(raw[s], 4), round(ratio[s], 4),
            f"池内均匀随机；clamp({SCARCITY_MIN},{SCARCITY_MAX})",
        ])
    _write(wb, "subCatRatio",
           ["subCat", "skillPool", "poolSize", "demandCount", "supplyShare", "rawRatio", "ratio", "note"],
           sr, [14, 12, 9, 12, 12, 9, 8, 34])

    wb.save(SRC)
    print(f"\n已写回 {SRC}")
    print(f"  item={len(rows)}（+price +sellable）  price={len(pr)}  subCatRatio={len(sr)}")


if __name__ == "__main__":
    build("--dry" in sys.argv)
