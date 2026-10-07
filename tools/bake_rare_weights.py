"""Plan C v2 (2026-10-07)：按 E8 实测的「B 类实际稀有需求」(rareDemand.json) 重算稀有掉率权重。
只动 xlsx 的 rareDropWeight 表（手改优先，gen_v4_econ.py 以此表为准）。
权重 = 各池内按 demandBySubCat 归一化；需求为 0 的 subCat 权重 0（C 不再掉无人消费的稀有）。
"""
import json
import openpyxl

SRC = "config/firstShow_V4.xlsx"
DEMAND = "tools/out/rareDemand.json"

# 池结构（与 gen_v2_content.py RARE 表一致）
POOLS = {
    "smithing": ["jingtie", "xuantie"],
    "alchemy": ["xuelian", "zhusha", "bainianshen"],
    "crafting": ["longwenyu", "xijiao", "cansi", "nanyao"],
}

with open(DEMAND, encoding="utf-8") as f:
    demand = json.load(f)

wb = openpyxl.load_workbook(SRC)
ws = wb["rareDropWeight"]
hdr = [c.value for c in ws[1]]
sub_i = hdr.index("subCat")
pool_i = hdr.index("skillPool")
w_i = hdr.index("weight")
note_i = hdr.index("note")

new_rows = []
for sub, pool in [(s, p) for p, subs in POOLS.items() for s in subs]:
    d = demand.get(sub, 0)
    new_rows.append((sub, pool, d))

# 每池归一化
by_pool = {p: [r for r in new_rows if r[1] == p] for p in POOLS}
for pool, rows in by_pool.items():
    total = sum(max(0, r[2]) for r in rows)
    for i, (sub, p, d) in enumerate(rows):
        w = (max(0, d) / total) if total > 0 else (1.0 / len(rows))
        by_pool[pool][i] = (sub, p, round(w, 4), d)

flat = [r for rows in by_pool.values() for r in rows]

# 写回
for row in ws.iter_rows(min_row=2):
    sub = row[sub_i].value
    match = next((r for r in flat if r[0] == sub), None)
    if match:
        row[w_i].value = match[2]
        row[note_i].value = f"PlanCv2 按实际B需求(d={match[3]})"
    else:
        row[w_i].value = 0.0
        row[note_i].value = "无B需求"

wb.save(SRC)
print("baked rareDropWeight (按实际 B 需求):")
for pool, rows in by_pool.items():
    print(f"  {pool}: " + ", ".join(f"{s}={w}" for s, _, w, _ in rows))
