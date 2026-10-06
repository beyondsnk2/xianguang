export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} 小时 ${m} 分`;
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
