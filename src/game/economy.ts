/**
 * V4 经济模块（E4 城际供需系数 + E3 自动补货 + E0 工钱赏金的地基）。
 *
 * 🔴 **本版经济是「临时宽松版」**（用户 2026-10-07 定）：买料溢价 1.5× 与加工溢价 1.5× 打平，
 * 是为了让经济系统不干扰其它系统的体验验证；等流程跑顺后会重做成「紧张经济」，
 * 届时 `WAGE_RATIO` 与 `BUY_PREMIUM` 需整体回调。
 *
 * 设计红线：
 *  ⑤ 金钱只能来自产出转化，不得无产出即得钱（工钱 = 对当次产出的折算，不算绕过产出链）
 *  ⑦ 自动补货只补「材料」，不补「稀有」（稀有只有 C 类产，红线① 的延伸）
 */
import type { GameConfig } from './types';

// ───────────────────────── 常量 ─────────────────────────

/** 供需系数三档：产地便宜、邻城基准、远地贵 */
export const DEMAND_RATIO = { local: 0.8, near: 1.0, far: 1.3 } as const;
/** 自动补货溢价（与加工溢价 1.5× 打平 → 补货不亏不赚，缺料率唯一闸门 = WAGE_RATIO） */
export const BUY_PREMIUM = 1.5;
/** 每城每 subCat 每日自动补货上限 */
export const DAILY_BUY_LIMIT = 20;

// ───────────────────────── 城际供需系数（E4） ─────────────────────────

/** 'iron_3' → 'iron' */
function subOf(tag: string): string {
  return tag.replace(/_\d+$/, '');
}

/**
 * 材料 subCat → 产出它的设施 tag。
 * 由 task 表反推（A 类任务的产出即材料，技能带 mainNode），避免在配置里再维护一张映射表。
 */
export function buildSubCatFacility(cfg: GameConfig): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of cfg.tasks) {
    if (t.cls !== 'A' || !t.mainOutput) continue;
    const sub = subOf(t.mainOutput);
    const node = cfg.skillByTag[t.skill]?.mainNode;
    if (sub && node) map[sub] = node;
  }
  return map;
}

/** 城市邻域：cityTag → 直达邻城 tag 集合（来自 cityLink，连通的唯一事实源） */
function buildNeighbors(cfg: GameConfig): Record<string, Set<string>> {
  const nb: Record<string, Set<string>> = {};
  for (const c of cfg.cities) nb[c.tag] = new Set();
  for (const l of cfg.links) {
    nb[l.tagA]?.add(l.tagB);
    nb[l.tagB]?.add(l.tagA);
  }
  return nb;
}

/**
 * 城际供需系数表：cityTag → subCat → ratio。
 *
 * 规则（不落 42×19 行表，全部推导）：
 *  - 产地城（本城有产出该 subCat 的设施）→ 0.8
 *  - 与任一产地城 `cityLink` 直达  → 1.0
 *  - 其余                          → 1.3
 *
 * ⚠ 只推导**材料** subCat（本版钱的唯一用途是补货买材料）；
 * 稀有与成品查不到映射 → `cityRatio()` 回落 1.0（基准），不崩。
 */
export function buildDemand(cfg: GameConfig): Record<string, Record<string, number>> {
  const facility = buildSubCatFacility(cfg);
  const nb = buildNeighbors(cfg);
  const out: Record<string, Record<string, number>> = {};

  for (const sub of Object.keys(facility)) {
    const node = facility[sub];
    const producers = cfg.cities.filter((c) => c.taskTypes.includes(node)).map((c) => c.tag);
    if (!producers.length) continue;
    const producerSet = new Set(producers);
    for (const c of cfg.cities) {
      let ratio: number;
      if (producerSet.has(c.tag)) {
        ratio = DEMAND_RATIO.local;
      } else if (producers.some((p) => nb[c.tag]?.has(p))) {
        ratio = DEMAND_RATIO.near;
      } else {
        ratio = DEMAND_RATIO.far;
      }
      (out[c.tag] ??= {})[sub] = ratio;
    }
  }
  return out;
}

/** 查询城际系数；无映射（稀有/成品/旧配置）回落 1.0 */
export function cityRatio(
  demand: Record<string, Record<string, number>>,
  cityTag: string,
  subCat: string,
): number {
  return demand[cityTag]?.[subCat] ?? DEMAND_RATIO.near;
}

// ───────────────────────── 价格查询 ─────────────────────────

/** 物品基准价（文）；无 price 体系时返回 0（→ 经济系统禁用） */
export function basePrice(cfg: GameConfig, itemTag: string): number {
  return cfg.itemByTag[itemTag]?.price ?? 0;
}

/**
 * 工钱 / 赏金统一口径：`price[材料|tier]`，**与 A/B/C 类别无关**
 * （工钱是跑腿费只认品质；若按各任务实际产物估价，B 的成品、C 的稀有会远高于 A）。
 */
export function tierPrice(cfg: GameConfig, tier: number): number {
  return cfg.priceByKey[`材料|${tier}`] ?? 0;
}

/** 自动补货买入单价（文）= 基准 × 城际系数 × 溢价；基准为 0 时返回 0（不可买） */
export function buyPrice(
  cfg: GameConfig,
  demand: Record<string, Record<string, number>>,
  cityTag: string,
  itemTag: string,
): number {
  const base = basePrice(cfg, itemTag);
  if (base <= 0) return 0;
  const sub = cfg.itemByTag[itemTag]?.subCat ?? '';
  return Math.round(base * cityRatio(demand, cityTag, sub) * BUY_PREMIUM);
}

// 城际供需系数表懒构建一次并缓存（纯 cfg 派生，确定性；避免每次结算/渲染重复算）
let _demandCache: Record<string, Record<string, number>> | null = null;
export function getDemand(cfg: GameConfig): Record<string, Record<string, number>> {
  if (!_demandCache) _demandCache = buildDemand(cfg);
  return _demandCache;
}
