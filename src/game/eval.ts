/**
 * 任务评价掷骰（Q19 定案）：属性调制概率，波动作法为「保底 1× + 增量 0~1×」。
 *
 * r = 主力属性 / attrBaseline
 *   w拙 = clamp(1 − r/3, 0, 1)
 *   w佳 = w绝 = clamp((r − 1)/2, 0, 1)
 *   w平 = 1
 * 硬规则：r < 1 只出拙/平；r ≥ 3 不出拙。属性只移动概率，不动保底（永 ≥ 1×）与封顶。
 */
import { DEFAULT_EVAL_INC, EVAL_NAMES } from './constants';
import { randFloat } from './rng';
import type { EvalTier, GameState } from './types';

export interface EvalResult {
  /** 四档：0 拙 / 1 平 / 2 佳 / 3 绝 */
  tier: EvalTier;
  /** r = 属性 / 基准 */
  r: number;
  /** 产出乘率 = 1 + evalInc[tier]（保底 1×，不倒扣） */
  mult: number;
  name: string;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * @param attr 主力属性当前等级（A←武力 / B←智力 / C←政治）
 * @param baseline task.attrBaseline = int(品质 × 4)
 * @param evalInc 四档增量；配置缺失时回落 DEFAULT_EVAL_INC
 */
export function rollEval(
  state: GameState,
  attr: number,
  baseline: number,
  evalInc?: readonly number[],
): EvalResult {
  const inc = evalInc && evalInc.length === 4 ? evalInc : DEFAULT_EVAL_INC;
  const base = baseline > 0 ? baseline : 1;
  const r = attr / base;

  let w0 = clamp01(1 - r / 3); // 拙
  const w1 = 1; // 平
  let w2 = clamp01((r - 1) / 2); // 佳
  let w3 = w2; // 绝

  if (r < 1) {
    w2 = 0;
    w3 = 0; // 够不着，只出拙/平
  }
  if (r >= 3) w0 = 0; // 远超基准，不出拙

  const total = w0 + w1 + w2 + w3;
  let x = randFloat(state) * total;
  let tier: EvalTier = 3;
  if ((x -= w0) < 0) tier = 0;
  else if ((x -= w1) < 0) tier = 1;
  else if ((x -= w2) < 0) tier = 2;

  return { tier, r, mult: 1 + inc[tier], name: EVAL_NAMES[tier] };
}

/** 无属性基准（V1 配置）时的空评价：保底 1× */
export function passEval(): EvalResult {
  return { tier: 1, r: 0, mult: 1, name: EVAL_NAMES[1] };
}
