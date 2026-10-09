export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

/**
 * UI 数值统一取整显示（默认规则：UI 上没有特别要求，一律显示整数）。
 *
 * 用 **floor 而非 round**：避免"显示值已经达标、实际却没达到门槛"的误导。
 *   - 好感 19.6 → floor 显示 19：与阶段名（尚未到「相识」20）自洽；round 会显示 20 却仍是上一阶段。
 *   - 与既有 `金钱 Math.floor(state.money)`、`还需 X Math.ceil(...)` 的取舍同源：已获得的往少取、
 *     尚缺的往多取，永远不让玩家高估自己的进度。
 *
 * 注意：这只是**显示层**取整，不改存档真值——
 * 武将好感底层仍是浮点（propagateDeed 累加 +1.2/+0.5），门槛判定用原始值。
 */
export function fmtInt(v: number): string {
  const n = Math.floor(v);
  return String(Number.isFinite(n) ? n : 0);
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

import type { GameConfig } from '../game/types';

const ITEM_NAMES: Record<string, string> = { grain: '粮', mine: '矿' };

/**
 * 物品显示名：优先取配置表里的中文名（`cfg.itemByTag`），
 * 再回退到内置小表，最后才回显 tag。传 cfg 才能显示 V2 的 27材料/54稀有/315成品/3名品真名。
 */
export function itemName(tag: string, cfg?: GameConfig): string {
  if (cfg) {
    const def = cfg.itemByTag[tag];
    if (def?.name) return def.name;
  }
  return ITEM_NAMES[tag] ?? tag;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
