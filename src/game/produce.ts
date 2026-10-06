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
  FAVOR_PER_TASK,
  MINGQI_BY_C_SKILL,
  MINGQI_CHANCE,
  MINGQI_MIN_EVAL_TIER,
  MINGQI_MIN_QUALITY,
  RARE_MIN_QUALITY,
} from './constants';
import type { EvalResult } from './eval';
import { addItem, consumeItem, ownedCount } from './inventory';
import { pickOne, randFloat, rollRange } from './rng';
import { emitEvent } from './events';
import type { RewardItem } from './taskLog';
import type { GameConfig, GameState, TaskDef } from './types';

/**
 * @returns 本次实际产出的物品列表（不记录消耗），供统计/录制用；调用顺序不受返回值影响。
 */
export function settleOutput(state: GameState, cfg: GameConfig, def: TaskDef, ev: EvalResult): RewardItem[] {
  switch (def.cls) {
    case 'A':
      return settleGather(state, def, ev);
    case 'B':
      return settleCraft(state, cfg, def, ev);
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
 * B 效率：n 品制造只吃 q≥n 的 A 料（红线④，生产侧按 recipe.matQualityFloor 把关）。
 * 评价越高越省料（绝 −25%）；缺图纸/缺料只停产出，不扣玩家任何东西。
 * 库存不足时按「能做几件做几件」交付，避免高品批量需求把线锁死。
 */
function settleCraft(state: GameState, cfg: GameConfig, def: TaskDef, ev: EvalResult): RewardItem[] {
  const product = def.mainOutput || def.getItem;
  const recipe = product ? cfg.recipeByResult[product] : undefined;
  if (!recipe) return [];

  if (recipe.needBlueprint && !state.blueprints.includes(recipe.needBlueprint)) {
    state.stats.starvedTasks += 1;
    return [];
  }

  const save = EFF_SAVE_AT_BEST * Math.min(1, Math.max(0, ev.mult - 1)); // evalInc 上限 1 → 省料上限 25%
  const matPer = Math.max(1, Math.ceil(recipe.needItem1Num * (1 - save)));
  const rarePer = recipe.needRare ? 1 : 0;

  const matOwn = ownedCount(state, recipe.needItem1);
  const rareOwn = recipe.needRare ? ownedCount(state, recipe.needRare) : Infinity;

  let cycles = Math.max(1, rollRange(state, def.getItemNum));
  cycles = Math.min(cycles, Math.floor(matOwn / matPer), rarePer ? Math.floor(rareOwn / rarePer) : Infinity);
  if (cycles < 1) {
    state.stats.starvedTasks += 1;
    return [];
  }

  consumeItem(state, recipe.needItem1, matPer * cycles);
  if (recipe.needRare) consumeItem(state, recipe.needRare, rarePer * cycles);
  const n = Math.max(1, recipe.resultNum) * cycles;
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
    const subs = cfg.rareSubCatBySkill[def.skill] ?? [];
    const sub = subs.length ? pickOne(state, subs) : null;
    const tag = sub ? `${sub}_${q}` : '';
    if (tag && cfg.itemByTag[tag]) {
      addItem(state, tag, 1);
      out.push({ tag, n: 1 });
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

  if (q >= BLUEPRINT_MIN_QUALITY && ev.tier >= BLUEPRINT_MIN_EVAL_TIER && state.favor >= BLUEPRINT_MIN_FAVOR) {
    const bp = cfg.blueprints.find((b) => b.fromSkill === def.skill);
    if (bp && !state.blueprints.includes(bp.tag)) {
      state.blueprints.push(bp.tag);
      emitEvent(state, `习得图纸「${bp.name}」`, 1, 'blueprint');
    }
  }
  return out;
}
