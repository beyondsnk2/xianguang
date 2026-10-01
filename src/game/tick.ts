import { type AttrKey, type Cell, type GameConfig, type GameState, type TaskSlot } from './types';
import { MAX_TICK_EVENTS, REFILL_SEC } from './constants';
import type { Graph } from './graph';
import { pathToNearestCity, pathToNode } from './graph';
import type { TaskIndex } from './taskGen';
import { genTask } from './taskGen';
import { rollRange } from './rng';
import { bagSlotsUsed, pushLog } from './state';

export interface TickCtx {
  cfg: GameConfig;
  graph: Graph;
  taskIndex: TaskIndex;
}

/**
 * ★ 时间推进：在线与离线共用同一个 tick（开发文档红线 3）。
 * 离散事件推进，不逐秒 tick；位置由 phase.remain 导出，禁止帧累加。
 */
export function tick(state: GameState, dt: number, ctx: TickCtx): void {
  if (!(dt > 0)) return;
  let guard = 0;

  while (dt > 1e-9) {
    if (++guard > MAX_TICK_EVENTS) {
      console.warn('[tick] 单次推进事件数超过上限，已中断');
      break;
    }

    const nextRefill = minRefill(state);
    const phaseRemain = state.phase.kind === 'idle' ? Infinity : state.phase.remain;
    const next = Math.min(nextRefill, phaseRemain);
    if (!Number.isFinite(next)) break; // 队列空且无空槽：无事可做，剩余时间丢弃

    const step = Math.min(dt, next);
    let settled = false;

    if (step > 0) {
      advanceRefill(state, step);
      if (state.phase.kind !== 'idle') {
        state.phase.remain = Math.max(0, state.phase.remain - step);
      }
      dt -= step;
    }

    if (Number.isFinite(nextRefill) && step >= nextRefill - 1e-9) {
      fillReadySlots(state, ctx);
      settled = true;
    }
    if (state.phase.kind !== 'idle' && state.phase.remain <= 1e-9) {
      settlePhase(state, ctx);
      settled = true;
    }
    if (step <= 0 && !settled) break; // 防御：零步长且没有任何事件被结算
  }

  if (state.phase.kind === 'idle') syncPhase(state, ctx);
}

function minRefill(state: GameState): number {
  let min = Infinity;
  for (const s of state.slots) {
    if (s.kind === 'empty' && s.refillIn < min) min = s.refillIn;
  }
  return min;
}

function advanceRefill(state: GameState, dt: number): void {
  for (const s of state.slots) {
    if (s.kind === 'empty') s.refillIn = Math.max(0, s.refillIn - dt);
  }
}

/** 队列不变量：任务区在前、空槽恒排队尾（任务完成即出列，新任务补到任务区末尾） */
function taskBoundary(slots: TaskSlot[]): number {
  const i = slots.findIndex((s) => s.kind === 'empty');
  return i < 0 ? slots.length : i;
}

/** 到点的空槽各自独立补一个新任务，补出的任务插在任务区末尾 */
function fillReadySlots(state: GameState, ctx: TickCtx): void {
  let changed = false;
  for (;;) {
    const idx = state.slots.findIndex((s) => s.kind === 'empty' && s.refillIn <= 1e-9);
    if (idx < 0) break;
    const task = genTask(state, ctx.cfg, ctx.taskIndex);
    if (!task) {
      const s = state.slots[idx];
      if (s.kind === 'empty') s.refillIn = 30; // 异常兜底：稍后重试
      break;
    }
    state.slots.splice(idx, 1);
    state.slots.splice(taskBoundary(state.slots), 0, { kind: 'task', task });
    changed = true;
  }
  if (changed) syncPhase(state, ctx);
}

/** 结算完成的槽位出列，空槽（180 秒补位计时）落到队尾 */
function retireSlot(state: GameState, slotIdx: number): void {
  state.slots.splice(slotIdx, 1);
  state.slots.push({ kind: 'empty', refillIn: REFILL_SEC });
}

/** 角色空闲时，立刻接取队首任务并开始移动 */
export function syncPhase(state: GameState, ctx: TickCtx): void {
  if (state.phase.kind !== 'idle') return;
  const idx = state.slots.findIndex((s) => s.kind === 'task');
  if (idx < 0) {
    state.currentTaskId = null;
    return;
  }
  const slot = state.slots[idx];
  if (slot.kind !== 'task') return;
  const path = pathToNode(ctx.graph, state.cell, slot.task.nodeTag);
  if (!path) {
    // 不可达（配置异常）：该任务出列，空槽落到队尾重新补位
    retireSlot(state, idx);
    return;
  }
  state.currentTaskId = slot.task.id;
  const total = path.cost * ctx.cfg.values.speed;
  state.phase = { kind: 'moving', taskId: slot.task.id, path: path.cells, total, remain: total };
}

function settlePhase(state: GameState, ctx: TickCtx): void {
  const phase = state.phase;
  switch (phase.kind) {
    case 'idle':
      break;

    case 'moving': {
      const last = phase.path[phase.path.length - 1];
      if (last) state.cell = { ...last };
      state.stats.cellsWalked += Math.max(0, phase.path.length - 1);
      const task = state.slots.find((s) => s.kind === 'task' && s.task.id === phase.taskId);
      const needTime = task && task.kind === 'task' ? task.task.needTime : 60;
      const def = task && task.kind === 'task' ? ctx.cfg.taskByTag[task.task.taskTag] : null;
      state.phase = {
        kind: 'working',
        taskId: phase.taskId,
        total: needTime,
        remain: needTime,
        label: def?.name ?? '作业',
      };
      break;
    }

    case 'working':
      settleTask(state, ctx, phase.taskId);
      break;

    case 'returning': {
      const last = phase.path[phase.path.length - 1];
      if (last) state.cell = { ...last };
      depositAll(state);
      state.phase = { kind: 'idle' };
      syncPhase(state, ctx);
      break;
    }
  }
}

/** 结算一个任务：发道具 + 属性经验 → 释放槽（进入 180 s 补位）→ 超容则自动回城 */
function settleTask(state: GameState, ctx: TickCtx, taskId: number): void {
  const slotIdx = state.slots.findIndex((s) => s.kind === 'task' && s.task.id === taskId);
  if (slotIdx < 0) {
    state.currentTaskId = null;
    state.phase = { kind: 'idle' };
    syncPhase(state, ctx);
    return;
  }
  const slot = state.slots[slotIdx];
  if (slot.kind !== 'task') return;
  const task = slot.task;
  const def = ctx.cfg.taskByTag[task.taskTag];

  if (def) {
    // 产出必定完整入包，不截断、不丢弃（红线 6）
    if (def.getItem && def.getItemNum) {
      const n = rollRange(state, def.getItemNum);
      state.bag[def.getItem] = (state.bag[def.getItem] ?? 0) + n;
      state.stats.itemsGained[def.getItem] = (state.stats.itemsGained[def.getItem] ?? 0) + n;
    }
    if (def.getAttrXp && def.getAttrXpNum) {
      addAttrXp(state, ctx.cfg, def.getAttrXp, rollRange(state, def.getAttrXpNum));
    }
    const cityName = ctx.cfg.cityByTag[task.cityTag]?.name ?? task.cityTag;
    pushLog(state, `${cityName}·${def.nodeName} ${def.name}完成`);
  }

  state.stats.tasksDone += 1;
  retireSlot(state, slotIdx); // 后续任务整体上移，空槽生成在队尾
  state.currentTaskId = null;
  state.phase = { kind: 'idle' };

  // 超容 → 自动插入「回最近州府 → 全部入仓 → 清空背包」，全程无需点击
  if (bagSlotsUsed(state, ctx.cfg) > ctx.cfg.values.backPackSlotNum) {
    const near = pathToNearestCity(ctx.graph, state.cell);
    if (near) {
      const total = near.path.cost * ctx.cfg.values.speed;
      state.phase = { kind: 'returning', path: near.path.cells, total, remain: total };
      pushLog(state, '背包已满，返回州府存仓');
      return;
    }
  }
  syncPhase(state, ctx);
}

function depositAll(state: GameState): void {
  let n = 0;
  for (const k of Object.keys(state.bag)) {
    const v = state.bag[k] ?? 0;
    if (!v) continue;
    state.storage[k] = (state.storage[k] ?? 0) + v; // 仓库全局共享
    n += v;
    delete state.bag[k];
  }
  state.stats.returnTrips += 1;
  pushLog(state, `存入仓库 ${n} 件，背包已清空`);
}

export function addAttrXp(state: GameState, cfg: GameConfig, key: AttrKey, amount: number): void {
  state.attrXp[key] += amount;
  let guard = 0;
  while (guard++ < 1000) {
    const lv = state.attrs[key];
    const need = cfg.attrLvNeed(lv);
    if (need === null || need === undefined) break; // 已满级
    if (state.attrXp[key] >= need) {
      state.attrXp[key] -= need;
      state.attrs[key] = lv + 1;
    } else break;
  }
}

/** 当前所在格（渲染用）：由 phase 推导，绝不用帧累加 */
export function currentCell(state: GameState): Cell {
  if (state.phase.kind === 'moving' || state.phase.kind === 'returning') {
    const p = state.phase.path;
    const total = Math.max(1e-9, state.phase.total);
    const progress = Math.min(1, Math.max(0, 1 - state.phase.remain / total));
    return pointOnPath(p, progress) ?? state.cell;
  }
  return state.cell;
}

/** 沿格子序列插值（零成本的内部移动也按等分铺开，保证视觉不跳变） */
export function pointOnPath(path: Cell[], progress: number): Cell | null {
  if (!path.length) return null;
  if (path.length === 1) return path[0];
  const seg = Math.min(path.length - 1, Math.max(0, Math.floor(progress * (path.length - 1))));
  const t = progress * (path.length - 1) - seg;
  const a = path[seg];
  const b = path[Math.min(path.length - 1, seg + 1)];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
