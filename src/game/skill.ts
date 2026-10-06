/**
 * 技能等级（100 级 / 10 档）与品质滑动窗口。
 * 设计定案：经验只由对应技能的任务积累；**不动 needTime**，只改变可刷出的品质范围与权重。
 */
import {
  QUALITY_WEIGHT_HIGH,
  QUALITY_WEIGHT_LOW,
  QUALITY_WINDOW_SIZE,
  QUALITY_WINDOW_TOP_TIER,
  SKILL_MAX_LV,
  SKILL_TIER_SIZE,
} from './constants';
import { emitEvent } from './events';
import type { GameConfig, GameState } from './types';

/** 初始技能等级（1 级起，tier 1） */
export const SKILL_INIT_LV = 1;

/** 当前技能等级 → 档位 1..10 */
export function skillTier(lv: number): number {
  const raw = Math.ceil(Math.max(1, lv) / SKILL_TIER_SIZE);
  return Math.min(10, Math.max(1, raw));
}

/**
 * 档位 → 开放品质区间（含端点，宽恒 3）。
 * 下沿 = min(档位, 7)：8 档及以上触顶 7–9，只提权重不再上移。
 */
export function qualityWindow(tier: number): { min: number; max: number } {
  const lo = Math.min(tier, QUALITY_WINDOW_TOP_TIER);
  return { min: lo, max: lo + QUALITY_WINDOW_SIZE - 1 };
}

/**
 * 窗口内三档权重（按品质升序）：低档偏低下沿、高档偏高上沿，中间线性插值。
 * tier 1 → [50,35,15]；tier ≥ 8 → [20,30,50]。
 */
export function qualityWeights(tier: number): number[] {
  const t = Math.min(1, Math.max(0, (tier - 1) / (QUALITY_WINDOW_TOP_TIER - 1)));
  return QUALITY_WEIGHT_LOW.map((lo, i) => lo + (QUALITY_WEIGHT_HIGH[i] - lo) * t);
}

/** 给技能加经验，走 attrLv 同一条升级曲线（config.attrLvNeed） */
export function addSkillXp(state: GameState, cfg: GameConfig, skillTag: string, amount: number): void {
  if (!skillTag || !(amount > 0)) return;
  const cur = state.skills[skillTag];
  if (!cur) return; // 配置里没有该技能（V1 配置）：静默跳过
  cur.xp += amount;
  let guard = 0;
  while (guard++ < 2000) {
    if (cur.lv >= SKILL_MAX_LV) {
      cur.xp = 0;
      break;
    }
    const need = cfg.attrLvNeed(cur.lv);
    if (need === null || need === undefined) break; // 曲线表到底，停在当前级
    if (cur.xp < need) break;
    cur.xp -= need;
    cur.lv += 1;
    const nm = cfg.skillByTag[skillTag]?.name ?? skillTag;
    emitEvent(state, `${nm} 精进至 Lv ${cur.lv}`, 1, 'skill');
  }
}

/** 读存档时的兜底：按配置补齐 9 个技能槽，缺失的按 1 级 0 经验初始化 */
export function ensureSkills(state: GameState, cfg: GameConfig): void {
  if (!state.skills || typeof state.skills !== 'object') {
    state.skills = {} as GameState['skills'];
  }
  for (const s of cfg.skillDefs) {
    if (!state.skills[s.tag]) state.skills[s.tag] = { lv: SKILL_INIT_LV, xp: 0 };
  }
}
