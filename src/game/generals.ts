/**
 * 三国武将（关系系统的人物池）。
 *
 * 现状：设计文档 F28 / 人物表（30 人）尚未接入配置，这里先内置一份约 20 人的**精选名将**占位，
 * 每名含阵营 + 主/次偏好（设计 §五：每个人物 1 主偏好 + 1 次偏好）。后续接入正式人物表时，
 * 只需替换 `GENERALS` 的来源即可，下游 `relations` / `propagateDeed` / 面板渲染均无需改动。
 *
 * 偏好取自四维属性（武力 / 统帅 / 智力 / 政治），与任务 `cls → 主属性` 的"事迹传播"口径对齐。
 */
import {
  REL_AMBIENT,
  REL_MAIN_BONUS,
  REL_SUB_BONUS,
  REL_TARGET_MULT,
  REL_FIRST_MEET,
  REL_FIRST_MEET_CHANCE,
  DEED_LEAD_CHANCE,
  CLS_TO_ATTR,
} from './constants';
import type { AttrKey, GameState, TaskDef } from './types';
import { pickOne, randFloat } from './rng';
import { emitEvent } from './events';

export type Faction = '魏' | '蜀' | '吴' | '群';

export interface GeneralDef {
  tag: string; // 英文/拼音 tag，作为 relations 的 key
  name: string; // 中文名
  faction: Faction;
  mainPref: AttrKey; // 主偏好
  subPref: AttrKey; // 次偏好
}

/** 内置精选名将（占位用，后续可替换为正式人物表） */
export const GENERALS: GeneralDef[] = [
  // 蜀
  { tag: 'liubei', name: '刘备', faction: '蜀', mainPref: 'politics', subPref: 'leadership' },
  { tag: 'guanyu', name: '关羽', faction: '蜀', mainPref: 'force', subPref: 'leadership' },
  { tag: 'zhangfei', name: '张飞', faction: '蜀', mainPref: 'force', subPref: 'politics' },
  { tag: 'zhaoyun', name: '赵云', faction: '蜀', mainPref: 'force', subPref: 'leadership' },
  { tag: 'zhugeliang', name: '诸葛亮', faction: '蜀', mainPref: 'intelligent', subPref: 'politics' },
  { tag: 'machao', name: '马超', faction: '蜀', mainPref: 'force', subPref: 'leadership' },
  { tag: 'huangzhong', name: '黄忠', faction: '蜀', mainPref: 'force', subPref: 'politics' },
  { tag: 'weiyan', name: '魏延', faction: '蜀', mainPref: 'force', subPref: 'leadership' },
  // 魏
  { tag: 'caocao', name: '曹操', faction: '魏', mainPref: 'leadership', subPref: 'politics' },
  { tag: 'simayi', name: '司马懿', faction: '魏', mainPref: 'intelligent', subPref: 'politics' },
  { tag: 'zhangliao', name: '张辽', faction: '魏', mainPref: 'force', subPref: 'leadership' },
  { tag: 'xiahoudun', name: '夏侯惇', faction: '魏', mainPref: 'force', subPref: 'politics' },
  { tag: 'xuhuang', name: '徐晃', faction: '魏', mainPref: 'force', subPref: 'leadership' },
  { tag: 'zhanghe', name: '张郃', faction: '魏', mainPref: 'force', subPref: 'leadership' },
  { tag: 'dianwei', name: '典韦', faction: '魏', mainPref: 'force', subPref: 'politics' },
  // 吴
  { tag: 'sunquan', name: '孙权', faction: '吴', mainPref: 'politics', subPref: 'leadership' },
  { tag: 'zhouyu', name: '周瑜', faction: '吴', mainPref: 'intelligent', subPref: 'leadership' },
  { tag: 'luxun', name: '陆逊', faction: '吴', mainPref: 'intelligent', subPref: 'politics' },
  { tag: 'taishici', name: '太史慈', faction: '吴', mainPref: 'force', subPref: 'leadership' },
  { tag: 'ganning', name: '甘宁', faction: '吴', mainPref: 'force', subPref: 'politics' },
  // 群
  { tag: 'lvbu', name: '吕布', faction: '群', mainPref: 'force', subPref: 'politics' },
  { tag: 'dongzhuo', name: '董卓', faction: '群', mainPref: 'force', subPref: 'politics' },
  { tag: 'yuanshao', name: '袁绍', faction: '群', mainPref: 'politics', subPref: 'leadership' },
];

export const generalByTag: Record<string, GeneralDef> = Object.fromEntries(
  GENERALS.map((g) => [g.tag, g]),
);

/** 关系阶段：阈值升序，最后一个为满级（进度条封顶） */
export interface RelStage {
  name: string;
  min: number;
}
export const REL_STAGES: RelStage[] = [
  { name: '素未谋面', min: 0 },
  { name: '初识', min: 1 },
  { name: '相识', min: 20 },
  { name: '友善', min: 50 },
  { name: '莫逆', min: 90 },
  { name: '知己', min: 140 },
];

export interface RelStageInfo {
  index: number; // 当前阶段下标
  name: string; // 当前阶段名
  nextMin: number; // 下一阶段阈值（已满则为 Infinity）
  progress: number; // 到下一阶段的进度 0–1（已满为 1）
}

/** 由好感值推导所属阶段与进度条比例 */
export function relationStage(value: number): RelStageInfo {
  if (value <= 0) {
    return { index: 0, name: REL_STAGES[0].name, nextMin: REL_STAGES[1].min, progress: 0 };
  }
  let index = 0;
  for (let i = 0; i < REL_STAGES.length; i++) {
    if (value >= REL_STAGES[i].min) index = i;
    else break;
  }
  const cur = REL_STAGES[index];
  const next = REL_STAGES[index + 1];
  if (!next) return { index, name: cur.name, nextMin: Infinity, progress: 1 };
  const span = next.min - cur.min;
  const progress = span > 0 ? Math.min(1, Math.max(0, (value - cur.min) / span)) : 1;
  return { index, name: cur.name, nextMin: next.min, progress };
}

/**
 * 事迹传播：一次任务完成，会把"展示属性"一对多地分给**已结识**武将（relations > 0）。
 * 展示属性由任务 cls 决定（A←武力 / B←智力 / C←政治），统帅按概率出现。
 * 攻略对象（state.target）对所有命中再乘 `REL_TARGET_MULT`。
 * 注意：素未谋面者不在此处获得好感——正式结识只由 C 类「初识事件」触发（见 `maybeFirstMeet`）。
 */
export function propagateDeed(state: GameState, def: TaskDef): void {
  const shown = new Set<AttrKey>();
  const main = CLS_TO_ATTR[def.cls];
  if (main) shown.add(main);
  if (randFloat(state) < DEED_LEAD_CHANCE) shown.add('leadership');
  propagateDeedAttrs(state, shown);
}

/**
 * 事迹传播的核心：按"展示属性"一对多涨**已结识**武将的好感。
 * 任务侧传 cls 推出的属性；**随机事件侧直接传事件的展示属性**（内容设计 §四）。
 * 素未谋面者不在此处获得好感 —— 正式结识只由 C 类「初识事件」或事件的初识分支触发。
 */
export function propagateDeedAttrs(state: GameState, shown: Set<AttrKey>): void {
  if (shown.size === 0) return;

  const target = state.target;
  const targetStageBefore =
    target != null ? relationStage(state.relations[target] ?? 0).index : -1;

  for (const g of GENERALS) {
    const cur = state.relations[g.tag] ?? 0;
    if (cur <= 0) continue; // 素未谋面：暂不参与事迹传播，等初识事件
    let inc = REL_AMBIENT;
    if (g.mainPref && shown.has(g.mainPref)) inc += REL_MAIN_BONUS;
    if (g.subPref && shown.has(g.subPref)) inc += REL_SUB_BONUS;
    if (target === g.tag) inc *= REL_TARGET_MULT;
    if (inc <= 0) continue;
    state.relations[g.tag] = cur + inc;
  }

  // 攻略对象升阶时给一条日志反馈
  if (target != null) {
    const after = relationStage(state.relations[target] ?? 0).index;
    if (after > targetStageBefore) {
      const g = generalByTag[target];
      if (g) emitEvent(state, `你与${g.name}的关系更进一步：${REL_STAGES[after].name}`, 1, 'favor');
    }
  }
}

/**
 * 生成 C 类任务时预锁定「本次好感对象」：
 * 1) 若玩家已选攻略对象（state.target）且尚素未谋面 → 直接锁定 target（定向攒攻略对象）；
 * 2) 否则从「素未谋面」池随机抽一位（保留初识新武将的玩法感）；
 * 3) 若全员已结识 → 全池随机一位（仍会收到事迹传播好感）。
 * 这样任务板在任务进行中即可显示具体角色（所见即所得）。
 */
export function pickFirstMeetHero(state: GameState): string {
  const target = state.target;
  if (target && (state.relations[target] ?? 0) <= 0) return target; // 定向攻略对象（素未谋面）
  const unmet = GENERALS.filter((g) => (state.relations[g.tag] ?? 0) <= 0);
  if (unmet.length) {
    const g = pickOne(state, unmet);
    if (g) return g.tag;
  }
  const g = pickOne(state, GENERALS);
  if (g) return g.tag;
  return GENERALS[0]?.tag ?? 'liubei'; // 兜底：GENERALS 恒非空
}

/**
 * C 类（人物）任务结算时的「初识事件」。
 * - 传入 `forcedTag`（生成时锁定的 heroTag）→ 必定对这位武将建立/确认关系（素未谋面则注入 `REL_FIRST_MEET` 并写日志，已结识则跳过初识事件），返回该 tag。实现「所见即所得」：卡片显示的 = 结算实际加好感的。
 * - 不传 forcedTag（旧档/兼容）→ 走原逻辑：按 `REL_FIRST_MEET_CHANCE` 概率随机偶遇一位素未谋面的武将。
 * @returns 本次初识/锁定的武将 tag（未触发返回 null）
 */
export function maybeFirstMeet(state: GameState, forcedTag?: string | null): string | null {
  if (forcedTag != null) {
    const g = generalByTag[forcedTag];
    if (!g) return null;
    const cur = state.relations[forcedTag] ?? 0;
    if (cur <= 0) {
      state.relations[forcedTag] = REL_FIRST_MEET;
      emitEvent(state, `人物任务中结交${g.faction}${g.name}，初识之缘 +${REL_FIRST_MEET}`, 1, 'meet');
    }
    return forcedTag;
  }
  // ── 向后兼容：无 forcedTag 时保持原随机偶遇语义 ──
  if (randFloat(state) >= REL_FIRST_MEET_CHANCE) return null;
  const unmet = GENERALS.filter((g) => (state.relations[g.tag] ?? 0) <= 0);
  if (unmet.length === 0) return null;
  const g = pickOne(state, unmet);
  if (!g) return null;
  state.relations[g.tag] = REL_FIRST_MEET;
  emitEvent(state, `人物任务中偶遇${g.faction}${g.name}，初识之缘 +${REL_FIRST_MEET}`, 1, 'meet');
  return g.tag;
}

/** 新生/读档兜底：补齐所有武将的好感记录（缺省 0） */
export function ensureRelations(state: GameState): void {
  if (!state.relations || typeof state.relations !== 'object') state.relations = {};
  for (const g of GENERALS) {
    if (typeof state.relations[g.tag] !== 'number' || !Number.isFinite(state.relations[g.tag])) {
      state.relations[g.tag] = 0;
    }
  }
  if (state.target !== null && !generalByTag[state.target]) state.target = null;
}
