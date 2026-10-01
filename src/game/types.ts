/** 全部运行时类型定义（配置侧只读 + 存档侧可变） */

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
}

export interface CityDef {
  tag: string; // shangyong …
  name: string; // 上庸
  taskTypes: string[]; // 该城拥有的设施类型
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
  nodes: MapNodeDef[];
  nodeByTag: Record<number, MapNodeDef>;
  roads: MapRoadDef[];
  attrLv: AttrLvRow[];
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
}

export interface LogEntry {
  at: number; // 绝对时间戳 ms
  text: string;
}

export interface GameState {
  /** 存档结构版本，用于迁移/重置 */
  version: number;
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

  stats: GameStats;
  log: LogEntry[];
}
