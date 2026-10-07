/**
 * 属性经验入口（V4 R1 后：随机事件是唯一来源）。
 *
 * 设计裁定（F19b / V2-5）：**四维属性只由随机事件积累，任务不发属性经验**
 * （config 的 `getAttrXp` 保持 null），且 **`addAttrXp` 是属性增长的唯一入口**。
 *
 * V2 曾因未实装随机事件而在 `tick.ts::settleTask` 挂了一段「临时桥」（每任务 +2 主属性 / 30% +1 统帅）。
 * 随机事件（60 条 / 双源触发）实装后该桥已删除 —— 否则属性是**双份供给**，四维会虚高。
 * 桥留下的常量里只有 `ATTR_LEAD_CHANCE` 被 `generals.ts::propagateDeed` 复用（判断事迹是否展示统帅），
 * 已改名 `DEED_LEAD_CHANCE` 保留在 constants.ts，不要当桥的残留删掉。
 */
import { emitEvent } from './events';
import { ATTR_NAMES, type AttrKey, type GameConfig, type GameState } from './types';

/** ★ 属性经验的唯一入口：所有来源（随机事件 / 旧配置 getAttrXp 兜底）都必须走这里 */
export function addAttrXp(state: GameState, cfg: GameConfig, key: AttrKey, amount: number): void {
  state.attrXp[key] += amount;
  // 校准用累计（所有来源都经此入口；删临时桥后它就是「事件供给够不够」的度量）
  if (typeof state.stats.attrXpTotal === 'number') state.stats.attrXpTotal += amount;
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
