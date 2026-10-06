"""生成 V2 技能等级 × 任务品质 × 产出 的设计表（doc/V2/设计_V2技能与任务品质_设计表.xlsx）。

产出 5 个 sheet：
  1. 技能分档      10 档 × 品质窗口（滑动窗口的权威口径）
  2. 九品三段      命名 / 分段 / 权重
  3. 评价与收益    四档评价 × A/B/C 三类差异化
  4. 产出四层      材料 / 制成品 / 配方 / 其他奖励
  5. 红线校验      5 条配置校验规则

一次性脚本，改设计后重跑即可。
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

OUT = Path(r"I:/buddyWork/sanWalk/doc/V2/设计_V2技能与任务品质_设计表.xlsx")

HDR_FILL = PatternFill("solid", fgColor="FF4472C4")
HDR_FONT = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFFFF")
CELL_FONT = Font(name="Microsoft YaHei", size=10)
NOTE_FONT = Font(name="Microsoft YaHei", size=10, bold=True, color="FF9C0006")
TIER_FILL = {
    "下品": PatternFill("solid", fgColor="FFE8F5E9"),
    "中品": PatternFill("solid", fgColor="FFE6F1FB"),
    "上品": PatternFill("solid", fgColor="FFFCE4E4"),
    "警告": PatternFill("solid", fgColor="FFFFE0B2"),
    "红线": PatternFill("solid", fgColor="FFFCE8E6"),
}
THIN = Side(style="thin", color="FFBFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="center")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)


def write_sheet(wb, title, headers, rows, widths, notes=None, tier_col=None):
    ws = wb.create_sheet(title)
    r = 1
    for note in notes or []:
        ws.cell(row=r, column=1, value=note).font = NOTE_FONT
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=len(headers))
        r += 1
    if notes:
        r += 1
    head_row = r
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=head_row, column=c, value=h)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, HDR_FONT, BORDER, CENTER
    for row in rows:
        r += 1
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.border, cell.alignment = CELL_FONT, BORDER, WRAP
            if tier_col and row[tier_col - 1] in TIER_FILL:
                cell.fill = TIER_FILL[row[tier_col - 1]]
    for c, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = ws.cell(row=head_row + 1, column=1)
    ws.auto_filter.ref = (
        f"A{head_row}:{get_column_letter(len(headers))}{head_row + len(rows)}"
    )
    return ws


def build():
    wb = Workbook()
    wb.remove(wb.active)

    # ---- 1. 技能分档 × 品质窗口 -------------------------------------------
    # 滑动窗口：窗口宽 3，随档位每次 +1；第 8 档起触顶，恒为 {7,8,9}。
    # 例：1 档={1,2,3}、2 档={2,3,4} … 7 档={7,8,9}、8~10 档={7,8,9}（封顶）
    stage_rows = []
    for stage in range(1, 11):
        lo = min(stage, 7)  # 窗口下沿，7 之后钉死在 {7,8,9}
        qualities = [lo, lo + 1, lo + 2]
        stage_rows.append([
            f"{stage} 档",
            f"Lv{(stage - 1) * 10 + 1}-{(stage - 1) * 10 + 10}",
            "、".join(f"{q} 品" for q in qualities),
            "、".join(str(q) for q in qualities),
            "九品全开（触顶）" if stage == 8 else ("封顶，只提权重" if stage >= 9 else ""),
            {
                1: "50/35/15", 2: "50/35/15", 3: "45/35/20", 4: "45/35/20",
                5: "40/35/25", 6: "35/35/30", 7: "30/35/35", 8: "20/30/50",
                9: "20/30/50", 10: "15/30/55",
            }[stage],
        ])
    write_sheet(
        wb, "技能分档",
        ["技能档位", "等级区间", "开放品质（中文）", "开放品质（数字）", "备注", "窗口内权重 低/中/高"],
        stage_rows,
        [10, 14, 24, 18, 20, 22],
        notes=[
            "🔴 滑动窗口：每档技能只开放 3 种品质，窗口随档位上移；第 8 档（Lv80）触顶。",
            "🔴 第 9、10 档不再开新品质，只提高高品权重 —— 对应「后面没有新档位可以解锁了」。",
            "⚠ 推论③（已证伪）：高档技能刷不到低品 → 曾据此配「委活槽」兜底。",
            "✅ 复核后委活槽已取消（用户裁定：6 品 B 吃 6 品 A + 6 品 C，同品咬合不需要低品兜底）。",
            "✅ 断供是伪命题：A 料三阶按当量折算（1/3/9），精制料做下品制造绰绰有余 —— 断的是叫法不是供给。",
        ],
    )

    # ---- 2. 九品三段 -------------------------------------------------------
    quality_rows = [
        [1, "一品", "下品", "1-3", "50%", "8%", "灰绿", "基础层主力，全程可刷"],
        [2, "二品", "下品", "1-3", "35%", "12%", "灰绿", ""],
        [3, "三品", "下品", "1-3", "15%", "16%", "灰绿", "下品上限"],
        [4, "四品", "中品", "4-6", "50%", "20%", "蓝", "中品起步，需 4 档"],
        [5, "五品", "中品", "4-6", "35%", "24%", "蓝", ""],
        [6, "六品", "中品", "4-6", "15%", "28%", "蓝", "中品上限"],
        [7, "七品", "上品", "7-9", "50%", "30%", "橙红", "上品起步，需 7 档"],
        [8, "八品", "上品", "7-9", "35%", "35%", "橙红", ""],
        [9, "九品", "上品", "7-9", "15%", "40%", "橙红", "绝对上限，需 8 档"],
    ]
    write_sheet(
        wb, "九品三段",
        ["品级", "命名", "段", "段内区间", "1 档技能刷出权重", "9 档技能刷出权重", "表现色", "备注"],
        quality_rows,
        [8, 10, 10, 12, 18, 18, 10, 24],
        notes=[
            "✅ 玩家只记三段（下品/中品/上品），不记九个数 —— 决策 P2 挂机层必须收敛。",
            "✅ 九品命名向「九品中正制」致敬。",
        ],
        tier_col=3,
    )

    # ---- 3. 评价 × 三类收益 ------------------------------------------------
    eval_rows = [
        ["拙", "0.0×", "1.0", 25, "不费吹灰之力", "A/B/C 同为保底 1.0×，无任何差异"],
        ["平", "0.3×", "1.0", 45, "中规中矩", "常规档，绝大多数任务是这一档"],
        ["佳", "0.6×", "1.0", 25, "颇有所得", "开始体现三类差异"],
        ["绝", "1.0×", "1.0", 5, "前途未卜", "三类收益分化最大的一档"],
    ]
    write_sheet(
        wb, "评价与收益",
        ["评价", "增量", "保底", "权重%", "浅层提示", "说明"],
        eval_rows,
        [10, 10, 10, 10, 16, 40],
        notes=[
            "🔴 沿用 V2-5 波动外置：实际奖励 = 保底 1× + 增量（0~1×），永不倒扣。",
            "🔴 技能经验不受评价影响（技能经验细密，不能靠运气）。",
            "",
            "🔴 同一个评价下，三类任务的收益完全不同 —— 这是本设计的关键分化点：",
        ],
    )
    ws = wb["评价与收益"]
    r = ws.max_row + 2
    tier_head = ["收益项", "A 采集（凿山/采药/涉险）", "B 制造（铸兵/炼丹/制器）", "C 人物（访异人/结交/使节）"]
    for c, h in enumerate(tier_head, 1):
        cell = ws.cell(row=r, column=c, value=h)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, HDR_FONT, BORDER, CENTER
    gain_rows = [
        ["① 主产出", "基础材料 ×2", "制成品 ×2", "好感度 ×2"],
        ["② 特色收益", "上等料概率 +（1 档 8% → 9 档 35%）", "材料消耗 −25%（省料=多造）", "稀有材料品质 ↑"],
        ["③ 技能经验", "×1.5", "×1.5", "×1.5"],
        ["④ 附加", "—", "残料返还 20%", "高品质稀有道具（4-6 品起）"],
        ["⑤ 图纸", "✗ 不给", "✗ 不给", "概率 +10%"],
        ["⑥ 稀有材料", "🔴 永不给", "消耗", "① 产出（独占）"],
    ]
    for row in gain_rows:
        r += 1
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.border, cell.alignment = CELL_FONT, BORDER, WRAP
            if c == 1:
                cell.font = Font(name="Microsoft YaHei", size=10, bold=True)
            if "🔴" in str(v):
                cell.fill = TIER_FILL["红线"]

    # ---- 4. 产出四层 -------------------------------------------------------
    ws = wb.create_sheet("产出四层")
    ws.cell(row=1, column=1, value="🔴 四层产出 × 三条不可破红线（红线由 npm run check 的 parse.ts 校验，不靠人记）").font = NOTE_FONT
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=6)
    head = ["层", "内容", "来源技能", "品质段", "跨城要求", "备注"]
    for c, h in enumerate(head, 1):
        cell = ws.cell(row=3, column=c, value=h)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, HDR_FONT, BORDER, CENTER
    out_rows = [
        ["① 材料 · 普通", "7 种 × 三阶（普通/上等/精制，换算 1/3/9）", "A 采集独占", "1-9 品", "🔴 产地按城", "同名升阶，不侵入稀有材料"],
        ["① 材料 · 稀有", "9 种：精铁·玄铁·雪莲·龙纹玉·犀角·朱砂·百年参·蚕丝·南药", "🔴 C 人物独占", "4-9 品", "🔴 产地按城", "C 供质 / A 供量"],
        ["② 制成品 · 下品", "~15 条：环首刀·矛头·札甲片 / 金创药·汤剂 / 弩机·车具·辎车", "B 制造", "1-3 品常驻", "无", "只需 A 类材料（本阶或更高阶按当量折算）"],
        ["② 制成品 · 中品", "~10 条：横刀·明光甲片 / 还魂散·符水 / 辎车改良·强弩机", "B 制造", "4-6 品", "🔴 图纸（C 类）+ 4-6 品 C 稀有料", "🔴 同品咬合：4-6 品 A 料（量）+ C 稀有料（质），不用低品料"],
        ["② 制成品 · 上品", "~10 条：青釭剑·丈八蛇矛 / 九转还魂丹 / 木牛流马·连弩改良", "B 制造", "7-9 品", "🔴 图纸（C 类）+ 7-9 品 C 稀有料", "🔴 同品咬合：7-9 品 A 料（量）+ C 稀有料（质），不用低品料"],
        ["② 投喂铁律", "🔴 n 品制造只吃 q ≥ n 的材料；q < n 的料永远喂不进 n 品制造", "全 B 类", "全品", "—", "单向才保住高品 A 料的档位价值（双向=低品料按数量平替）"],
        ["③ 配方（图纸）", "符箓图纸（访道）/ 名器图样（结义）/ 异邦图纸（出使）", "🔴 C 人物独占", "—", "🔴 图纸产地按城", "一次性解锁进配方册，永久有效，不占背包"],
        ["④ 其他奖励", "好感度 / 名品 / 跑商道具 / 势力好感", "C 人物 + 机巧", "名品限 7-9 品", "—", "好感与事迹传播并行，深交渠道"],
    ]
    r = 3
    for row in out_rows:
        r += 1
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.border, cell.alignment = CELL_FONT, BORDER, WRAP
            if "🔴" in str(v):
                cell.fill = TIER_FILL["红线"]
    for c, w in enumerate([16, 52, 18, 14, 30, 28], 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A4"

    # ---- 5. 红线校验 -------------------------------------------------------
    write_sheet(
        wb, "红线校验",
        ["#", "校验规则", "拦住什么", "实现位置"],
        [
            [1, "blueprint.fromSkill 必须是 C 类技能", "🔴 红线②：图纸被 A/B 自行研发 → C 类可跳过", "src/config/parse.ts"],
            [2, "稀有材料（cat=材料 且 tier=稀有）的产出技能必须是 C 类", "🔴 红线①：A 类越权产稀有 → 供质分工失效", "src/config/parse.ts"],
            [3, "recipe 的图纸城 / 材料A城 / 材料B城三者互不相同", "🔴 红线③：跨城依赖被绕过", "src/config/parse.ts"],
            [4, "每技能 maxQuality 序列 = 滑动窗口（相邻档差 ≤1，窗口宽恒 3）", "品质窗口配错，破坏滑动窗口规则", "src/config/parse.ts"],
            [5, "recipe.matQualityFloor ≥ recipe.qualityMin（投喂材料品质不得低于成品品质）", "🔴 红线④：低品料被塞进高品配方 → A 类的档位投入被平替", "src/config/parse.ts"],
            [6, "稀有材料的产出品质下界 ≥ 4（C 类 4 品起）", "稀有料在低品任务里乱掉，破坏九品分段", "src/config/parse.ts"],
        ],
        [6, 56, 46, 24],
        notes=[
            "🔴 这些校验是本设计的红线自动化：npm run check 每次跑，不靠人记。",
            "✅ 原第 5 条「委活槽数量 = 1」随委活槽取消（2026-10-03 用户裁定）；断供经复核是伪命题。",
        ],
        tier_col=2,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    wb.save(OUT)
    print(f"已生成 {OUT}")
    print(f"sheet：{wb.sheetnames}")


if __name__ == "__main__":
    build()
