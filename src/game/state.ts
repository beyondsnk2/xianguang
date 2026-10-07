import {
  ATTR_KEYS,
  type Cell,
  type GameConfig,
  type GameState,
} from './types';
import { EVENT_POINT_SEC, LOG_LIMIT, SAVE_VERSION } from './constants';
import { ensureSkills, SKILL_INIT_LV } from './skill';
import { pickOne, randInt } from './rng';
import { buildTaskIndex, genTask } from './taskGen';
import { ensureRelations, GENERALS } from './generals';
import { emitEvent } from './events';
import { ensureEventFields } from './event';

/** 出生在州府 2×2 的哪一格：固定取「最左上」一格，避免随机导致存档不一致（D1） */
export function pickSpawnCell(nodeCells: Cell[]): Cell {
  return [...nodeCells].sort((a, b) => (a.y - b.y) || (a.x - b.x))[0];
}

export function createInitialState(cfg: GameConfig, now: number, seed = 0): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    cfgKey: `${cfg.meta.setName}_V${cfg.meta.version}`,
    lastTickAt: now,
    simNow: now,
    startCity: '',
    rngState: (seed || now ^ 0x9e3779b9) | 0,
    cell: { x: 0, y: 0 },
    phase: { kind: 'idle' },
    currentTaskId: null,
    nextTaskId: 1,
    slots: [],
    bag: {},
    storage: {},
    money: cfg.values.initMoney,
    attrs: { force: 0, leadership: 0, intelligent: 0, politics: 0 },
    attrXp: { force: 0, leadership: 0, intelligent: 0, politics: 0 },
    skills: {},
    favor: 0,
    relations: Object.fromEntries(GENERALS.map((g) => [g.tag, 0])),
    target: null,
    ambition: 'free',
    pace: 'mid',
    blueprints: [],
    events: [],
    nextEventSeq: 1,
    pending: [],
    nextEventId: 1,
    eventPoints: 0,
    nextEventGap: EVENT_POINT_SEC, // 时间源初始间隔（之后每次触发在 5~15 分钟间随机重摇）
    eventToday: 0,
    eventDay: '',
    jianwen: [],
    visitedCities: [],
    visitedFacilities: [],
    eventCooldown: {},
    doneEvents: [],
    stats: {
      tasksDone: 0,
      returnTrips: 0,
      cellsWalked: 0,
      itemsGained: {},
      startedAt: now,
      evalTally: [0, 0, 0, 0],
      starvedTasks: 0,
      starvedMat: 0,
      starvedRare: 0,
      starvedBySubCat: {},
      raresProduced: {},
      demandBySubCat: {},
      clsTally: {},
      eventsSettled: 0,
      attrXpTotal: 0,
      moneyEarned: 0,
      moneyEarnedWage: 0,
      moneyEarnedBounty: 0,
      moneySpent: 0,
      restockCount: 0,
    },
    log: [],
  };

  // 9 技能初始化：1 级 0 经验（tier 1 → 品质窗口 1–3）
  for (const s of cfg.skillDefs) {
    if (s.tag) state.skills[s.tag] = { lv: SKILL_INIT_LV, xp: 0 };
  }

  // 出生城市：从 startCityRand 里随机一个
  const candidates = cfg.values.startCityRand.filter((t) => cfg.cityByTag[t]);
  const cityTag = pickOne(state, candidates.length ? candidates : cfg.cities.map((c) => c.tag)) ?? cfg.cities[0]?.tag ?? '';
  state.startCity = cityTag;
  state.visitedCities.push(cityTag); // 出生地视为已造访，不再触发"到达新城市"
  const cityNode = cfg.nodes.find((n) => n.belong === cityTag && n.name === 'city');
  if (cityNode) state.cell = pickSpawnCell(cityNode.cells);

  // 四维初始 2–5 随机
  for (const key of ATTR_KEYS) {
    const r = cfg.values.initAttr[key];
    state.attrs[key] = randInt(state, r.min, r.max);
    state.attrXp[key] = 0;
  }

  // 开局任务板给满，否则第一个任务要干等 3 分钟
  const idx = buildTaskIndex(cfg);
  for (let i = 0; i < cfg.values.initTaskListSlot; i++) {
    const task = genTask(state, cfg, idx);
    state.slots.push(task ? { kind: 'task', task } : { kind: 'empty', refillIn: 0 });
  }
  return state;
}

/**
 * 读档兜底：补齐 V2 新增的运行时字段。
 * 设计口径是「配置一换就弃档」，这里只对**同版本号但字段缺失**的存档做最小补偿，避免读到半截结构当场崩。
 */
export function ensureRuntimeFields(state: GameState, cfg: GameConfig): void {
  ensureSkills(state, cfg);
  if (!Array.isArray(state.blueprints)) state.blueprints = [];
  if (typeof state.favor !== 'number' || !Number.isFinite(state.favor)) state.favor = 0;
  ensureRelations(state);
  if (state.ambition !== 'free' && state.ambition !== 'wen' && state.ambition !== 'wu' && state.ambition !== 'zong' && state.ambition !== 'fang') {
    state.ambition = 'free';
  }
  if (state.pace !== 'steady' && state.pace !== 'mid' && state.pace !== 'bold') {
    state.pace = 'mid';
  }
  if (!state.stats) state.stats = { tasksDone: 0, returnTrips: 0, cellsWalked: 0, itemsGained: {}, startedAt: Date.now() } as GameState['stats'];
  if (!Array.isArray(state.stats.evalTally) || state.stats.evalTally.length !== 4) state.stats.evalTally = [0, 0, 0, 0];
  if (typeof state.stats.starvedTasks !== 'number') state.stats.starvedTasks = 0;
  if (typeof state.stats.starvedMat !== 'number') state.stats.starvedMat = 0;
  if (typeof state.stats.starvedRare !== 'number') state.stats.starvedRare = 0;
  if (!state.stats.starvedBySubCat || typeof state.stats.starvedBySubCat !== 'object') state.stats.starvedBySubCat = {};
  if (!state.stats.raresProduced || typeof state.stats.raresProduced !== 'object') state.stats.raresProduced = {};
  if (!state.stats.demandBySubCat || typeof state.stats.demandBySubCat !== 'object') state.stats.demandBySubCat = {};
  if (!state.stats.clsTally || typeof state.stats.clsTally !== 'object') state.stats.clsTally = {};
  if (typeof state.stats.eventsSettled !== 'number') state.stats.eventsSettled = 0;
  if (typeof state.stats.attrXpTotal !== 'number') state.stats.attrXpTotal = 0;
  // V4 金钱：同版本号但字段缺失的存档 → 补初始金钱与三个统计（金钱永不为负）
  if (typeof state.money !== 'number' || !Number.isFinite(state.money) || state.money < 0) {
    state.money = cfg.values.initMoney;
  }
  if (typeof state.stats.moneyEarned !== 'number') state.stats.moneyEarned = 0;
  if (typeof state.stats.moneyEarnedWage !== 'number') state.stats.moneyEarnedWage = 0;
  if (typeof state.stats.moneyEarnedBounty !== 'number') state.stats.moneyEarnedBounty = 0;
  if (typeof state.stats.moneySpent !== 'number') state.stats.moneySpent = 0;
  if (typeof state.stats.restockCount !== 'number') state.stats.restockCount = 0;
  if (typeof state.simNow !== 'number') state.simNow = state.lastTickAt ?? Date.now();
  if (!Array.isArray(state.events)) state.events = [];
  if (typeof state.nextEventSeq !== 'number') state.nextEventSeq = state.events.length + 1;
  ensureEventFields(state);
}

/** 背包占用格数 = Σ ceil(数量 / 堆叠上限)（D4：按格数计，与 backPackSlotNum 字面一致） */
export function bagSlotsUsed(state: GameState, cfg: GameConfig): number {
  const stack = Math.max(1, cfg.values.itemStacking);
  let used = 0;
  for (const k of Object.keys(state.bag)) {
    used += Math.ceil((state.bag[k] ?? 0) / stack);
  }
  return used;
}

export function bagItemCount(state: GameState): number {
  return Object.values(state.bag).reduce((a, b) => a + b, 0);
}

export function storageItemCount(state: GameState): number {
  return Object.values(state.storage).reduce((a, b) => a + b, 0);
}

export function bagCapacity(cfg: GameConfig): number {
  return cfg.values.backPackSlotNum * cfg.values.itemStacking;
}

/** 维持不变量：任务区在前、空槽全部排到队尾（拖拽后调用，保持玩家排序不变） */
export function normalizeSlots(state: GameState): void {
  const tasks = state.slots.filter((s) => s.kind === 'task');
  const empties = state.slots.filter((s) => s.kind === 'empty');
  state.slots = [...tasks, ...empties];
}

export function pushLog(state: GameState, text: string, at = Date.now()): void {
  state.log.unshift({ at, text });
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
  // 事件流是主界面的信息出口：普通日志一律以「普通」稀有度进流
  emitEvent(state, text, 0, 'system');
}
