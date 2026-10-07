import { type Cell, type GameConfig, type GameState, type TaskSlot } from './types';
import {
  CLS_TO_ATTR,
  EVENT_TRIGGER_QUALITY,
  MAX_TICK_EVENTS,
  REFILL_SEC,
  SKILL_XP_PER_QUALITY,
  WAGE_RATIO,
} from './constants';
import type { Graph } from './graph';
import { pathToNearestCity, pathToNode } from './graph';
import type { TaskIndex } from './taskGen';
import { genTask } from './taskGen';
import { rollRange } from './rng';
import { passEval, rollEval } from './eval';
import { settleOutput } from './produce';
import { addSkillXp } from './skill';
import { propagateDeed, maybeFirstMeet } from './generals';
import { advanceEventClock, expireEvents, tryTriggerEvent } from './event';
import type { TaskRecorder } from './taskLog';

import { addAttrXp } from './attrGain';
import { bagSlotsUsed, pushLog } from './state';
import { tierPrice } from './economy';

export interface TickCtx {
  cfg: GameConfig;
  graph: Graph;
  taskIndex: TaskIndex;
  /** 可选：任务明细录制器（统计用，不入存档；不传即完全旁路） */
  recorder?: TaskRecorder;
  /** 是否在线推进。**随机事件只在线生成与计时**（离线冻结），离线结算必须传 false */
  online?: boolean;
}

/**
 * ★ 时间推进：在线与离线共用同一个 tick（开发文档红线 3）。
 * 离散事件推进，不逐秒 tick；位置由 phase.remain 导出，禁止帧累加。
 */
export function tick(state: GameState, dt: number, ctx: TickCtx): void {
  if (!(dt > 0)) return;
  // 模拟时钟随 dt 推进（事件计时改用 simNow，避免快速校准 sim 里 Date.now() 不随模拟时间走导致上限失真）
  state.simNow += dt * 1000;
  // ── 随机事件：时间源仅「赶路」阶段累积 + 过期只在线发生（离线冻结） ──
  if (ctx.online) {
    // 时间源事件点只在赶路(moving)时累积；working / 回城 / 空闲阶段不累积（行为源不受影响）
    if (state.phase.kind === 'moving') advanceEventClock(state, ctx.cfg, dt);
    expireEvents(state);
  }
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
      const slot = state.slots.find((s) => s.kind === 'task' && s.task.id === phase.taskId);
      const task = slot && slot.kind === 'task' ? slot.task : null;
      const needTime = task ? task.needTime : 60;
      const def = task ? ctx.cfg.taskByTag[task.taskTag] : null;
      ctx.recorder?.noteTravel(phase.taskId, phase.total); // 赶路耗时（秒）= 路程格数 × speed

      // ── 随机事件·行为源①：到达新城市（内容设计 Q-C4：包含） ──
      if (task) {
        const node = ctx.cfg.nodeByTag[task.nodeTag];
        const cityTag = node?.belong ?? task.cityTag;
        if (cityTag && !state.visitedCities.includes(cityTag)) {
          state.visitedCities.push(cityTag);
          tryTriggerEvent(state, { cfg: ctx.cfg, cityTag, facility: def?.nodeType });
        }
      }

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
    // ── T4：评价掷骰（r = 主力属性 / attrBaseline），属性只移概率，保底 1× 不倒扣 ──
    const attrKey = CLS_TO_ATTR[def.cls];
    const evalRes =
      def.attrBaseline > 0 && attrKey
        ? rollEval(state, state.attrs[attrKey], def.attrBaseline, def.evalInc)
        : passEval();
    state.stats.evalTally[evalRes.tier] += 1;
    state.stats.clsTally[def.cls] = (state.stats.clsTally[def.cls] ?? 0) + 1;

    // ── T2：技能经验（只升区间，不动 needTime） ──
    const skillXp = def.skill ? SKILL_XP_PER_QUALITY * Math.max(1, def.quality) : 0;
    if (def.skill) addSkillXp(state, ctx.cfg, def.skill, skillXp);

    // ── T5：三类收益分化（完整入包，不截断、不丢弃） ──
    const rewards = settleOutput(state, ctx.cfg, def, evalRes, task);

    // config 的 getAttrXp 保持 null（设计口径：任务不发属性经验，四维只由随机事件积累），
    // 此处仅供旧配置兜底
    if (def.getAttrXp && def.getAttrXpNum) {
      addAttrXp(state, ctx.cfg, def.getAttrXp, rollRange(state, def.getAttrXpNum));
    }

    // ── F28：事迹传播——完成任务的展示属性一对多涨相关武将好感 ──
    propagateDeed(state, def);
    // ── C 类「初识事件」：随机偶遇一位素未谋面的武将，正式建立关系 ──
    if (def.cls === 'C') maybeFirstMeet(state);

    // ── 随机事件·行为源②③：首次造访设施 / 完成高品质任务 ──
    if (def.nodeType && !state.visitedFacilities.includes(def.nodeType)) {
      state.visitedFacilities.push(def.nodeType);
      tryTriggerEvent(state, { cfg: ctx.cfg, cityTag: task.cityTag, facility: def.nodeType });
    }
    if (def.quality >= EVENT_TRIGGER_QUALITY) {
      tryTriggerEvent(state, { cfg: ctx.cfg, cityTag: task.cityTag, facility: def.nodeType });
    }

    ctx.recorder?.record(
      {
        taskTag: def.tag,
        taskName: def.name,
        cls: def.cls,
        quality: def.quality,
        workSec: task.needTime,
        evalName: evalRes.name,
        evalTier: evalRes.tier,
        evalMult: evalRes.mult,
        rewards,
        skill: def.skill,
        skillXp,
      },
      task.id,
    );

    const cityName = ctx.cfg.cityByTag[task.cityTag]?.name ?? task.cityTag;
    // ── E0a：任务工钱（与物品奖励同一次结算、写进同一条事件流；不新增 UI）──
    // 口径：统一按 price[材料|tier]，与 A/B/C 类别无关（工钱是跑腿费只认品质）。
    const wage = Math.round(tierPrice(ctx.cfg, def.quality) * WAGE_RATIO);
    if (wage > 0) {
      state.money += wage;
      state.stats.moneyEarned += wage;
      state.stats.moneyEarnedWage += wage;
    }
    pushLog(state, `${cityName}·${def.nodeName} ${def.name}完成（${evalRes.name}）· 工钱+${wage}文`);
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
