/**
 * T7：属性来源的正式收敛。
 *
 * 设计裁定（F19b / V2-5）：**四维属性只由随机事件积累，任务不再发属性经验**
 * （config 的 `getAttrXp` 保持 null），且 **`addAttrXp` 是属性增长的唯一入口**。
 *
 * V2 不实装随机事件（F31 后置），因此在随机事件接管之前，本文件提供**唯一的过渡供给源**：
 * 任务结算按 cls → 主属性定量供给（A←武力 / B←智力 / C←政治），统帅按概率小量供给
 * （统帅是全局节拍器、不进评价体系，故独立掷骰）。
 *
 * 接入随机事件时的替换方式：删掉 `settleTask` 里对 `gainTaskAttrXp` 的调用即可；
 * 随机事件侧仍然调用同一个 `addAttrXp` 入口，本文件的过渡段随之下线。
 */
import { ATTR_LEAD_CHANCE, ATTR_LEAD_XP, ATTR_XP_PER_TASK, CLS_TO_ATTR } from './constants';
import { randFloat } from './rng';
import { emitEvent } from './events';
import { ATTR_NAMES, type AttrKey, type GameConfig, type GameState, type TaskDef } from './types';

/** ★ 属性经验的唯一入口：所有来源（随机事件 / 过渡供给）都必须走这里 */
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
      emitEvent(state, `${ATTR_NAMES[key]} 提升至 Lv ${lv + 1}`, 1, 'attr');
    } else break;
  }
}

/**
 * 过渡供给：任务完成时按类别喂主属性 + 概率喂统帅。
 * ⚠ 这是「临时桥」的归位版本——接 F19b 随机事件后整段删除，
 * 届时属性只由随机事件经 `addAttrXp` 灌入。
 * @returns 本次实际发放的属性经验（key→数量），供录制/统计使用
 */
export function gainTaskAttrXp(state: GameState, cfg: GameConfig, def: TaskDef): Partial<Record<AttrKey, number>> {
  const gained: Partial<Record<AttrKey, number>> = {};
  const main = CLS_TO_ATTR[def.cls];
  if (main) {
    addAttrXp(state, cfg, main, ATTR_XP_PER_TASK);
    gained[main] = (gained[main] ?? 0) + ATTR_XP_PER_TASK;
  }
  if (randFloat(state) < ATTR_LEAD_CHANCE) {
    addAttrXp(state, cfg, 'leadership', ATTR_LEAD_XP);
    gained.leadership = (gained.leadership ?? 0) + ATTR_LEAD_XP;
  }
  return gained;
}
