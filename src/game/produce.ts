/**
 * 产出分层（T5）：同一品质的三类任务，**收益必须不同**
 *   A 采集 → 给「量」：主产物数量受评价乘率放大
 *   B 制造 → 给「效率」：按配方投喂 A 料 + C 稀有料，评价越高越省料（缺件自然停，不倒扣）
 *   C 人物 → 给「关系」：好感 + 稀有料 + 图纸（A 类永不产稀有，红线①）
 */
import {
  BLUEPRINT_MIN_EVAL_TIER,
  BLUEPRINT_MIN_FAVOR,
  BLUEPRINT_MIN_QUALITY,
  EFF_SAVE_AT_BEST,
  EXTRA_BONUS_RATIO,
  FAVOR_PER_TASK,
  MINGQI_BY_C_SKILL,
  MINGQI_CHANCE,
  MINGQI_MIN_EVAL_TIER,
  MINGQI_MIN_QUALITY,
  RARE_MIN_QUALITY,
  rareCountByQuality,
} from './constants';
import type { EvalResult } from './eval';
import { addItem, consumeItem, ownedCount } from './inventory';
import { pickOne, randFloat, rollRange, weightedPick } from './rng';
import { emitEvent } from './events';
import type { RewardItem } from './taskLog';
import type { GameConfig, GameState, Task, TaskDef } from './types';

/**
 * @returns 本次实际产出的物品列表（不记录消耗），供统计/录制用；调用顺序不受返回值影响。
 * `task` 用于 B 类取「刷出任务时锁定的制造目标」（V5）；不传则回退 TaskDef.mainOutput。
 */
export function settleOutput(
  state: GameState,
  cfg: GameConfig,
  def: TaskDef,
  ev: EvalResult,
  task?: Task,
): RewardItem[] {
  switch (def.cls) {
    case 'A':
      return settleGather(state, def, ev);
    case 'B':
      return settleCraft(state, cfg, def, ev, task);
    case 'C':
      return settleSocial(state, cfg, def, ev);
    default:
      return settleGather(state, def, ev); // 未标类的老配置：按最朴素的「发道具」处理
  }
}

/** A 给量：实际 = 保底 1× + 增量（0~1×），永不倒扣 */
function settleGather(state: GameState, def: TaskDef, ev: EvalResult): RewardItem[] {
  const tag = def.mainOutput || def.getItem;
  if (!tag) return [];
  const base = rollRange(state, def.getItemNum);
  const n = Math.max(1, Math.floor(base * ev.mult));
  addItem(state, tag, n);
  return [{ tag, n }];
}

/**
 * B 效率：n 品制造只吃 q≥n 的 A 主料（红线④，生产侧按 recipe.matQualityFloor 把关）。
 * 评价越高越省料（绝 −25%）；缺图纸/缺料只停产出，不扣玩家任何东西。
 * 库存不足时按「能做几件做几件」交付，避免高品批量需求把线锁死。
 *
 * V5 两层需求——**只有基础层是开工门槛，额外层是加成**：
 *   基础层（配对 A 的同阶料 + 配对 C 的同阶稀有）齐备 → 开造；
 *   额外层（其他行当的 q-1 阶料 + q-1 阶稀有）齐备 → **额外产出**，缺了也照造、不消耗。
 */
function settleCraft(
  state: GameState,
  cfg: GameConfig,
  def: TaskDef,
  ev: EvalResult,
  task?: Task,
): RewardItem[] {
  const preferred = task?.outputTag && cfg.recipeByResult[task.outputTag] ? task.outputTag : '';
  const product = preferred || def.mainOutput || def.getItem;
  const recipe = product ? cfg.recipeByResult[product] : undefined;
  if (!recipe) return [];

  if (recipe.needBlueprint && !state.blueprints.includes(recipe.needBlueprint)) {
    state.stats.starvedTasks += 1;
    return [];
  }

  const save = EFF_SAVE_AT_BEST * Math.min(1, Math.max(0, ev.mult - 1)); // evalInc 上限 1 → 省料上限 25%
  const per = (tag: string, num: number) => (tag ? Math.max(1, Math.ceil(num * (1 - save))) : 0);
  const matPer = per(recipe.needItem1, recipe.needItem1Num);
  const mat2Per = per(recipe.needItem2, recipe.needItem2Num);
  const rarePer = recipe.needRare ? 1 : 0;
  const rare2Per = recipe.needRare2 ? 1 : 0;

  const own = (tag: string) => (tag ? ownedCount(state, tag) : Infinity);
  const matOwn = own(recipe.needItem1);
  const mat2Own = own(recipe.needItem2);
  const rareOwn = own(recipe.needRare);
  const rare2Own = own(recipe.needRare2);
  const sub = recipe.needRare ? recipe.needRare.replace(/_\d+$/, '') : '';
  const sub2 = recipe.needRare2 ? recipe.needRare2.replace(/_\d+$/, '') : '';

  // 缺料细分：先判是哪一类料卡住（决定缺料率的真实成因，也决定 E3 自动补货能补掉多少）
  const starve = (kind: 'mat' | 'rare', subCat: string) => {
    state.stats.starvedTasks += 1;
    if (kind === 'mat') state.stats.starvedMat += 1;
    else {
      state.stats.starvedRare += 1;
      if (subCat) state.stats.starvedBySubCat[subCat] = (state.stats.starvedBySubCat[subCat] ?? 0) + 1;
    }
  };
  if (matOwn < matPer) {
    starve('mat', '');
    return [];
  }

  const rolled = Math.max(1, rollRange(state, def.getItemNum));
  // Plan C v2：B 类稀有实际需求（attempted，与供给无关）= 每次掷骰量；用于按实际 B 需求重加权 C 掉率。
  // 额外层也计入——它虽不拦开工，但仍是真实的稀有消耗源。
  if (sub) state.stats.demandBySubCat[sub] = (state.stats.demandBySubCat[sub] ?? 0) + rolled;
  if (sub2) state.stats.demandBySubCat[sub2] = (state.stats.demandBySubCat[sub2] ?? 0) + rolled;
  if (rareOwn < rarePer) {
    starve('rare', sub);
    return [];
  }

  // 基础层决定能造几件
  const cycles = Math.min(rolled, Math.floor(matOwn / matPer), rarePer ? Math.floor(rareOwn / rarePer) : Infinity);
  if (cycles < 1) {
    starve('mat', '');
    return [];
  }
  consumeItem(state, recipe.needItem1, matPer * cycles);
  if (recipe.needRare) consumeItem(state, recipe.needRare, rarePer * cycles);

  // 额外层：加成而非门槛。缺了不消耗、不停产；齐备时最多多产 cycles × EXTRA_BONUS_RATIO 件
  let bonus = 0;
  if (mat2Per > 0 || rare2Per > 0) {
    const cap = Math.max(1, Math.floor(cycles * EXTRA_BONUS_RATIO));
    bonus = Math.min(
      cap,
      mat2Per ? Math.floor(mat2Own / mat2Per) : Infinity,
      rare2Per ? Math.floor(rare2Own / rare2Per) : Infinity,
    );
    if (bonus > 0) {
      if (recipe.needItem2) consumeItem(state, recipe.needItem2, mat2Per * bonus);
      if (recipe.needRare2) consumeItem(state, recipe.needRare2, rare2Per * bonus);
    }
  }

  const n = Math.max(1, recipe.resultNum) * (cycles + bonus);
  addItem(state, recipe.resultItem, n);
  return [{ tag: recipe.resultItem, n }];
}

/** C 关系：好感 + 稀有料（红线① 只有 C 能给）+ 图纸 + 小概率名品 */
function settleSocial(state: GameState, cfg: GameConfig, def: TaskDef, ev: EvalResult): RewardItem[] {
  const out: RewardItem[] = [];
  const q = def.quality;
  const favor = FAVOR_PER_TASK + Math.max(0, q) + ev.tier;
  state.favor += favor;

  if (q >= RARE_MIN_QUALITY) {
    // 只在本品质下真实存在的稀有里抽：抽到不存在的 `${sub}_${q}` 会让这次产出直接作废
    const all = cfg.rareSubCatBySkill[def.skill] ?? [];
    const subs = all.filter((s) => cfg.itemByTag[`${s}_${q}`]);
    const wmap = cfg.rareSubCatWeightBySkill[def.skill];
    const weights = subs.map((s) => (wmap ? wmap[s] ?? 0 : 0));
    const sub = subs.length ? weightedPick(state, subs, weights) : null;
    const tag = sub ? `${sub}_${q}` : '';
    if (tag && sub && cfg.itemByTag[tag]) {
      // V5：产出件数按品质递增（1~3），额外层让 B 需求翻倍，恒 1 撑不住
      const cnt = rareCountByQuality(q);
      addItem(state, tag, cnt);
      state.stats.raresProduced[sub] = (state.stats.raresProduced[sub] ?? 0) + cnt;
      out.push({ tag, n: cnt });
    }
  }

  if (q >= MINGQI_MIN_QUALITY && ev.tier >= MINGQI_MIN_EVAL_TIER && randFloat(state) < MINGQI_CHANCE) {
    const mq = MINGQI_BY_C_SKILL[def.skill];
    if (mq && cfg.itemByTag[mq]) {
      addItem(state, mq, 1);
      out.push({ tag: mq, n: 1 });
      emitEvent(state, `获得名品「${cfg.itemByTag[mq].name}」`, 2, 'mingqi');
    }
  }

  // V5 边界①：q4 起制造就要图纸，故图纸掉落门槛同步下移到 q≥4（原 q≥7 会让中段长期空转）。
  // 每 C 技能持有 8 张图 → 从未拥有的里面随机发一张，而不是固定发第一张。
  if (q >= BLUEPRINT_MIN_QUALITY && ev.tier >= BLUEPRINT_MIN_EVAL_TIER && state.favor >= BLUEPRINT_MIN_FAVOR) {
    const owned = new Set(state.blueprints);
    const pool = cfg.blueprints.filter((b) => b.fromSkill === def.skill && !owned.has(b.tag));
    const bp = pool.length ? pickOne(state, pool) : null;
    if (bp) {
      state.blueprints.push(bp.tag);
      emitEvent(state, `习得图纸「${bp.name}」`, 1, 'blueprint');
    }
  }
  return out;
}
