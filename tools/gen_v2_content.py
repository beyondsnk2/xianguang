"""生成 V2 任务/材料/制造品/拜访人物 的实际配置 xlsx。

9 品质全扩版（2026-10-03）：任务/材料/制成品/稀有料/配方全部按品质 1-9 各成一档。
- 9 类技能 × 9 品质 = 81 个任务基型（taskTpl + 运行时 task 两表）。
- 材料：每 A 技能 2~3 种材料，品质 q 轮转分配材料类型、档位=q；每种材料间隔出现，
  但每技能材料合起来覆盖 1-9 全部档（咬合成立：B_q 总能在配对 A 技能处取到 tier-q 料）。
- 稀有料：9 种 × 品质 4-9 = 54。
- 制成品：35 族 × 9 品质 = 315。
- 配方：35 族 × 9 品质 = 315；咬合 n品B = n品A料(量) + n品C稀有料(质)；
  门槛 1-3 无料无图 / 4-6 需稀有料无图 / 7-9 需图+稀有料。

策略：加载现有 xlsx（保留地图与运行表），覆写 skill/item/recipe/blueprint/taskTpl/task。
一次性脚本，改设计后重跑即可。
"""
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SRC = Path(r"I:/buddyWork/sanWalk/config/firstShow_V3.xlsx")

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

# A 技能 → 2~3 种材料（品质 q 轮转分配材料类型，档位=q）
A_SKILL_MATS = {
    "mining": [("iron", "铁矿石"), ("copper", "铜矿石"), ("jade", "玉石料")],
    "herbalism": [("herb", "草药"), ("yicao", "异草")],
    "hunting": [("skin", "兽皮"), ("wild", "野味")],
}
# B 技能 → 配对 A 技能（咬合：B_q 吃配对 A 技能 tier-q 材料）
B_PAIRED_A = {"smithing": "mining", "alchemy": "herbalism", "crafting": "hunting"}
# B 技能 → 上品制造前置图纸
B_BLUEPRINT = {"smithing": "jie_yi_tu", "alchemy": "fang_dao_tu", "crafting": "chu_shi_tu"}
# B 技能 → 代表制成品族（task 直接产出该族 tier-q 基型）
B_REP_PRODUCT = {"smithing": "huan_shou_dao", "alchemy": "jin_chuang_yao", "crafting": "nu_ji"}

# ---------------------------------------------------------------- item
# 材料：品质 q → 类型 mats[(q-1)%n]，档位=q。每种材料间隔出现，但技能材料合覆盖 1-9。
ITEMS = []
for sk, mats in A_SKILL_MATS.items():
    n = len(mats)
    for q in range(1, 10):
        base, nm = mats[(q - 1) % n]
        ITEMS.append((f"{base}_{q}", f"{nm}·{q}品", "材料", base, q, q, q, 99, "A类", f"品质{q}；{sk}产出"))

RARE = [
    ("jingtie", "精铁", "晋阳;邺", "smithing"),
    ("xuantie", "玄铁", "武威;西平", "smithing"),
    ("xuelian", "雪莲", "西平", "alchemy"),
    ("longwenyu", "龙纹玉", "天水", "crafting"),
    ("xijiao", "犀角", "长沙", "crafting"),
    ("zhusha", "朱砂", "襄阳;江陵", "alchemy"),
    ("bainianshen", "百年参", "成都", "alchemy"),
    ("cansi", "蚕丝", "下邳;广陵;吴;建业", "crafting"),
    ("nanyao", "南药", "交趾;南海", "crafting"),
]
# 稀有料：9 种 × 品质 4-9（红线⑤ 稀有料品质下界≥4）
for tag, name, cities, skill in RARE:
    for q in range(4, 10):
        ITEMS.append((f"{tag}_{q}", f"{name}·{q}品", "稀有", tag, q, q, q, 99, "C类独占", f"产出城:{cities};品质{q}"))

# 制成品族（35）： tag,name,bskill,rare_tag,cityCraft,cityRare,cityBlueprint,note
PRODUCT_FAMILIES = [
    # 下品 品质1（6；下品1-3无料无图，中品起按品质取稀有料）
    ("huan_shou_dao", "环首刀", "smithing", "jingtie", "晋阳", "邺", "", "基础兵器"),
    ("mao_tou", "矛头", "smithing", "jingtie", "晋阳", "邺", "", "基础兵器"),
    ("jin_chuang_yao", "金创药", "alchemy", "zhusha", "襄阳", "江陵", "", "外伤药"),
    ("tang_ji", "汤剂", "alchemy", "zhusha", "襄阳", "江陵", "", "内服剂"),
    ("nu_ji", "弩机", "crafting", "cansi", "洛阳", "建业", "", "基础军械"),
    ("zi_che", "辎车", "crafting", "cansi", "洛阳", "建业", "", "运输"),
    # 下品 品质2（6）
    ("zha_jia_pian", "札甲片", "smithing", "xuantie", "晋阳", "武威", "", "基础护甲片"),
    ("tie_zu", "铁镞", "smithing", "xuantie", "晋阳", "武威", "", "箭矢料"),
    ("shang_yao", "伤药", "alchemy", "bainianshen", "襄阳", "成都", "", "进阶外伤"),
    ("jie_du_san", "解毒散", "alchemy", "bainianshen", "襄阳", "成都", "", "解毒"),
    ("che_ju", "车具", "crafting", "longwenyu", "洛阳", "天水", "", "通用件"),
    ("mu_xie", "木械", "crafting", "xijiao", "洛阳", "长沙", "", "工具"),
    # 下品 品质3（3，需稀有料无图）
    ("ma_zhang", "马掌", "smithing", "jingtie", "晋阳", "邺", "", "坐骑具"),
    ("xing_shen_dan", "醒神丹", "alchemy", "zhusha", "襄阳", "江陵", "", "提神"),
    ("diao_gou", "钓钩", "crafting", "cansi", "洛阳", "下邳", "", "渔具"),
    # 中品 品质4-6（10，需稀有料无图）
    ("heng_dao", "横刀", "smithing", "jingtie", "长安", "邺", "", "需精铁"),
    ("ming_guang_jia", "明光甲片", "smithing", "xuantie", "晋阳", "武威", "", "需玄铁"),
    ("ma_shuo", "马槊", "smithing", "jingtie", "江夏", "晋阳", "", "需精铁"),
    ("huan_hun_san", "还魂散", "alchemy", "zhusha", "宛", "襄阳", "", "需朱砂"),
    ("fu_shui", "符水", "alchemy", "bainianshen", "江陵", "成都", "", "需百年参"),
    ("da_huan_dan", "大还丹", "alchemy", "zhusha", "柴桑", "江陵", "", "需朱砂"),
    ("qiang_nu_ji", "强弩机", "crafting", "cansi", "洛阳", "建业", "", "需蚕丝"),
    ("lian_nu", "连弩", "crafting", "cansi", "梓潼", "下邳", "", "需蚕丝"),
    ("yun_ti", "云梯", "crafting", "longwenyu", "江州", "天水", "", "需龙纹玉"),
    ("zhi_nan_che", "指南车", "crafting", "xijiao", "邺", "长沙", "", "需犀角"),
    # 上品 品质7-9（10，需稀有料+图纸）
    ("qing_gang_jian", "青釭剑", "smithing", "jingtie", "西平", "邺", "下邳", "需精铁+结义图"),
    ("lian_huan_kai", "连环铠", "smithing", "xuantie", "晋阳", "武威", "下邳", "需玄铁+结义图"),
    ("fang_tian_hua_ji", "方天画戟", "smithing", "jingtie", "江夏", "晋阳", "武威", "需精铁+结义图"),
    ("jiu_zhuan", "九转还魂丹", "alchemy", "bainianshen", "江陵", "成都", "汉中", "需百年参+访道图"),
    ("tai_qing_dan", "太清丹", "alchemy", "zhusha", "许昌", "襄阳", "成都", "需朱砂+访道图"),
    ("yu_qing_dan", "玉清丹", "alchemy", "xuelian", "柴桑", "西平", "成都", "需雪莲+访道图"),
    ("mu_niu", "木牛流马", "crafting", "nanyao", "梓潼", "交趾", "建业", "需南药+出使图"),
    ("lian_nu_gai", "连弩改良", "crafting", "cansi", "洛阳", "建业", "南海", "需蚕丝+出使图"),
    ("pi_li_che", "霹雳车", "crafting", "xijiao", "长安", "长沙", "洛阳", "需犀角+出使图"),
    ("lou_chuan", "楼船", "crafting", "longwenyu", "江州", "天水", "建业", "需龙纹玉+出使图"),
]
# 制成品：35 族 × 9 品质
for tag, name, bskill, rare, cc, cr, cb, note in PRODUCT_FAMILIES:
    for q in range(1, 10):
        ITEMS.append((f"{tag}_{q}", f"{name}·{q}品", "成品", tag, q, q, q, 9, "B类", f"{note};品质{q}"))

# 名品（C 类上品赠礼，少量占位）
for tag, name in [("mingqi_jade", "名器图样"), ("mingqi_talisman", "符箓名品"), ("mingqi_exotic", "异邦名品")]:
    ITEMS.append((tag, name, "名品", "C类", "名品", 7, 9, 9, "C类上品", "人物赠礼"))

# ---------------------------------------------------------------- recipe
# 35 族 × 9 品质 = 315。列：tag,name,skill,quality,needItem1,needItem1Num,matQualityFloor,
#   needRare,needBlueprint,resultItem,resultNum,cityCraft,cityRare,cityBlueprint,note
RECIPES = []
for tag, name, bskill, rare, cc, cr, cb, note in PRODUCT_FAMILIES:
    askill = B_PAIRED_A[bskill]
    mats = A_SKILL_MATS[askill]
    mn = len(mats)
    for q in range(1, 10):
        base, _ = mats[(q - 1) % mn]
        need1 = f"{base}_{q}"
        need1num = 2 + (q - 1) // 2          # 2,2,3,3,4,4,5,5,6
        needRare = f"{rare}_{q}" if (rare and q >= 4) else ""
        needBp = B_BLUEPRINT[bskill] if q >= 7 else ""
        RECIPES.append((
            f"{tag}_{q}", name, bskill, q, need1, need1num, q,
            needRare, needBp, f"{tag}_{q}", 1, cc, cr, cb,
            f"咬合:{need1}+{(needRare or '无稀有')}{(('+' + needBp) if needBp else '')}",
        ))

# ---------------------------------------------------------------- blueprint
BLUEPRINTS = [
    ("jie_yi_tu", "结义图（名器图样）", "sworn", "结义线产出，上品制造前置"),
    ("fang_dao_tu", "访道图（符箓图）", "visiting", "访道线产出，上品制造前置"),
    ("chu_shi_tu", "出使图（异邦图）", "envoy", "出使线产出，上品制造前置"),
]

# ---------------------------------------------------------------- taskTpl + task（81 基型）
# taskTpl 列：tag,name,cls,skill,quality,attrBaseline,taskName,mainOutput,outputBase,evalInc,subOutput,nodeType,nodeName,note
# task 列：tag,name,nodeType,nodeName,needTime,getItem,getItemNum,getAttrXp,getAttrXpNum,
#         attrBaseline,cls,skill,quality,pinjie,evalInc,mainOutput,subOutput,note
# attrBaseline = int(品阶*4) = 4..36（品阶=品质 1-9，每层独立基准）。
# 评价四档增量统一 EVAL_STD；getAttrXp 留 None（任务不发属性）；C 类 getItem 空（好感未接）。
EVAL_STD = "0.0/0.3/0.6/1.0"
SKILL_NODE = {
    "mining": ("mine", "矿场"), "herbalism": ("herb", "药圃"), "hunting": ("hunt", "猎场"),
    "smithing": ("smith", "铁匠铺"), "alchemy": ("alchemy", "丹房"), "crafting": ("workshop", "机巧坊"),
    "visiting": ("temple", "道观"), "sworn": ("ground", "校场"), "envoy": ("embassy", "使馆"),
}
A_NAMES = [("采石", "开矿", "凿岩"), ("采草", "寻药", "探幽"), ("围猎", "入山", "逐珍")]
B_NAMES = [("锻铁", "铸兵", "锻甲"), ("炼药", "炼丹", "炼大丹"), ("制械", "造器", "机关")]
C_NAMES = [("寻访", "论道", "问道"), ("结交", "结义", "歃血"), ("通使", "持节", "远交")]
C_FAV = [20, 20, 20, 30, 30, 30, 40, 40, 40]  # 好感基数（按品质 1-9）


def _qname(base, q):
    return f"{base}·{q}品"


TASKTPL = []
TASKS_RUNTIME = []
for q in range(1, 10):
    abl = q * 4
    # A 类
    for i, (sk, nm) in enumerate([("mining", "采掘"), ("herbalism", "采药"), ("hunting", "猎奇")]):
        mats = A_SKILL_MATS[sk]
        base, _ = mats[(q - 1) % len(mats)]
        item = f"{base}_{q}"
        outbase = f"1;{max(2, 13 - q)}"
        node = SKILL_NODE[sk]
        tn = _qname(A_NAMES[i][(q - 1) // 3], q)
        TASKTPL.append((f"{sk}_{q}", nm, "A", sk, q, abl, tn, item, outbase, EVAL_STD,
                        "上等料概率随品质升", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, item, outbase,
                              None, None, abl, "A", sk, q, q, EVAL_STD, item, "A类材料",
                              "保底~名义区间；高品数量少但档位高"))
    # B 类
    for i, (sk, nm) in enumerate([("smithing", "锻造"), ("alchemy", "丹鼎"), ("crafting", "机巧")]):
        rep = B_REP_PRODUCT[sk]
        item = f"{rep}_{q}"
        cnt = 1 + (q - 1) // 3
        outbase = f"1;{cnt}"
        node = SKILL_NODE[sk]
        tn = _qname(B_NAMES[i][(q - 1) // 3], q)
        TASKTPL.append((f"{sk}_{q}", nm, "B", sk, q, abl, tn, item, outbase, EVAL_STD,
                        "省料25%·残料返还20%", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, item, outbase,
                              None, None, abl, "B", sk, q, q, EVAL_STD, item, "B类制成品",
                              "制成品基型产出；制造效率见 subOutput，运行时未接制造"))
    # C 类
    for i, (sk, nm) in enumerate([("visiting", "访道"), ("sworn", "结义"), ("envoy", "出使")]):
        node = SKILL_NODE[sk]
        tn = _qname(C_NAMES[i][(q - 1) // 3], q)
        fav = C_FAV[q - 1]
        TASKTPL.append((f"{sk}_{q}", nm, "C", sk, q, abl, tn, "好感", fav, EVAL_STD,
                        "图纸/名品(上品段起)", node[0], node[1], ""))
        TASKS_RUNTIME.append((f"{sk}_{q}", tn, node[0], node[1], 15 + q * 5, None, None,
                              None, None, abl, "C", sk, q, q, EVAL_STD, "好感", "C类好感",
                              f"好感基数 {fav}（运行时未接好感资源，getItem 暂空）；上品段起掉图纸/名品"))


def build():
    wb = openpyxl.load_workbook(SRC)
    _write(wb, "skill",
           ["tag", "name", "cls", "mainNode", "nodeName", "pointCities", "note"],
           SKILLS, [12, 10, 6, 12, 12, 40, 24])
    _write(wb, "item",
           ["tag", "name", "cat", "subCat", "tier", "qMin", "qMax", "stack", "source", "note"],
           ITEMS, [16, 14, 8, 12, 6, 6, 6, 6, 10, 28], tier_col=3)
    _write(wb, "recipe",
           ["tag", "name", "skill", "quality", "needItem1", "needItem1Num", "matQualityFloor",
            "needRare", "needBlueprint", "resultItem", "resultNum", "cityCraft", "cityRare", "cityBlueprint", "note"],
           RECIPES, [16, 12, 10, 8, 12, 12, 12, 10, 14, 14, 9, 10, 10, 12, 24])
    _write(wb, "blueprint",
           ["tag", "name", "fromSkill", "note"],
           BLUEPRINTS, [16, 24, 12, 40])
    _write(wb, "taskTpl",
           ["tag", "name", "cls", "skill", "quality", "attrBaseline", "taskName", "mainOutput",
            "outputBase", "evalInc", "subOutput", "nodeType", "nodeName", "note"],
           TASKTPL, [12, 10, 6, 12, 8, 11, 12, 14, 10, 10, 28, 12, 12, 10], tier_col=3)
    _write(wb, "task",
           ["tag", "name", "nodeType", "nodeName", "needTime", "getItem", "getItemNum",
            "getAttrXp", "getAttrXpNum", "attrBaseline", "cls", "skill", "quality",
            "pinjie", "evalInc", "mainOutput", "subOutput", "note"],
           TASKS_RUNTIME, [12, 10, 10, 12, 9, 16, 12, 10, 12, 11, 6, 12, 8, 7, 12, 14, 30, 34], tier_col=11)
    wb.save(SRC)
    print("已生成内容表到", SRC)
    print("sheets:", wb.sheetnames)
    print(f"skill={len(SKILLS)} item={len(ITEMS)} recipe={len(RECIPES)} blueprint={len(BLUEPRINTS)} "
          f"taskTpl={len(TASKTPL)} task={len(TASKS_RUNTIME)}")


if __name__ == "__main__":
    build()
