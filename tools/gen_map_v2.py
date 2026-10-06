# -*- coding: utf-8 -*-
"""V2 地图 → 配置生成器。

输入：42 城 60×45 网格坐标（M12 定档）+ 城连接表（66 条道路，2026-10-06 用户修正）
输出：config/firstShow_V3.xlsx
      ├─ mapNode   城节点(2×2) + 设施节点(1 格)，共 96 个
      ├─ mapRoad   道路格，逐格一行（先 Y 后 X）
      ├─ city      42 城 + 各自的设施类型
      ├─ cityLink  城际连通 + dist（城心 Dijkstra 格距）——连通唯一事实源
      ├─ task      12 条设施级任务（产出待配方树定稿）
      ├─ config    全局参数
      ├─ attrLv    升级曲线（沿用 V3）
      └─ $map      60×45 图形化示意图（0 空 / 1 路 / 2 城 / 3 设施）

路网规则同 V1：节点四邻域相邻即连边，边不落表，距离用 Dijkstra。
变更史：V2=67 连通；V3=66 连通（删 晋阳-上党、邺-河内；增 河内-上党）+ cityLink 表。
"""

from collections import deque

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

GRID_W, GRID_H = 60, 45
SRC_PATH = r"I:/buddyWork/sanWalk/config/firstShow_V3.xlsx"
# 输入源 = V3（含全部内容：地图几何 + attrLv + 技能/物品/配方/蓝图/任务模板等）。
# 生成器只重算「地理基底」相关表（mapNode/mapRoad/city/state/cityLink/task/config/attrLv），
# 内容表（skill/item/recipe/blueprint/taskTpl）从 V3 原样透传，避免重生成时丢失。
# 沿用 firstShow 配置集、版本号 V3：加载器默认取同集最大版本，游戏运行时自动吃这张地图；
# V1 文件保留作历史参考（不再作为生成器输入），想回跑旧节奏用 `npm run check:v1`。
OUT_PATH = r"I:/buddyWork/sanWalk/config/firstShow_V3.xlsx"

FACILITY_NAMES = {
    'mine': '矿场', 'herb': '药圃', 'nanyao': '南药谷', 'hunt': '猎场',
    'smith': '铁匠铺', 'alchemy': '丹房', 'workshop': '机巧坊', 'temple': '道观',
    'hut': '隐庐', 'ground': '校场', 'tavern': '酒肆', 'embassy': '使馆',
}

# tag, 中文名, cx, cy, 主设施, 副设施(仅州府), 所属州(state 表 tag)
CITIES = [
    ('ji',        '蓟',   38,  7, 'ground',  'hunt',    'youzhou'),
    ('beiping',   '北平', 44,  5, 'hunt',    None,      'youzhou'),
    ('xiangping', '襄平', 50,  3, 'hunt',    None,      'youzhou'),
    ('jinyang',   '晋阳', 26, 12, 'smith',   'mine',    'bingzhou'),
    ('shangdang', '上党', 33, 16, 'mine',    None,      'bingzhou'),
    ('ye',        '邺',   35, 13, 'smith',   'workshop','jizhou'),
    ('nanpi',     '南皮', 41,  9, 'mine',    None,      'jizhou'),
    ('pingyuan',  '平原', 40, 13, 'herb',    None,      'jizhou'),
    ('beihai',    '北海', 52, 14, 'temple',  None,      'qingzhou'),
    ('jinan',     '济南', 46, 14, 'mine',    None,      'qingzhou'),
    ('luoyang',   '洛阳', 29, 21, 'workshop','embassy', 'siling'),
    ('henei',     '河内', 28, 17, 'herb',    None,      'siling'),
    ('puyang',    '濮阳', 40, 17, 'ground',  'tavern',  'yanzhou'),
    ('chenliu',   '陈留', 35, 20, 'tavern',  None,      'yanzhou'),
    ('xiaopei',   '小沛', 43, 19, 'hunt',    None,      'xuzhou'),
    ('xiapi',     '下邳', 46, 22, 'ground',  None,      'xuzhou'),
    ('guangling', '广陵', 50, 26, 'herb',    None,      'xuzhou'),
    ('qiao',      '谯',   39, 23, 'herb',    None,      'yuzhou'),
    ('xuchang',   '许昌', 32, 23, 'embassy', 'alchemy', 'yuzhou'),
    ('runan',     '汝南', 34, 27, 'hunt',    None,      'yuzhou'),
    ('changan',   '长安', 24, 20, 'workshop','smith',   'yongzhou'),
    ('anding',    '安定', 19, 15, 'temple',  None,      'yongzhou'),
    ('tianshui',  '天水', 15, 19, 'mine',    None,      'yongzhou'),
    ('wuwei',     '武威',  6, 13, 'smith',   'tavern',  'liangzhou'),
    ('xiping',    '西平',  9, 18, 'smith',   None,      'liangzhou'),
    ('wan',       '宛',   27, 25, 'alchemy', None,      'jingzhou'),
    ('xinye',     '新野', 31, 27, 'temple',  None,      'jingzhou'),
    ('xiangyang', '襄阳', 29, 30, 'alchemy', 'hut',     'jingzhou'),
    ('jiangling', '江陵', 27, 34, 'alchemy', None,      'jingzhou'),
    ('jiangxia',  '江夏', 37, 31, 'smith',   None,      'jingzhou'),
    ('changsha',  '长沙', 29, 38, 'mine',    None,      'jingzhou'),
    ('lujiang',   '庐江', 42, 30, 'hunt',    None,      'yangzhou'),
    ('jianye',    '建业', 46, 27, 'workshop','embassy', 'yangzhou'),
    ('wu',        '吴',   50, 30, 'herb',    None,      'yangzhou'),
    ('kuaiji',    '会稽', 52, 33, 'embassy', None,      'yangzhou'),
    ('chaisang',  '柴桑', 39, 35, 'alchemy', None,      'yangzhou'),
    ('hanzhong',  '汉中', 20, 24, 'temple',  None,      'yizhou'),
    ('zitong',    '梓潼', 16, 27, 'workshop',None,      'yizhou'),
    ('chengdu',   '成都', 11, 30, 'alchemy', 'temple',  'yizhou'),
    ('jiangzhou', '江州', 18, 34, 'workshop',None,      'yizhou'),
    ('jiaozhi',   '交趾', 23, 42, 'embassy', 'nanyao',  'jiaozhou'),
    ('nanhai',    '南海', 35, 43, 'embassy', None,      'jiaozhou'),
]

# 州定义（V3 渲染新增）：tag, 中文名, 城块色。仅地理分组+渲染着色，不限定材料/玩法。
# tag 带 zhou 后缀，避免与城 tag 冲突（蓟 = 'ji'，冀州 = 'jizhou'）。
STATES = [
    ('youzhou',  '幽州', '#5B8FD6'), ('bingzhou', '并州', '#A98BD4'),
    ('jizhou',   '冀州', '#DE7C7C'), ('qingzhou', '青州', '#4FBFA6'),
    ('siling',   '司隶', '#E0A24F'), ('yanzhou',  '兖州', '#BCC45E'),
    ('xuzhou',   '徐州', '#4FB2D8'), ('yuzhou',   '豫州', '#D97FAE'),
    ('yongzhou', '雍州', '#C9A45E'), ('liangzhou','凉州', '#9AA0AC'),
    ('jingzhou', '荆州', '#7CC46E'), ('yangzhou', '扬州', '#40BEA8'),
    ('yizhou',   '益州', '#DB9A62'), ('jiaozhou', '交州', '#A6B44E'),
]

# 城连接表（M12 → 2026-10-06 用户修正）：删 晋阳-上党、邺-河内；增 河内-上党
# ⚠ 连通关系唯一事实源：mapRoad 铺格、cityLink 表、渲染曲线都从这张表派生
EDGES = [
    ('xiangping', 'beiping'), ('beiping', 'ji'), ('ji', 'nanpi'), ('ji', 'jinyang'),
    ('jinyang', 'ye'), ('jinyang', 'henei'),
    ('shangdang', 'luoyang'), ('shangdang', 'ye'), ('henei', 'shangdang'),
    ('ye', 'nanpi'), ('ye', 'pingyuan'), ('nanpi', 'pingyuan'), ('pingyuan', 'jinan'),
    ('ye', 'puyang'), ('pingyuan', 'puyang'),
    ('jinan', 'beihai'), ('beihai', 'xiapi'), ('nanpi', 'beihai'),
    ('luoyang', 'henei'), ('luoyang', 'chenliu'), ('luoyang', 'wan'), ('luoyang', 'changan'),
    ('puyang', 'chenliu'), ('puyang', 'xiaopei'), ('chenliu', 'xuchang'),
    ('xiapi', 'xiaopei'), ('xiapi', 'guangling'), ('xiaopei', 'qiao'),
    ('guangling', 'jianye'), ('guangling', 'lujiang'),
    ('xuchang', 'runan'), ('xuchang', 'wan'), ('runan', 'qiao'), ('runan', 'xiangyang'),
    ('changan', 'tianshui'), ('changan', 'anding'), ('changan', 'hanzhong'),
    ('tianshui', 'wuwei'), ('tianshui', 'hanzhong'), ('anding', 'wuwei'), ('wuwei', 'xiping'),
    ('xiangyang', 'wan'), ('xiangyang', 'xinye'), ('xiangyang', 'jiangling'), ('xinye', 'wan'),
    ('jiangling', 'jiangxia'), ('jiangling', 'changsha'),
    ('jiangxia', 'chaisang'), ('changsha', 'chaisang'), ('jiangling', 'hanzhong'),
    ('changsha', 'nanhai'), ('jiangxia', 'changsha'), ('jiangxia', 'lujiang'),
    ('jiangling', 'jiangzhou'),
    ('jianye', 'wu'), ('wu', 'kuaiji'), ('jianye', 'lujiang'), ('lujiang', 'chaisang'),
    ('kuaiji', 'nanhai'),
    ('hanzhong', 'zitong'), ('zitong', 'chengdu'), ('chengdu', 'jiangzhou'),
    ('jiangzhou', 'hanzhong'), ('jiangzhou', 'jiaozhi'), ('chengdu', 'hanzhong'),
    ('nanhai', 'jiaozhi'),
]

assert len(CITIES) == 42, len(CITIES)
assert len(EDGES) == 66, len(EDGES)
_n_fac = sum(1 for c in CITIES if c[5])
assert _n_fac == 12, f"副设施应为 12，实际 {_n_fac}"
print(f"城 {len(CITIES)}｜主设施 {len(CITIES)}｜副设施 {_n_fac}｜设施合计 {len(CITIES)+_n_fac}")

# ───────────────────── 1. 布局：节点格占用 ─────────────────────

occ: dict[tuple[int, int], str] = {}   # (x,y) -> 'N'
owner: dict[tuple[int, int], str] = {}
node_list: list[dict] = []             # 按生成顺序，后面按城重排

city_cells: dict[str, list[tuple[int, int]]] = {}
facility_cells: dict[tuple[str, str], list[tuple[int, int]]] = {}


def place(cells, label):
    for c in cells:
        if not (0 <= c[0] < GRID_W and 0 <= c[1] < GRID_H):
            raise SystemExit(f"越界: {label} {c}")
        if c in occ:
            raise SystemExit(f"重叠: {label} {c} 已被 {owner[c]} 占用")
        occ[c] = 'N'
        owner[c] = label


# 先放全部城（2×2），保证城与城不重叠
for tag, name, cx, cy, _p, _s, _st in CITIES:
    cells = [(cx, cy), (cx + 1, cy), (cx, cy + 1), (cx + 1, cy + 1)]
    place(cells, f"city:{name}")
    city_cells[tag] = cells

# 再放设施：北 → 东 → 南 → 西，取第一个空位
DIRS = [((0, -1), (0, 0)), ((2, 0), (1, 0)), ((0, 2), (0, 1)), ((-1, 0), (0, 0)), ((2, 1), (1, 1)), ((-1, 1), (0, 1))]


def free_dir(cx, cy, taken):
    for (dx, dy), _ in DIRS:
        p = (cx + dx, cy + dy)
        if p not in occ and p not in taken:
            return p
    return None


for tag, name, cx, cy, primary, secondary, _st in CITIES:
    taken = set()
    for fac in (primary, secondary):
        if not fac:
            continue
        p = free_dir(cx, cy, taken)
        if p is None:
            raise SystemExit(f"无空位放设施: {name}/{fac}")
        place([p], f"fac:{name}/{fac}")
        facility_cells[(tag, fac)] = [p]
        taken.add(p)

print(f"节点格占用: {len(occ)}（城 42×4 = 168，设施 {len(facility_cells)}）")

# ───────────────────── 2. 路由：BFS 铺道路格 ─────────────────────

grid = {}   # (x,y) -> 'R'


def bfs(start_cells, goal_cells):
    goal = set(goal_cells)
    prev: dict[tuple[int, int], tuple[int, int] | None] = {}
    q = deque()
    for c in start_cells:
        prev[c] = None
        q.append(c)
    while q:
        cur = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = (cur[0] + dx, cur[1] + dy)
            if nb in prev:
                continue
            if not (0 <= nb[0] < GRID_W and 0 <= nb[1] < GRID_H):
                continue
            if nb in goal:
                prev[nb] = cur
                path, x = [], nb
                while x is not None:
                    path.append(x)
                    x = prev[x]
                return path
            if nb in occ:      # 城/设施不可穿越
                continue
            prev[nb] = cur
            q.append(nb)
    return None


route_len = {}
for a, b in EDGES:
    path = bfs(city_cells[a], city_cells[b])
    if path is None:
        raise SystemExit(f"路由失败: {a} → {b}")
    mid = [c for c in path if c not in city_cells[a] and c not in city_cells[b]]
    for c in mid:
        grid[c] = 'R'
    route_len[(a, b)] = len(mid)

print(f"道路格: {len(grid)}｜单边平均 {sum(route_len.values())/len(route_len):.2f} 格")


# ───────────────────── 2.5 冗余平行走廊裁剪（自动检测） ─────────────────────
# 2026-10-06 用户裁定：BFS 铺路时会把部分 link 铺在与既有走廊相邻平行的格上，
# 写实化渲染后呈现为「两根平行连线 / 无意义交叉」。这里在铺路完成后自动检测每条
# 平行双线的「偏移车道」并裁掉（保留主车道为单线），对实际铺出的路网自愈，
# 不依赖写死的格子清单（避免地图坐标变动后清单失效）。裁剪逐格做连通性校验，
# 不会孤立任何城。
def detect_double_lanes(g):
    """返回平行双线中『偏移车道』格集合（与主车道相邻的平行道路格）。"""
    def is_road(x, y):
        return (x, y) in g

    def dir_of(x, y):
        if not is_road(x, y):
            return None
        l = is_road(x - 1, y)
        r = is_road(x + 1, y)
        u = is_road(x, y - 1)
        dd = is_road(x, y + 1)
        if l and r:
            return 'h'
        if u and dd:
            return 'v'
        return None

    offset = set()
    for (x, y) in g:
        dr = dir_of(x, y)
        if dr is None:
            continue
        if dr == 'h':
            for dy in (-1, 1):
                if dir_of(x, y + dy) == 'h':
                    offset.add((x, y + dy))
        else:
            for dx in (-1, 1):
                if dir_of(x + dx, y) == 'v':
                    offset.add((x + dx, y))
    # 只裁偏移侧（另一侧为主车道），避免把整条双线删光
    prune = set()
    for (x, y) in offset:
        dr = dir_of(x, y)
        if dr == 'h':
            if is_road(x, y - 1) and dir_of(x, y - 1) == 'h':
                prune.add((x, y))
        else:
            if is_road(x - 1, y) and dir_of(x - 1, y) == 'v':
                prune.add((x, y))
    return prune


def safe_prune(g, occ, city_cells, candidates):
    """逐格尝试裁剪，保留任何会导致『有城被孤立』的格。"""
    land0 = set(occ) | set(g.keys())
    city_all = [c for cells in city_cells.values() for c in cells]

    def connected(remove):
        land = land0 - remove
        seen = set()
        q = deque()
        for c in city_all:
            if c in land:
                seen.add(c)
                q.append(c)
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nb = (x + dx, y + dy)
                if nb in land and nb not in seen:
                    seen.add(nb)
                    q.append(nb)
        return all(c in seen for c in city_all if c in land)

    safe = set()
    for c in sorted(candidates):
        if connected(safe | {c}):
            safe.add(c)
        else:
            print(f"  ⚠ 保留（裁后孤立城）: {c}")
    return safe


auto = detect_double_lanes(grid)
safe = safe_prune(grid, occ, city_cells, auto)
for c in sorted(safe):
    del grid[c]

# 特例：济南—北海 南侧车道（y=14/y=15 双线，西端贴济南城，自动检测因走向判定漏端点格）
HARD = {(48, 15), (49, 15), (50, 15), (51, 15)}
hard_done = 0
for c in sorted(HARD):
    if c in grid:
        del grid[c]
        hard_done += 1
print(f"走廊裁剪: -{len(safe) + hard_done} 格（自动 {len(safe)} + 特例 {hard_done}）→ 道路格 {len(grid)}")
if safe:
    print("  自动:", sorted(safe))
if hard_done:
    print("  特例:", sorted(c for c in HARD if c in grid) + sorted(c for c in HARD if c not in grid))

# ───────────────────── 3. 连通性验证 ─────────────────────

all_cells = set(occ) | set(grid)
seen = {next(iter(city_cells['ji']))}
q = deque(seen)
while q:
    cur = q.popleft()
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nb = (cur[0] + dx, cur[1] + dy)
        if nb in all_cells and nb not in seen:
            seen.add(nb)
            q.append(nb)

unreached = [n for t, n, *_ in CITIES if not (set(city_cells[t]) & seen)]
print(f"连通性: 覆盖 {len(seen)}/{len(all_cells)} 格；未连通城 {unreached or '无'}")

# 城间最短路抽样（Dijkstra，对拍用）
import heapq


def dijkstra(src_tag):
    src = set(city_cells[src_tag])
    dist = {c: 0 for c in src}
    pq = [(0, c) for c in src]
    heapq.heapify(pq)
    while pq:
        d, cur = heapq.heappop(pq)
        if d > dist.get(cur, 1e9):
            continue
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = (cur[0] + dx, cur[1] + dy)
            if nb not in all_cells:
                continue
            nd = d + 1
            if nd < dist.get(nb, 1e9):
                dist[nb] = nd
                heapq.heappush(pq, (nd, nb))
    return dist


d_ji = dijkstra('ji')
samples = [('ji', 'xiangping', '蓟 → 襄平（最北→最东北）'),
           ('ji', 'nanhai', '蓟 → 南海（最北→最南）'),
           ('wuwei', 'kuaiji', '武威 → 会稽（最西北→最东南）'),
           ('jiaozhi', 'xiangping', '交趾 → 襄平（对角最远）')]
finals = []
for a, b, label in samples:
    v = min(d_ji[c] for c in city_cells[b]) if a == 'ji' else None
    if v is None:
        dd = dijkstra(a)
        v = min(dd[c] for c in city_cells[b])
    finals.append((label, v))
for label, v in finals:
    print(f"  {label}: {v} 格 ≈ {v*20/60:.1f} 分钟")

# 全城两两最短路（用于节奏评估）
all_d = {}
for t, *_ in CITIES:
    all_d[t] = dijkstra(t)
pair = []
tags = [c[0] for c in CITIES]
for i, a in enumerate(tags):
    for b in tags[i + 1:]:
        pair.append(min(all_d[a][c] for c in city_cells[b]))
pair.sort()
n = len(pair)
print(f"城间最短路 {n} 对：均 {sum(pair)/n:.1f} 格（{sum(pair)/n*20/60:.1f} 分）"
      f"｜中位 {pair[n//2]}｜P90 {pair[int(n*0.9)]}｜最大 {pair[-1]}（{pair[-1]*20/60:.1f} 分）")

# ───────────────────── 4. 写出 xlsx ─────────────────────

wb = openpyxl.Workbook()
XL_HEAD = PatternFill('solid', fgColor='FF4472C4')
XL_FONT = Font(color='FFFFFFFF', bold=True)


def new_sheet(title, headers):
    ws = wb.create_sheet(title)
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.fill = XL_HEAD
        c.font = XL_FONT
        c.alignment = Alignment(horizontal='center')
    return ws


# mapNode
ws = new_sheet('mapNode', ['tag', 'name', 'position', 'belong'])
tag = 0
node_rows = []
for t, name, cx, cy, primary, secondary, st in CITIES:
    tag += 1
    node_rows.append((tag, 'city', f"{cx}:{cy};{cx+1}:{cy+1}", t))
    for fac in (primary, secondary):
        if not fac:
            continue
        tag += 1
        (x, y), = facility_cells[(t, fac)]
        node_rows.append((tag, fac, f"{x}:{y}", t))
for r in node_rows:
    ws.append(list(r))
print(f"mapNode: {len(node_rows)} 行")

NODE_TAG = {(bel, nm): tg for tg, nm, _pos, bel in node_rows}
node_cells_map: dict[int, list[tuple[int, int]]] = {}
for tg, nm, _pos, bel in node_rows:
    if nm == 'city':
        node_cells_map[tg] = city_cells[bel]
    else:
        node_cells_map[tg] = facility_cells[(bel, nm)]

# mapRoad（先 Y 后 X）
ws = new_sheet('mapRoad', ['tag', 'name', 'position', 'roadType'])
road_cells = sorted(grid.keys(), key=lambda c: (c[1], c[0]))
for i, (x, y) in enumerate(road_cells, start=1):
    ws.append([i, 'road', f"{x}:{y}", 'plain'])
print(f"mapRoad: {len(road_cells)} 行")

# city（state 列：所属州 → state 表 tag，渲染城块着色用）
ws = new_sheet('city', ['tag', 'name', 'taskType', 'state'])
for t, name, cx, cy, primary, secondary, st in CITIES:
    facs = [f for f in (primary, secondary) if f]
    ws.append([t, name, ';'.join(facs), st])

# state（V3 渲染新增）：州定义 + 城块色。仅地理分组，不进玩法逻辑。
ws = new_sheet('state', ['tag', 'name', 'color'])
for st_t, st_n, st_c in STATES:
    ws.append([st_t, st_n, st_c])
assert len(STATES) == 14, len(STATES)
_st_set = {s[0] for s in STATES}
for c in CITIES:
    assert c[6] in _st_set, f"城 {c[0]} 的州 {c[6]} 不在 state 表"

# task（12 条设施级任务；产出待配方树定稿）
TASKS = [
    ('mining', '采掘', 'mine'), ('herbalism', '采药', 'herb'), ('southernHerb', '采药', 'nanyao'),
    ('hunting', '猎奇', 'hunt'), ('smithing', '锻造', 'smith'), ('alchemy', '丹鼎', 'alchemy'),
    ('crafting', '机巧', 'workshop'), ('taoism', '访道', 'temple'), ('retreat', '访道', 'hut'),
    ('swearing', '结义', 'ground'), ('banquet', '结义', 'tavern'), ('envoy', '出使', 'embassy'),
]
ws = new_sheet('task', ['tag', 'name', 'nodeType', 'nodeName', 'needTime', 'getItem', 'getItemNum', 'getAttrXp', 'getAttrXpNum'])
for tg, nm, nt in TASKS:
    ws.append([tg, nm, nt, FACILITY_NAMES[nt], 60, '', '', '', ''])

# config
ws = new_sheet('config', ['tag', 'content', 'note'])
for tag_, val, note in [
    ('initForce', '2;5', '初始武力'), ('initLeadership', '2;5', '初始统帅'),
    ('initIntelligence', '2;5', '初始智力'), ('initPolitics', '2;5', '初始政治'),
    ('speed', 20, '通过1格需要几秒'), ('backPackSlotNum', 6, '背包中几个格子'),
    ('itemStacking', 5, '单格堆叠上限'), ('initTaskListSlot', 7, '任务板槽位数'),
    ('startCityRand', 'ji;xiangyang', '出生城市候选'),
    ('mapBgImg', '', '地图背景图（public/ 下文件名；留空=程序化占位底图）'),
]:
    ws.append([tag_, val, note])

# attrLv：从输入 V3 沿用（V3 含全部内容，曲线与升级节奏一致）
src_wb = openpyxl.load_workbook(SRC_PATH, data_only=True)
ws = new_sheet('attrLv', ['lv', 'num'])
src = src_wb['attrLv']
for row in src.iter_rows(min_row=2, values_only=True):
    if row[0] is None:
        continue
    ws.append([row[0], row[1]])
print(f"attrLv: {ws.max_row - 1} 行（沿用 V3）")

# $map 示意图
ws = wb.create_sheet('$map')
for (x, y) in sorted(occ.keys(), key=lambda c: (c[1], c[0])):
    ws.cell(row=y + 1, column=x + 1, value=3 if owner[(x, y)].startswith('fac') else 2)
for (x, y) in sorted(road_cells, key=lambda c: (c[1], c[0])):
    ws.cell(row=y + 1, column=x + 1, value=1)

del wb['Sheet']
wb.move_sheet('$map', offset=len(wb.sheetnames) - 1)
wb.properties.title = 'firstShow_V3'


# ───────────────────── 5. V2 路网对拍基准（供 selfcheck.ts 使用） ─────────────────────

def dij_from(cells):
    """与 graph.ts 同口径：城节点内部 4 格 cost 0，跨节点 cost 1。"""
    node_key = {}
    for t, *_ in CITIES:
        for c in city_cells[t]:
            node_key[c] = ('city', t)
    for (t, fac), cl in facility_cells.items():
        for c in cl:
            node_key[c] = ('fac', t, fac)
    for c in grid:
        node_key[c] = ('road', c)

    dist = {c: 0 for c in cells}
    pq = [(0, c) for c in cells]
    heapq.heapify(pq)
    while pq:
        d, cur = heapq.heappop(pq)
        if d > dist.get(cur, 1e9):
            continue
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = (cur[0] + dx, cur[1] + dy)
            if nb not in all_cells:
                continue
            step = 0 if node_key.get(nb) == node_key.get(cur) else 1
            if d + step < dist.get(nb, 1e9):
                dist[nb] = d + step
                heapq.heappush(pq, (d + step, nb))
    return dist


BENCH_PAIRS = [
    (('ji', 'city'), ('ji', 'hunt'), '州府蓟 → 猎场/蓟（同城）'),
    (('ji', 'ground'), ('beiping', 'hunt'), '校场/蓟 → 猎场/北平（相邻城）'),
    (('luoyang', 'city'), ('xiangyang', 'city'), '州府洛阳 → 州府襄阳'),
    (('changan', 'city'), ('jianye', 'city'), '州府长安 → 州府建业（东西向）'),
    (('jiaozhi', 'city'), ('xiangping', 'city'), '州府交趾 → 州府襄平（最远）'),
]

print("\n── V2 路网对拍基准（tag → 格数） ──")
for a, b, label in BENCH_PAIRS:
    ta, tb = NODE_TAG[a], NODE_TAG[b]
    v = min(dij_from(node_cells_map[ta])[c] for c in node_cells_map[tb])
    print(f"  {{ from: {ta}, to: {tb}, expect: {v}, label: '{label}' }},")

# ───────────────────── 6. cityLink 表（连通 + 距离，唯一事实源） ─────────────────────
# dist = 两城城心到城心的 Dijkstra 格距（与运行时 graph.ts 同口径，城内 cost 0）。
# 渲染曲线、后续「时间 = 距离 / 速度」计算直接读此表；npm run check 校验
# 配置 dist 与路网实测一致（防漂移）。
ws = new_sheet('cityLink', ['tagA', 'tagB', 'dist'])
_link_rows = []
for a, b in EDGES:
    d_ab = min(dij_from(node_cells_map[NODE_TAG[(a, 'city')]])[c] for c in node_cells_map[NODE_TAG[(b, 'city')]])
    _link_rows.append([a, b, d_ab])
for r in sorted(_link_rows, key=lambda x: (x[0], x[1])):
    ws.append(r)
print(f"cityLink: {len(_link_rows)} 条（dist=城心 Dijkstra 格距）")

# ───────────────────── 7. 内容表透传（保留 V3 原有内容，避免重生成丢失） ─────────────────────
# skill/item/recipe/blueprint/taskTpl 属游戏内容定义，不在地图几何生成范围内，
# 直接从输入 V3 原样复制到输出（输入即输出），保证重生成后 V3 仍含全部内容。
PASSTHROUGH = ['skill', 'item', 'recipe', 'blueprint', 'taskTpl']
for name in PASSTHROUGH:
    if name not in src_wb.sheetnames:
        print(f"  ⚠ 输入缺表 {name}，跳过")
        continue
    s = src_wb[name]
    headers = [c.value for c in s[1]]
    ws = new_sheet(name, headers)
    for row in s.iter_rows(min_row=2, values_only=True):
        if all(v is None for v in row):
            continue
        ws.append(list(row))
    print(f"{name}: {ws.max_row - 1} 行（透传 V3）")

wb.save(OUT_PATH)
print(f"saved: {OUT_PATH}")
