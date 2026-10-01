import type { GameState } from './types';

/** mulberry32：种子存在存档里，保证离线结算可复现 */
export function randFloat(state: GameState): number {
  state.rngState = (state.rngState + 0x6d2b79f5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [min, max] 闭区间整数 */
export function randInt(state: GameState, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(randFloat(state) * (max - min + 1));
}

export function pickOne<T>(state: GameState, arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(randFloat(state) * arr.length) % arr.length];
}

export function rollRange(state: GameState, r: { min: number; max: number } | null): number {
  if (!r) return 0;
  return randInt(state, r.min, r.max);
}
