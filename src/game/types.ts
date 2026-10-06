/** 全部运行时类型定义（配置侧只读 + 存档侧可变） */
import type { GameEvent } from './events';
import type { PendingEvent } from './event';

export interface Cell {
  x: number;
  y: number;
}

export type AttrKey = 'force' | 'leadership' | 'intelligent' | 'politics';

export const ATTR_KEYS: AttrKey[] = ['force', 'leadership', 'intelligent', 'politics'];

export const ATTR_NAMES: Record<AttrKey, string> = {
  force: '武力',
  leadership: '统帅',
  intelligent: '智力',
  politics: '政治',
};

/** 区间随机 [min, max] */
export interface Range {
  min: number;
  max: number;
}

/** 任务类别：A 采集（给量）/ B 制造（给效率）/ C 人物（给关系） */
export type TaskCls = 'A' | 'B' | 'C';

/** 评价四档：拙 / 平 / 佳 / 绝 */
export type EvalTier = 0 | 1 | 2 | 3;

// ────────────────────────────── 配置侧（只读） ──────────────────────────────

export interface TaskDef {
  tag: string; // train / trade / farming / banquet / read / mining
  name: string; // 训练 / 交易 …
  nodeType: string; // barrack / market / farmland / tavern / academy / mine
  nodeName: string; // 兵营 / 街市 …
  needTime: number; // 作业时长（秒）
  getItem: string | null; // grain / mine
  getItemNum: Range | null; // 5;7
  getAttrXp: AttrKey | null; // force …
  getAttrXpNum: Range | null; // 10;20
  cls: string; // 任务类别（A采集/B制造/C人物），供属性→评价映射与临时喂经验使用
  /** V2 新增列：技能 tag（V1 配置为空串） */
  skill: string;
  /** V2 新增列：任务品质 1–9（V1 配置为 0） */
  quality: number;
  /** V2 新增列：属性基准 = int(品质×4)，评价掷骰的分母 */
  attrBaseline: number;
  /** V2 新增列：品级（与 quality 同源） */
  pinjie: number;
  /** V2 新增列：'0.0/0.3/0.6/1.0' → 四档评价增量（拙/平/佳/绝） */
  evalInc: number[];
  /** V2 新增列：主产物（物品 tag；C 类为「好感」） */
  mainOutput: string;
  /** V2 新增列：副产物说明文案 */
  subOutput: string;
}

/** 技能表（skill）：9 技能 × A/B/C 三类 */
export interface SkillDef {
  tag: string; // mining / smithing / visiting …
  name: string; // 采掘 / 锻造 …
  cls: string; // A / B / C
  mainNode: string; // mine / smith / temple …
  nodeName: string; // 矿场 / 铁匠铺 …
  pointCities: string; // 产出城市（备注型，不参与运行时判定）
  note: string;
}

/** 物品表（item）：材料 27 / 稀有 54 / 成品 315 / 名品 3 */
export interface ItemDef {
  tag: string;
  name: string;
  cat: string; // 材料 / 稀有 / 成品 / 名品
  subCat: string; // iron / jingtie …
  tier: number; // 品质阶位（名品行为 NaN）
  tierRaw: string; // 原始值（名品为「名品」）
  qMin: number;
  qMax: number;
  stack: number; // 单格堆叠上限
  source: string; // A类 / B类 / C类独占 / C类上品
  note: string;
}

/** 配方表（recipe）：35 制造族 × 9 品质 = 315 条 */
export interface RecipeDef {
  tag: string;
  name: string;
  skill: string;
  quality: number;
  needItem1: string;
  needItem1Num: number;
  matQualityFloor: number; // 投喂下界（红线④）
  needRare: string; // 稀有料 tag（可空）
  needBlueprint: string; // 图纸 tag（可空）
  resultItem: string;
  resultNum: number;
  /** 中文城市名 → city.tag；反查失败为 null */
  cityCraftTag: string | null;
  cityRareTag: string | null;
  cityBlueprintTag: string | null;
  cityCraft: string;
  cityRare: string;
  cityBlueprint: string;
  note: string;
}

/** 图纸表（blueprint）：只由 C 类产出 */
export interface BlueprintDef {
  tag: string;
  name: string;
  fromSkill: string; // 产出该图纸的 C 类技能
  note: string;
}

export interface CityDef {
  tag: string; // shangyong …
  name: string; // 上庸
  taskTypes: string[]; // 该城拥有的设施类型
  /** 所属州（state 表 tag）。V3 起渲染城块着色用；旧配置无此列时为 null */
  state: string | null;
}

/** 州定义（state 表，V3 起）：仅地理分组 + 城块渲染着色，不进玩法逻辑 */
export interface StateDef {
  tag: string; // youzhou …（带 zhou 后缀，避免与城 tag 冲突）
  name: string; // 幽州
  color: string; // #RRGGBB，城块色
}

export interface MapNodeDef {
  tag: number; // 1–16，数字
  name: string; // city / barrack / market …
  cells: Cell[]; // 1 格或 2×2=4 格
  belong: string | null; // city.tag（英文）
}

export interface MapRoadDef {
  tag: number;
  name: string;
  cell: Cell;
  roadType: string; // plain（预留 mountain / forest / official）
}

/** 城际连通（cityLink 表，V3 起）：连通唯一事实源，dist=城心 Dijkstra 格距（生成器写入） */
export interface CityLinkDef {
  tagA: string;
  tagB: string;
  dist: number;
}

export interface AttrLvRow {
  lv: number;
  num: number; // 本级升到下一级所需经验
}

export interface ConfigValues {
  speed: number; // 秒/格
  backPackSlotNum: number; // 背包格数
  itemStacking: number; // 单格堆叠上限
  initTaskListSlot: number; // 任务板槽位数
  startCityRand: string[]; // 出生城市候选
  initAttr: Record<AttrKey, Range>; // 初始四维区间
}

export interface ConfigMeta {
  file: string;
  setName: string;
  version: number;
  loadedAt: string;
  sheets: string[]; // 生效的表（已去掉 $ 表）
}

export interface GameConfig {
  meta: ConfigMeta;
  tasks: TaskDef[];
  taskByTag: Record<string, TaskDef>;
  cities: CityDef[];
  cityByTag: Record<string, CityDef>;
  /** 中文城市名 → CityDef（recipe 的城市列是中文名，需反查） */
  cityByName: Record<string, CityDef>;
  nodes: MapNodeDef[];
  nodeByTag: Record<number, MapNodeDef>;
  roads: MapRoadDef[];
  /** cityLink 表（V3 起）；V1/V2 无此表时为空数组 */
  links: CityLinkDef[];
  /** state 表（V3 起）；旧配置为空数组 */
  states: StateDef[];
  stateByTag: Record<string, StateDef>;
  /** config.mapBgImg：地图背景图（public/ 下文件名）；空串/null = 程序化占位底图 */
  mapBgImg: string | null;
  attrLv: AttrLvRow[];
  // ── V2 新增表 ──
  skillDefs: SkillDef[];
  skillByTag: Record<string, SkillDef>;
  items: ItemDef[];
  itemByTag: Record<string, ItemDef>;
  recipes: RecipeDef[];
  recipeByTag: Record<string, RecipeDef>;
  /** 成品 tag → 配方（B 类任务靠 mainOutput 反查配方） */
  recipeByResult: Record<string, RecipeDef>;
  blueprints: BlueprintDef[];
  blueprintByTag: Record<string, BlueprintDef>;
  /** C 类技能 tag → 该技能可产出的稀有料 subCat 列表（由 recipe+blueprint 推导） */
  rareSubCatBySkill: Record<string, string[]>;
  /** 该级升到下一级所需经验；超出表长返回 null（已满级） */
  attrLvNeed: (lv: number) => number | null;
  values: ConfigValues;
}

// ────────────────────────────── 存档侧（可变） ──────────────────────────────

export interface Task {
  id: number;
  taskTag: string;
  cityTag: string;
  nodeTag: number;
  needTime: number;
}

export type TaskSlot =
  | { kind: 'empty'; refillIn: number } // 空槽，独立补位倒计时（秒）
  | { kind: 'task'; task: Task };

export type Phase =
  | { kind: 'idle' }
  | { kind: 'moving'; taskId: number; path: Cell[]; total: number; remain: number }
  | { kind: 'working'; taskId: number; total: number; remain: number; label: string }
  | { kind: 'returning'; path: Cell[]; total: number; remain: number };

export interface GameStats {
  tasksDone: number;
  returnTrips: number;
  cellsWalked: number;
  itemsGained: Record<string, number>;
  startedAt: number;
  /** 评价四档计数 [拙, 平, 佳, 绝]（用于数值校准与自检） */
  evalTally: number[];
  /** B 类因缺料未产出成品的次数（缺件自然停，不倒扣） */
  starvedTasks: number;
  /** A/B/C 三类完成计数（按 cls 归并） */
  clsTally: Record<string, number>;
}

export interface LogEntry {
  at: number; // 绝对时间戳 ms
  text: string;
}

/** 抱负（角色成长定向）：决定任务技能偏置；free = 纯随机（旧档默认） */
export type AmbitionKey = 'free' | 'wen' | 'wu' | 'zong' | 'fang';

/** 节奏（品质窗口偏置）：稳/中/搏 */
export type PaceKey = 'steady' | 'mid' | 'bold';

export interface GameState {
  /** 存档结构版本，用于迁移/重置 */
  version: number;
  /** 存档所绑定的配置（`<配置集>_V<版本>`）；配置一换就直接弃档重开，不做兼容迁移 */
  cfgKey: string;
  /** 上次推进到的绝对时间戳（ms），离线结算的依据 */
  lastTickAt: number;
  /** 出生城市（决定存档归属，不随移动改变） */
  startCity: string;
  rngState: number;

  cell: Cell;
  phase: Phase;
  currentTaskId: number | null;

  nextTaskId: number;
  slots: TaskSlot[];

  bag: Record<string, number>;
  storage: Record<string, number>;

  /** 四维属性值（即等级） */
  attrs: Record<AttrKey, number>;
  /** 四维当前经验 */
  attrXp: Record<AttrKey, number>;

  /** 9 技能等级与经验（V2：100 级 / 10 档，只开放品质窗口，不改时长） */
  skills: Record<string, SkillProgress>;
  /** 人物好感累计（V2 尚无 NPC，先做全局累计池） */
  favor: number;
  /** 分武将好感：general.tag → 好感值（事迹传播累积，不衰减） */
  relations: Record<string, number>;
  /** 攻略对象（玩家选定的关系加权目标）；null 表示未选定 */
  target: string | null;
  /** 抱负（角色成长定向）：决定任务技能偏置；free = 纯随机（旧档默认） */
  ambition: AmbitionKey;
  /** 节奏（品质窗口偏置）：稳/中/搏 */
  pace: PaceKey;
  /** 已解锁图纸 tag（一次性解锁，永久有效） */
  blueprints: string[];

  stats: GameStats;
  log: LogEntry[];
  /** 事件流（取代日志展示）：最新在后，容量 EVENT_LIMIT */
  events: GameEvent[];
  /** 事件自增序号；UI 用它对齐"已读"水位，避免离线堆积事件刷屏 */
  nextEventSeq: number;

  // ── 随机事件（内容设计 §七 已定决议） ──
  /** 待处理事件容器（硬上限 EVENT_CONTAINER_CAP，保底 EVENT_KEEP_MIN 条不超时；时限统一 4h） */
  pending: PendingEvent[];
  nextEventId: number;
  /** 时间源累积（秒；满本次 nextEventGap 触发一次机会） */
  eventPoints: number;
  /** 时间源当前目标间隔（秒）；每次触发后于 [EVENT_GAP_MIN, EVENT_GAP_MAX] 随机重摇，期望 600 */
  nextEventGap: number;
  /** 当日已生成事件数（每日上限 EVENT_DAILY_CAP） */
  eventToday: number;
  eventDay: string;
  /** 见闻条目收集（最小形态：只记录，不做图鉴/解锁） */
  jianwen: string[];
  visitedCities: string[];
  visitedFacilities: string[];
  /** 事件 tag → 可再次触发的时间戳（ms） */
  eventCooldown: Record<string, number>;
  /** onceOnly 事件已完成列表 */
  doneEvents: string[];
}

export interface SkillProgress {
  lv: number;
  xp: number;
}
