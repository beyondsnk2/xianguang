/**
 * 职业 / 身份系统（V6 起）核心助手。
 *
 * 设计要点（用户定）：
 *  - 职业（class）= 统一成长定向路由层，取代旧 ambition；身份（standing）= 职业组合解锁的稀有目标 + 上阵槽。
 *  - 总开关：Σ 技能等级 > cfg.values.classUnlockSkillLvTotal 才解锁职业路由（否则回退 ambition）。
 *  - 职业经验（classExp）独立 per-职业，只由「生效职业的亲密度技能」任务积累（不同轴、粗颗粒、非平滑）。
 *  - 晋身条件四型（a_rep / b_general / c_standing / d_train）覆盖全部职业 → 满足「四型组合」语义。
 *  - 身份不可降级（standingActive 仅增）；上阵槽数 = base + floor(Σ职业总阶 / step)。
 *  - 所有阈值/权重/效果全抽 config，本文件只做逻辑，不写死数值。
 */
import type {
  AttrKey,
  ClassDef,
  ClassPromoteCondRow,
  GameConfig,
  GameState,
  StandingDef,
} from './types';
import { emitEvent } from './events';

/** Σ 全部技能等级（职业系统总开关判定用） */
export function totalSkillLv(state: GameState): number {
  let s = 0;
  for (const k of Object.keys(state.skills)) s += state.skills[k]?.lv ?? 0;
  return s;
}

/** 职业系统是否已解锁（总开关） */
export function isClassUnlocked(state: GameState, cfg: GameConfig): boolean {
  return totalSkillLv(state) > cfg.values.classUnlockSkillLvTotal;
}

/** 单条晋身条件是否满足 */
export function condMet(state: GameState, cond: ClassPromoteCondRow | undefined): boolean {
  if (!cond) return false;
  switch (cond.type) {
    case 'a_rep': {
      const sp = state.skills[cond.target];
      return sp ? sp.lv >= cond.threshold : false;
    }
    case 'b_general': {
      if (cond.target === 'any') {
        const max = Object.values(state.relations).reduce((a, b) => Math.max(a, b), 0);
        return max >= cond.threshold;
      }
      return (state.relations[cond.target] ?? 0) >= cond.threshold;
    }
    case 'c_standing':
      return state.standingActive.includes(cond.target);
    case 'd_train': {
      if (cond.target === 'totalSkillLv') return totalSkillLv(state) >= cond.threshold;
      return (state.attrs[cond.target as AttrKey] ?? 0) >= cond.threshold;
    }
    default:
      return false;
  }
}

/** 已晋身（解锁）的全部职业线 */
export function getUnlockedClasses(state: GameState, cfg: GameConfig): ClassDef[] {
  return cfg.classDefs.filter((c) => {
    const ids = (c.promoteCond ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return false; // 未配置晋身条件 → 默认锁定（需显式配置）
    return ids.every((id) => condMet(state, cfg.classPromoteCondByTag[id]));
  });
}

/** 某条职业线是否已晋身 */
export function isClassLineUnlocked(state: GameState, cfg: GameConfig, classType: string): boolean {
  return getUnlockedClasses(state, cfg).some((c) => c.classType === classType);
}

/** 生效职业的亲密度技能集合（路由偏置用）；未解锁/未选则返回空 */
export function classAffinitySkills(cfg: GameConfig, classType: string): string[] {
  const m = cfg.classAffinityMap[classType];
  return m ? Object.keys(m) : [];
}

/** 任务生成路由偏好：职业解锁且已选生效职业 → 其亲密度技能；否则空（调用方回退 ambition） */
export function prefSkillTags(state: GameState, cfg: GameConfig): string[] {
  if (!isClassUnlocked(state, cfg) || !state.activeClass) return [];
  return classAffinitySkills(cfg, state.activeClass);
}

/** 给生效职业涨经验并晋阶（仅当 skill 命中其亲密度）；晋阶复用属性升级曲线 attrLvNeed */
export function gainClassExp(state: GameState, cfg: GameConfig, skillTag: string, amount: number): void {
  if (!amount || !state.activeClass || !isClassUnlocked(state, cfg)) return;
  const ct = state.activeClass;
  const aff = cfg.classAffinityMap[ct];
  if (!aff || !aff[skillTag]) return; // 只给生效职业的亲密度技能涨经验
  if (state.classLv[ct] == null) state.classLv[ct] = 1;
  if (state.classExp[ct] == null) state.classExp[ct] = 0;
  const rankCount = cfg.classByTag[ct]?.rankCount ?? 9;
  state.classExp[ct] += amount;
  let guard = 0;
  while (guard++ < 2000) {
    const rank = state.classLv[ct] ?? 1;
    if (rank >= rankCount) {
      state.classExp[ct] = 0;
      break;
    }
    const need = cfg.attrLvNeed(rank);
    if (need === null || need === undefined) break;
    if (state.classExp[ct] < need) break;
    state.classExp[ct] -= need;
    state.classLv[ct] = rank + 1;
    emitEvent(state, `晋身为「${cfg.classByTag[ct]?.name ?? ct}」第 ${state.classLv[ct]} 阶`, 1, 'class');
  }
}

/** 生效职业某效果键的累计值（rank ≤ 当前阶的所有行求和）；未选/无行返回 fallback */
export function classEffectValue(state: GameState, cfg: GameConfig, key: string, fallback = 0): number {
  if (!state.activeClass) return fallback;
  const rank = state.classLv[state.activeClass] ?? 0;
  if (rank <= 0) return fallback;
  let sum = 0;
  for (const e of cfg.classEffect) {
    if (e.classType === state.activeClass && e.effectKey === key && e.rank <= rank) sum += e.value;
  }
  return sum || fallback;
}

/** 按「任务技能是否命中生效职业亲密度」门控的效果值（命中才返回累计值，否则 0） */
export function affClassEffect(state: GameState, cfg: GameConfig, skillTag: string, key: string): number {
  if (!state.activeClass) return 0;
  const aff = cfg.classAffinityMap[state.activeClass];
  if (!aff || !aff[skillTag]) return 0;
  return classEffectValue(state, cfg, key, 0);
}

/** 切换职业可行性（含冷却校验） */
export function canSwitchClass(
  state: GameState,
  cfg: GameConfig,
  nowMs: number,
): { ok: boolean; reason: string } {
  if (!isClassUnlocked(state, cfg)) return { ok: false, reason: '职业系统未解锁' };
  if (state.classSwitchCd && nowMs < state.classSwitchCd) {
    const left = Math.ceil((state.classSwitchCd - nowMs) / 1000);
    return { ok: false, reason: `冷却中（剩 ${left}s）` };
  }
  return { ok: true, reason: '' };
}

/** 设置生效职业（校验晋身 + 冷却，成功写入并起冷却） */
export function setActiveClass(state: GameState, cfg: GameConfig, classType: string, nowMs: number): boolean {
  if (!isClassLineUnlocked(state, cfg, classType)) return false;
  const chk = canSwitchClass(state, cfg, nowMs);
  if (!chk.ok) return false;
  state.activeClass = classType;
  if (state.classLv[classType] == null) state.classLv[classType] = 1;
  if (state.classExp[classType] == null) state.classExp[classType] = 0;
  state.classSwitchCd = nowMs + cfg.values.classSwitchCdSec * 1000;
  return true;
}

/** 身份上阵位数 = 基数 + floor(Σ职业总阶 / step) */
export function activeStandingSlots(state: GameState, cfg: GameConfig): number {
  const total = Object.values(state.classLv).reduce((a, b) => a + (b || 0), 0);
  return cfg.values.classSlotBase + Math.floor(total / Math.max(1, cfg.values.classSlotStep));
}

/** 身份需求是否满足（职业阶达标 + 前置身份已上阵） */
export function standingReqMet(state: GameState, s: StandingDef): boolean {
  const clsOk = (s.reqClasses || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .every((pair) => {
      const [ct, lv] = pair.split(':');
      return (state.classLv[ct] ?? 0) >= Number(lv || 0);
    });
  const standOk = (s.reqStandings || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .every((tag) => state.standingActive.includes(tag));
  return clsOk && standOk;
}

/** 自动上阵满足需求的身份（不可降级，仅增）；调用方在结算/读档兜底处调用 */
export function syncStandings(state: GameState, cfg: GameConfig): void {
  for (const s of cfg.standingDefs) {
    if (state.standingActive.includes(s.standingTag)) continue;
    if (standingReqMet(state, s)) {
      state.standingActive.push(s.standingTag);
      emitEvent(state, `获得身份「${s.name}」`, 2, 'standing');
    }
  }
}

/** UI 用：某职业的当前阶/经验/升级需求 */
export function classProgress(
  state: GameState,
  cfg: GameConfig,
  classType: string,
): { rank: number; exp: number; need: number | null } {
  const rank = state.classLv[classType] ?? 0;
  const exp = state.classExp[classType] ?? 0;
  const need = rank > 0 ? cfg.attrLvNeed(rank) : null;
  return { rank, exp, need };
}
