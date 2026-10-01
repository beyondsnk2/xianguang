import {
  ATTR_KEYS,
  type AttrKey,
  type Cell,
  type GameConfig,
  type GameState,
  type Task,
} from './types';
import { LOG_LIMIT, SAVE_VERSION } from './constants';
import { pickOne, randInt } from './rng';
import { buildTaskIndex, genTask, type TaskIndex } from './taskGen';

/** 出生在州府 2×2 的哪一格：固定取「最左上」一格，避免随机导致存档不一致（D1） */
export function pickSpawnCell(nodeCells: Cell[]): Cell {
  return [...nodeCells].sort((a, b) => (a.y - b.y) || (a.x - b.x))[0];
}

export function createInitialState(cfg: GameConfig, now: number, seed = 0): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    lastTickAt: now,
    startCity: '',
    rngState: (seed || now ^ 0x9e3779b9) | 0,
    cell: { x: 0, y: 0 },
    phase: { kind: 'idle' },
    currentTaskId: null,
    nextTaskId: 1,
    slots: [],
    bag: {},
    storage: {},
    attrs: { force: 0, leadership: 0, intelligent: 0, politics: 0 },
    attrXp: { force: 0, leadership: 0, intelligent: 0, politics: 0 },
    stats: { tasksDone: 0, returnTrips: 0, cellsWalked: 0, itemsGained: {}, startedAt: now },
    log: [],
  };

  // 出生城市：从 startCityRand 里随机一个
  const candidates = cfg.values.startCityRand.filter((t) => cfg.cityByTag[t]);
  const cityTag = pickOne(state, candidates.length ? candidates : cfg.cities.map((c) => c.tag)) ?? cfg.cities[0]?.tag ?? '';
  state.startCity = cityTag;
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

export function findTask(state: GameState, taskId: number | null): Task | null {
  if (taskId === null) return null;
  for (const s of state.slots) {
    if (s.kind === 'task' && s.task.id === taskId) return s.task;
  }
  return null;
}

/** 队首 = 第一个非空槽（空槽只是占位等待补位，不阻塞队列） */
export function headSlotIndex(state: GameState): number {
  return state.slots.findIndex((s) => s.kind === 'task');
}

/** 维持不变量：任务区在前、空槽全部排到队尾（拖拽后调用，保持玩家排序不变） */
export function normalizeSlots(state: GameState): void {
  const tasks = state.slots.filter((s) => s.kind === 'task');
  const empties = state.slots.filter((s) => s.kind === 'empty');
  state.slots = [...tasks, ...empties];
}

export function isLocked(state: GameState, taskId: number): boolean {
  return state.currentTaskId === taskId;
}

export function pushLog(state: GameState, text: string, at = Date.now()): void {
  state.log.unshift({ at, text });
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
}

export function attrProgress(state: GameState, cfg: GameConfig, key: AttrKey): { need: number; cur: number } {
  const need = cfg.attrLvNeed(state.attrs[key]);
  return { need: need ?? 0, cur: state.attrXp[key] };
}

/** 生成一个新任务并放进空槽（供 tick 与 UI 共用） */
export function makeTask(state: GameState, cfg: GameConfig, idx: TaskIndex): Task | null {
  return genTask(state, cfg, idx);
}
