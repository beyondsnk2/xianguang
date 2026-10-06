/**
 * 产出与消耗的统一入口。
 * 产出永远全额入包（红线 6：不截断、不丢弃），超容由 tick 里的「自动回城存仓」兜住。
 * B 类耗材从「背包 + 仓库」合计中扣除（先背包后仓库），保证离线期间的存货也能被制造消耗。
 */
import type { GameState } from './types';

export function addItem(state: GameState, tag: string, n: number): void {
  if (!tag || !(n > 0)) return;
  state.bag[tag] = (state.bag[tag] ?? 0) + n;
  state.stats.itemsGained[tag] = (state.stats.itemsGained[tag] ?? 0) + n;
}

/** 背包 + 仓库合计持有量 */
export function ownedCount(state: GameState, tag: string): number {
  return (state.bag[tag] ?? 0) + (state.storage[tag] ?? 0);
}

/** 足额扣除（先背包后仓库），不足返回 false 且不扣任何东西 */
export function consumeItem(state: GameState, tag: string, n: number): boolean {
  if (!(n > 0)) return true;
  if (ownedCount(state, tag) < n) return false;
  let left = n;
  for (const pool of [state.bag, state.storage]) {
    const have = pool[tag] ?? 0;
    if (!have) continue;
    const take = Math.min(have, left);
    const rest = have - take;
    if (rest > 0) pool[tag] = rest;
    else delete pool[tag];
    left -= take;
    if (left <= 0) break;
  }
  return true;
}
