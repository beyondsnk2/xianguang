/**
 * 事件流：取代普通日志成为主界面的信息出口。
 * 每件事带**稀有度**（0 普通 / 1 稀有 / 2 传说）与**类别**，用于分级着色与"惊喜反馈"。
 *
 * 设计要点：
 * - `seq` 单调递增，UI 侧记录已读 seq，只对未读的稀有/传说事件弹 toast，
 *   从而天然避开离线结算期间堆积的事件轰炸（`seenSeq` 在离线结算完成后对齐）。
 * - 事件写进存档（`state.events`），因此事件流不会因刷新丢失；容量由 `EVENT_LIMIT` 封顶。
 */
import { EVENT_LIMIT } from './constants';
import type { GameState } from './types';

/** 0 普通（灰）/ 1 稀有（蓝紫）/ 2 传说（金橙） */
export type EventRarity = 0 | 1 | 2;

export type EventKind =
  | 'task' // 任务完成 / 赶路 / 回城
  | 'meet' // 初识偶遇
  | 'favor' // 关系升阶
  | 'blueprint' // 习得图纸
  | 'mingqi' // 获得名品
  | 'event' // 随机事件（触发 / 处理 / 错过）
  | 'attr' // 四维升级
  | 'skill' // 技能升级
  | 'system'; // 离线结算 / 存档 / 系统

export interface GameEvent {
  seq: number;
  at: number;
  text: string;
  rarity: EventRarity;
  kind: EventKind;
}

/** 发一条事件；超出容量丢弃最旧的 */
export function emitEvent(
  state: GameState,
  text: string,
  rarity: EventRarity = 0,
  kind: EventKind = 'system',
): GameEvent {
  if (!Array.isArray(state.events)) state.events = [];
  if (typeof state.nextEventSeq !== 'number') state.nextEventSeq = 1;
  const ev: GameEvent = { seq: state.nextEventSeq++, at: Date.now(), text, rarity, kind };
  state.events.push(ev);
  if (state.events.length > EVENT_LIMIT) state.events.splice(0, state.events.length - EVENT_LIMIT);
  return ev;
}

/** 取当前最大 seq（用于 UI 对齐"已读"水位，跳过离线期间堆积的事件） */
export function eventWatermark(state: GameState): number {
  return typeof state.nextEventSeq === 'number' ? state.nextEventSeq : 1;
}
