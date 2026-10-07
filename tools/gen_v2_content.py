"""生成 V5 任务/材料/制造品/稀有料/图纸 的实际配置 xlsx。

2026-10-07 结构重构（替代旧的「35 成品族 × 9 品质」笛卡尔积）：
- 旧结构病根：族名已隐含品质段，却又 ×9 品质 → 产出「1 品青釭剑」「9 品环首刀」等语义垃圾，
  且 B 任务只造 3 个代表族 → 32 死配方族 + 6 孤儿稀有。
- 新结构：品质三段（初段 q1-3 / 中段 q4-6 / 上段 q7-9）× 每段 4 物品族 × 每族 3 阶。
  → 12 物品族/技能 × 3 阶 = 36 成品/技能，共 108 成品 + 108 配方。
- A 材料：每 A 技能按段固定材料类型（3 段 × 3 阶）= 9 种/技能，共 27（不变）。
- C 稀有：每 C 技能仅中段/上段（6 个品质）= 6 种/技能，共 18（原 54）。初段无 C。
- 图纸：1 图 = 1 物品族，段内三阶共用；q1-3 天生会（needBlueprint 留空），q4 起全部需要 → 24 张。
- 配方两层需求：
    基础层 = 本技能配对 A 的同阶料 + 本技能配对 C 的同阶稀有（初段无 C 项）
    额外层 = 其他 A 技能的 (q-1) 阶料 + 其他 C 技能的 (q-1) 阶稀有（q-1<4 时无 C 项）
  额外层 (其他A × 其他C) = 2×2 = 4 种组合 → 天然区分每段 4 个物品族。

策略：加载现有 xlsx（保留地图与运行表），覆写 skill/item/recipe/blueprint/taskTpl/task。
一次性脚本，改设计后重跑即可。
"""
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SRC = Path(r"I:/buddyWork/sanWalk/config/firstShow_V4.xlsx")

HDR_FILL = PatternFill("solid", fgColor="FF4472C4")
HDR_FONT = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFFFF")
CELL_FONT = Font(name="Microsoft YaHei", size=10)
TIER_FILL = {
    "材料": PatternFill("solid", fgColor="FFE8F5E9"),
    "成品": PatternFill("solid", fgColor="FFE6F1FB"),
    "名品": PatternFill("solid", fgColor="FFFCE4E4"),
    "稀有": PatternFill("solid", fgColor="FFFCE4E4"),
    "A": PatternFill("solid", fgColor="FFE8F5E9"),
    "B": PatternFill("solid", fgColor="FFE6F1FB"),
    "C": PatternFill("solid", fgColor="FFFCE4E4"),
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


# ---------------------------------------------------------------- 段 / 阶
SEG_NAME = {1: "初段", 2: "中段", 3: "上段"}
RANK_NAME = {1: "一阶", 2: "二阶", 3: "三阶"}


def seg_of(q: int) -> int:
    """品质 → 段（1-3）"""
    return (q - 1) // 3 + 1


def rank_of(q: int) -> int:
    """品质 → 段内阶（1-3）"""
    return (q - 1) % 3 + 1


def qname(prefix: str, q: int) -> str:
    """物品/任务全名：{名}·{段名}{阶名}，例「中段·二阶偃月刀」"""
    return f"{prefix}·{SEG_NAME[seg_of(q)]}{RANK_NAME[rank_of(q)]}"


# ---------------------------------------------------------------- skill
SKILLS = [
    # tag, name, cls, mainNode, nodeName, pointCities, note
    ("mining", "采掘", "A", "mine", "矿场", "上党;南皮;济南;天水;长沙 + 晋阳(副)", "采石/开矿/凿岩"),
    ("herbalism", "采药", "A", "herb", "药圃", "平原;河内;广陵;谯;吴 + 交趾(副)", "采草/寻药/探幽"),
    ("hunting", "猎奇", "A", "hunt", "猎场", "北平;襄平;小沛;汝南;庐江 + 蓟(副)", "围猎/入山/逐珍"),
    ("smithing", "锻造", "B", "smith", "铁匠铺", "晋阳;邺;武威;西平;江夏 + 长安(副)", "锻铁/铸兵/锻甲"),
    ("alchemy", "丹鼎", "B", "alchemy", "丹房", "襄阳;宛;江陵;柴桑;成都 + 许昌(副)", "炼药/炼丹/炼大丹"),
    ("crafting", "机巧", "B", "workshop", "机巧坊", "洛阳;长安;建业;梓潼;江州 + 邺(副)", "制械/造器/机关"),
    ("visiting", "访道", "C", "temple", "道观", "汉中;北海;安定;新野 + 襄阳(副);成都(副)", "寻访/论道/问道"),
    ("sworn", "结义", "C", "ground", "校场", "蓟;濮阳;下邳;陈留 + 武威(副);濮阳(副)", "结交/结义/歃血"),
    ("envoy", "出使", "C", "embassy", "使馆", "许昌;会稽;交趾;南海 + 洛阳(副);建业(副)", "通使/持节/远交"),
]
SKILL_NODE = {
    "mining": ("mine", "矿场"), "herbalism": ("herb", "药圃"), "hunting": ("hunt", "猎场"),
    "smithing": ("smith", "铁匠铺"), "alchemy": ("alchemy", "丹房"), "crafting": ("workshop", "机巧坊"),
    "visiting": ("temple", "道观"), "sworn": ("ground", "校场"), "envoy": ("embassy", "使馆"),
}
# 只取主城市（" + " 之前），用于配方三城互异
SKILL_CITIES = {
    "mining": ["上党", "南皮", "济南", "天水", "长沙"],
    "herbalism": ["平原", "河内", "广陵", "谯", "吴"],
    "hunting": ["北平", "襄平", "小沛", "汝南", "庐江"],
    "smithing": ["晋阳", "邺", "武威", "西平", "江夏"],
    "alchemy": ["襄阳", "宛", "江陵", "柴桑", "成都"],
    "crafting": ["洛阳", "长安", "建业", "梓潼", "江州"],
    "visiting": ["汉中", "北海", "安定", "新野"],
    "sworn": ["蓟", "濮阳", "下邳", "陈留"],
    "envoy": ["许昌", "会稽", "交趾", "南海"],
}

# ---------------------------------------------------------------- 咬合配对
# B → 配对 A（基础层材料）；B → 配对 C（基础层稀有 / 图纸产出方）
B_PAIRED_A = {"smithing": "mining", "alchemy": "herbalism", "crafting": "hunting"}
B_PAIRED_C = {"smithing": "sworn", "alchemy": "visiting", "crafting": "envoy"}
A_SKILLS = ["mining", "herbalism", "hunting"]
C_SKILLS = ["visiting", "sworn", "envoy"]
# 「其他」技能 = 非配对的另外两个，用于额外层
OTHER_A = {b: [a for a in A_SKILLS if a != B_PAIRED_A[b]] for b in B_PAIRED_A}
OTHER_C = {b: [c for c in C_SKILLS if c != B_PAIRED_C[b]] for b in B_PAIRED_C}

# A 材料：每技能按段固定一种材料（段内三阶 = 品质）
A_MATS = {
    "mining": [("iron", "铁矿石"), ("copper", "铜矿石"), ("jade", "玉石料")],
    "herbalism": [("herb", "草药"), ("yicao", "异草"), ("lingzhi", "灵芝")],
    "hunting": [("skin", "兽皮"), ("wild", "野味"), ("shougu", "兽骨")],
}
# C 稀有：每技能仅中段(2)/上段(3)各一种，品质 4-9（红线⑤ 稀有品质下界 ≥4）
# C 稀有：每 C 技能 2 种，idx0 供中段、idx1 供上段（配方按段选）。
# ⚠ 关键：**每种都要覆盖 q4-9 全部 6 个品质**，不能按段切分。
#    曾按段切（jingtie 只 q4-6 / xuantie 只 q7-9），结果后期 C 任务全在 q7-9，
#    weightedPick 抽到 jingtie 时 `jingtie_7` 不存在 → 该次产出直接作废（实测 jingtie 供需 0.10）；
#    而 q7 制造的额外层偏要 q6 的中段稀有 → 永远拿不到。改回全品质覆盖后不再浪费。
C_RARES = {
    "sworn": [("jingtie", "精铁"), ("xuantie", "玄铁")],
    "visiting": [("zhusha", "朱砂"), ("xuelian", "雪莲")],
    "envoy": [("cansi", "蚕丝"), ("longwenyu", "龙纹玉")],
}

# ---------------------------------------------------------------- 物品族（3 技能 × 3 段 × 4 = 36）
PRODUCT_FAMILIES = {
    # 初段 2 族（前期信息量最小；q1 无额外层，故两族配方天然一致，靠「少」而非「异」降低学习成本）
    # 中段/上段 各 4 族（额外层 2×2 组合在此展开）
    "smithing": [
        [("huan_shou_dao", "环首刀"), ("zha_jia_pian", "札甲片")],
        [("heng_dao", "横刀"), ("ma_shuo", "马槊"), ("ming_guang_jia", "明光甲片"), ("yan_yue_dao", "偃月刀")],
        [("qing_gang_jian", "青釭剑"), ("fang_tian_hua_ji", "方天画戟"),
         ("lian_huan_kai", "连环铠"), ("zhang_ba_she_mao", "丈八蛇矛")],
    ],
    "alchemy": [
        [("jin_chuang_yao", "金创药"), ("tang_ji", "汤剂")],
        [("huan_hun_san", "还魂散"), ("fu_shui", "符水"), ("da_huan_dan", "大还丹"), ("xing_shen_dan", "醒神丹")],
        [("jiu_zhuan", "九转还魂丹"), ("tai_qing_dan", "太清丹"),
         ("yu_qing_dan", "玉清丹"), ("shang_qing_dan", "上清丹")],
    ],
    "crafting": [
        [("nu_ji", "弩机"), ("zi_che", "辎车")],
        [("qiang_nu_ji", "强弩机"), ("lian_nu", "连弩"), ("yun_ti", "云梯"), ("zhi_nan_che", "指南车")],
        [("mu_niu", "木牛流马"), ("pi_li_che", "霹雳车"), ("lou_chuan", "楼船"), ("lian_nu_gai", "连弩改良")],
    ],
}

# ---------------------------------------------------------------- item
ITEMS = []
# 材料：3 技能 × 3 段 × 3 阶 = 27
for sk, mats in A_MATS.items():
    for seg_i, (base, nm) in enumerate(mats, start=1):
        for rank in (1, 2, 3):
            q = (seg_i - 1) * 3 + rank
            ITEMS.append((f"{base}_{q}", qname(nm, q), "材料", base, q, q, q, 99, "A类", f"{SEG_NAME[seg_i]}{sk}产出"))
# 稀有：3 技能 × 2 种 × 品质 4-9 = 18；初段无 C（红线⑤）
for sk, rares in C_RARES.items():
    for base, nm in rares:
        for q in range(4, 10):
            ITEMS.append((f"{base}_{q}", qname(nm, q), "稀有", base, q, q, q, 99, "C类独占",
                          f"产出:{';'.join(SKILL_CITIES[sk])}"))
# 成品：36 族 × 3 阶 = 108
for bs, segs in PRODUCT_FAMILIES.items():
    for seg_i, fams in enumerate(segs, start=1):
        for ftag, fname in fams:
            for rank in (1, 2, 3):
                q = (seg_i - 1) * 3 + rank
                ITEMS.append((f"{ftag}_{q}", qname(fname, q), "成品", ftag, q, q, q, 9, "B类",
                              f"{SEG_NAME[seg_i]}{bs}制造"))
# 名品（C 类上品赠礼，少量占位）
for tag, name in [("mingqi_jade", "名器图样"), ("mingqi_talisman", "符箓名品"), ("mingqi_exotic", "异邦名品")]:
    ITEMS.append((tag, name, "名品", "C类", "名品", 7, 9, 9, "C类上品", "人物赠礼"))

# ---------------------------------------------------------------- recipe（108）
# 列：tag,name,skill,quality,needItem1,needItem1Num,matQualityFloor,needRare,
#     needItem2,needItem2Num,needRare2,needBlueprint,resultItem,resultNum,
#     cityCraft,cityRare,cityBlueprint,note
RECIPES = []
for bs, segs in PRODUCT_FAMILIES.items():
    askill = B_PAIRED_A[bs]
    cskill = B_PAIRED_C[bs]
    oa, oc = OTHER_A[bs], OTHER_C[bs]
    b_cities, c_cities = SKILL_CITIES[bs], SKILL_CITIES[cskill]
    for seg_i, fams in enumerate(segs, start=1):
        for idx, (ftag, fname) in enumerate(fams):
            # 额外层组合：4 族时取 (其他A × 其他C) 的 2×2 全组合；
            # 2 族（初段）时取对角 (0,0)/(1,1)，让两个族在 A、C 两个维度上都不同，差异最大化
            if len(fams) == 2:
                oa_skill, oc_skill = oa[idx], oc[idx]
            else:
                oa_skill, oc_skill = oa[idx % 2], oc[idx // 2]
            for rank in (1, 2, 3):
                q = (seg_i - 1) * 3 + rank
                # 基础层
                need1 = f"{A_MATS[askill][seg_i - 1][0]}_{q}"
                need1num = 2 + (q - 1) // 2                       # 2,2,3,3,4,4,5,5,6
                need_rare = f"{C_RARES[cskill][seg_i - 2][0]}_{q}" if seg_i >= 2 else ""
                # 额外层（q-1 阶；q=1 无额外层）
                q2 = q - 1
                need2 = f"{A_MATS[oa_skill][seg_of(q2) - 1][0]}_{q2}" if q2 >= 1 else ""
                need2num = (1 + (q - 1) // 3) if q2 >= 1 else 0    # 1,1,2,2,2,3,3,3,3
                need_rare2 = f"{C_RARES[oc_skill][seg_of(q2) - 2][0]}_{q2}" if q2 >= 4 else ""
                # 图纸：q1-3 天生会（留空），q4 起全部需要
                need_bp = f"bp_{ftag}" if q >= 4 else ""
                slot = (seg_i - 1) * 4 + idx
                cc = b_cities[slot % len(b_cities)]
                cr = c_cities[slot % len(c_cities)]
                cb = c_cities[(slot + 1) % len(c_cities)]
                assert len({cc, cr, cb}) == 3, f"三城互异失败 {ftag}_{q}: {cc}/{cr}/{cb}"
                parts = [need1]
                if need_rare:
                    parts.append(need_rare)
                if need2:
                    parts.append(f"{need2}(额外)")
                if need_rare2:
                    parts.append(f"{need_rare2}(额外)")
                RECIPES.append((
                    f"{ftag}_{q}", fname, bs, q,
                    need1, need1num, q,
                    need_rare,
                    need2, need2num, need_rare2,
                    need_bp, f"{ftag}_{q}", 1,
                    cc, cr, cb,
                    f"咬合:{' + '.join(parts)}",
                ))

# ---------------------------------------------------------------- blueprint（24）
# 1 图 = 1 物品族，段内三阶共用；q1-3 天生会 → 只给中段/上段 8 族/技能
BLUEPRINTS = []
for bs, segs in PRODUCT_FAMILIES.items():
    cskill = B_PAIRED_C[bs]
    for seg_i in (2, 3):
        for ftag, fname in segs[seg_i - 1]:
            BLUEPRINTS.append((f"bp_{ftag}", f"{fname}图", cskill,
                               f"{SEG_NAME[seg_i]}{bs}制造前置；{cskill}线产出"))

# ---------------------------------------------------------------- taskTpl + task（81 基型）
EVAL_STD = "0.0/0.3/0.6/1.0"
A_NAMES = {"mining": ["采石", "开矿", "凿岩"], "herbalism": ["采草", "寻药", "探幽"], "hunting": ["围猎", "入山", "逐珍"]}
B_NAMES = {"smithing": ["锻铁", "铸兵", "锻甲"], "alchemy": ["炼药", "炼丹", "炼大丹"], "crafting": ["制械", "造器", "机关"]}
C_NAMES = {"visiting": ["寻访", "论道", "问道"], "sworn": ["结交", "结义", "歃血"], "envoy": ["通使", "持节", "远交"]}
C_FAV = [20, 20, 20, 30, 30, 30, 40, 40, 40]

TASKTPL = []
TASKS_RUNTIME = []
for q in range(1, 10):
    abl = q * 4
    seg = seg_of(q)
    # A 类：产出该段对应材料
    for sk in A_SKILLS:
        base = A_MATS[sk][seg - 1][0]
        item = f"{base}_{q}"
        outbase = "8;16" if q >= 7 else f"1;{max(2, 13 - q)}"
        node = SKILL_NODE[sk]
        tn = qname(A_NAMES[sk][seg - 1], q)
        TASKTPL.append((f"{sk}_{q}", sk, "A", sk, q, abl, tn, item, outbase, EVAL_STD,
                        "上等料概率随品质升", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, item, outbase,
                              None, None, abl, "A", sk, q, q, EVAL_STD, item, "A类材料",
                              "保底~名义区间；高品数量少但档位高"))
    # B 类：产出在运行时从本段 4 个已解锁物品族中随机选（outputFamilies 列）
    for sk in ("smithing", "alchemy", "crafting"):
        fams = PRODUCT_FAMILIES[sk][seg - 1]
        fam_tags = ";".join(f[0] for f in fams)
        default_item = f"{fams[0][0]}_{q}"
        cnt = min(2, 1 + (q - 1) // 3)
        outbase = f"1;{cnt}"
        node = SKILL_NODE[sk]
        tn = qname(B_NAMES[sk][seg - 1], q)
        TASKTPL.append((f"{sk}_{q}", sk, "B", sk, q, abl, tn, default_item, outbase, EVAL_STD,
                        "省料25%·残料返还20%", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, default_item, outbase,
                              None, None, abl, "B", sk, q, q, EVAL_STD, default_item, fam_tags,
                              "mainOutput 为默认占位；运行时从 subOutput 的 4 个已解锁族中随机选实际制造目标"))
    # C 类：好感 + 稀有 + 图纸
    for sk in C_SKILLS:
        node = SKILL_NODE[sk]
        tn = qname(C_NAMES[sk][seg - 1], q)
        fav = C_FAV[q - 1]
        TASKTPL.append((f"{sk}_{q}", sk, "C", sk, q, abl, tn, "好感", fav, EVAL_STD,
                        "图纸/名品", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, None, None,
                              None, None, abl, "C", sk, q, q, EVAL_STD, "好感", "C类好感",
                              f"好感基数 {fav}；q≥4 起掉图纸；q≥4 起掉稀有"))


def build():
    wb = openpyxl.load_workbook(SRC)
    _write(wb, "skill",
           ["tag", "name", "cls", "mainNode", "nodeName", "pointCities", "note"],
           SKILLS, [12, 10, 6, 12, 12, 40, 24])
    _write(wb, "item",
           ["tag", "name", "cat", "subCat", "tier", "qMin", "qMax", "stack", "source", "note"],
           ITEMS, [16, 22, 8, 16, 6, 6, 6, 6, 10, 24], tier_col=3)
    _write(wb, "recipe",
           ["tag", "name", "skill", "quality", "needItem1", "needItem1Num", "matQualityFloor",
            "needRare", "needItem2", "needItem2Num", "needRare2", "needBlueprint",
            "resultItem", "resultNum", "cityCraft", "cityRare", "cityBlueprint", "note"],
           RECIPES, [16, 12, 10, 8, 12, 12, 12, 12, 12, 12, 12, 14, 14, 9, 10, 10, 12, 46])
    _write(wb, "blueprint",
           ["tag", "name", "fromSkill", "note"],
           BLUEPRINTS, [16, 16, 12, 34])
    _write(wb, "taskTpl",
           ["tag", "name", "cls", "skill", "quality", "attrBaseline", "taskName", "mainOutput",
            "outputBase", "evalInc", "subOutput", "nodeType", "nodeName", "note"],
           TASKTPL, [12, 10, 6, 12, 8, 11, 16, 14, 10, 10, 28, 12, 12, 10], tier_col=3)
    _write(wb, "task",
           ["tag", "name", "nodeType", "nodeName", "needTime", "getItem", "getItemNum",
            "getAttrXp", "getAttrXpNum", "attrBaseline", "cls", "skill", "quality",
            "pinjie", "evalInc", "mainOutput", "subOutput", "note"],
           TASKS_RUNTIME, [12, 18, 10, 12, 9, 16, 12, 10, 12, 11, 6, 12, 8, 7, 12, 14, 34, 40], tier_col=11)
    wb.save(SRC)
    print("已生成内容表到", SRC)
    print("sheets:", wb.sheetnames)
    print(f"skill={len(SKILLS)} item={len(ITEMS)} recipe={len(RECIPES)} blueprint={len(BLUEPRINTS)} "
          f"taskTpl={len(TASKTPL)} task={len(TASKS_RUNTIME)}")
    n_prod = sum(1 for i in ITEMS if i[2] == "成品")
    n_mat = sum(1 for i in ITEMS if i[2] == "材料")
    n_rare = sum(1 for i in ITEMS if i[2] == "稀有")
    print(f"成品={n_prod} 材料={n_mat} 稀有={n_rare} 名品={len(ITEMS) - n_prod - n_mat - n_rare}")


if __name__ == "__main__":
    build()
