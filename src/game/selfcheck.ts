import type { GameConfig, GameState } from './types';
import type { Graph } from './graph';
import { nodeDistance } from './graph';
import { buildTaskIndex, type TaskIndex } from './taskGen';
import { bagSlotsUsed, createInitialState } from './state';
import { tick, type TickCtx } from './tick';
import { eventByTag, resolveEvent } from './event';
import { randInt } from './rng';
import { OFFLINE_CAP_HOURS } from './constants';

export interface CheckItem {
  label: string;
  expect: string;
  actual: string;
  ok: boolean;
}

/** V2（42 城大地图）的一组基准：地图坐标/道路一改，需重新取真值 */
const V2_BENCHMARKS: { from: number; to: number; expect: number; label: string }[] = [
  { from: 1, to: 3, expect: 1, label: '州府蓟 → 猎场/蓟（同城）' },
  { from: 2, to: 5, expect: 7, label: '校场/蓟 → 猎场/北平（相邻城）' },
  { from: 24, to: 63, expect: 9, label: '州府洛阳 → 州府襄阳' },
  { from: 47, to: 74, expect: 29, label: '州府长安 → 州府建业（东西向）' },
  { from: 92, to: 6, expect: 55, label: '州府交趾 → 州府襄平（最远）' },
];

/**
 * V3（66 连通修正版）：删 晋阳-上党、邺-河内；增 河内-上党。
 * 基准数值与 V2 相同——删掉的两条边不在这 5 对的最短路上，
 * 但按「地图一改必须重新取真值」的纪律独立登记（gen_map_v2.py 末尾打印）。
 */
const V3_BENCHMARKS: { from: number; to: number; expect: number; label: string }[] = [
  { from: 1, to: 3, expect: 1, label: '州府蓟 → 猎场/蓟（同城）' },
  { from: 2, to: 5, expect: 7, label: '校场/蓟 → 猎场/北平（相邻城）' },
  { from: 24, to: 63, expect: 9, label: '州府洛阳 → 州府襄阳' },
  { from: 47, to: 74, expect: 29, label: '州府长安 → 州府建业（东西向）' },
  { from: 92, to: 6, expect: 55, label: '州府交趾 → 州府襄平（最远）' },
];

/**
 * 路网对拍基准（Dijkstra 真值，必须全中）。
 * 按**配置文件名**分组：地图一旦改动，必须同步刷新对应分组的 expect。
 * V2 的这几条由 `tools/gen_map_v2.py` 末尾自动打印，改了坐标/道路后重跑即可拿到新值。
 */
export const DIST_BENCHMARKS: Record<string, { from: number; to: number; expect: number; label: string }[]> = {
  'firstShow_V1.xlsx': [
    { from: 2, to: 4, expect: 6, label: '兵营/上庸 → 农田/上庸（同城）' },
    { from: 2, to: 8, expect: 22, label: '兵营/上庸 → 矿山/新野' },
    { from: 1, to: 13, expect: 31, label: '州府上庸 → 州府襄阳' },
    { from: 2, to: 14, expect: 37, label: '兵营/上庸 → 矿山/襄阳' },
    { from: 6, to: 14, expect: 55, label: '酒馆/新野 → 矿山/襄阳（最远）' },
  ],
  'firstShow_V2.xlsx': V2_BENCHMARKS, // second 版即 42 城大地图（见产品文档 §十一 配置落地）
  'firstShow_V3.xlsx': V3_BENCHMARKS, // 66 连通修正版 + cityLink 表（2026-10-06）
};

export interface CheckResult {
  ok: boolean;
  items: CheckItem[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    cellCount: number;
    components: number;
    facilityPairs: number;
    avgAll: number;
    avgSameCity: number;
    avgCrossCity: number;
    avgSameFacility: number;
    avgCrossFacility: number;
    maxDist: number;
  };
}

export function runSelfCheck(cfg: GameConfig, graph: Graph): CheckResult {
  const items: CheckItem[] = [];

  // 1. 距离对拍（按配置文件名取基准；未登记的配置跳过）
  const bench = DIST_BENCHMARKS[cfg.meta.file] ?? [];
  for (const b of bench) {
    const d = nodeDistance(graph, b.from, b.to);
    const actual = d === null ? '不可达' : String(d);
    items.push({ label: b.label, expect: String(b.expect), actual, ok: d === b.expect });
  }

  // 2. 规模
  const nodeCount = graph.nodes.length;
  let edgeCount = 0;
  for (const s of graph.nodeAdj) edgeCount += s.size;
  edgeCount = Math.floor(edgeCount / 2);
  items.push({ label: '图规模（点）', expect: `${cfg.nodes.length + cfg.roads.length}`, actual: String(nodeCount), ok: nodeCount === cfg.nodes.length + cfg.roads.length });

  // 3. 连通性
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    const cur = stack.pop() as number;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nb of graph.nodeAdj[cur]) if (!seen.has(nb)) stack.push(nb);
  }
  const components = seen.size === nodeCount ? 1 : -1;
  items.push({ label: '全图连通（单连通分量）', expect: '1', actual: components === 1 ? '1' : `${components}(未全连通)`, ok: components === 1 });

  // 4. 距离分布（与《配置读取规范.md》口径对齐：同城 4.42 / 跨州 37.33 / 全部 30.75）
  const marks = graph.nodes.filter((n) => n.kind === 'facility');
  const dists: { d: number; same: boolean; bothFacility: boolean }[] = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const d = nodeDistance(graph, marks[i].tag, marks[j].tag);
      if (d === null) continue;
      dists.push({
        d,
        same: marks[i].belong === marks[j].belong,
        bothFacility: marks[i].name !== 'city' && marks[j].name !== 'city',
      });
    }
  }
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const same = dists.filter((x) => x.same).map((x) => x.d);
  const cross = dists.filter((x) => !x.same).map((x) => x.d);
  const sameFac = dists.filter((x) => x.same && x.bothFacility).map((x) => x.d);
  const crossFac = dists.filter((x) => !x.same && x.bothFacility).map((x) => x.d);
  const maxDist = dists.length ? Math.max(...dists.map((x) => x.d)) : 0;

  return {
    ok: items.every((i) => i.ok),
    items,
    stats: {
      nodeCount,
      edgeCount,
      cellCount: graph.cells.length,
      components,
      facilityPairs: dists.length,
      avgAll: avg(dists.map((x) => x.d)),
      avgSameCity: avg(same),
      avgCrossCity: avg(cross),
      avgSameFacility: avg(sameFac),
      avgCrossFacility: avg(crossFac),
      maxDist,
    },
  };
}

export interface SimResult {
  hours: number;
  tasksDone: number;
  returnTrips: number;
  avgTaskCycleSec: number;
  tasksPerDay: number;
  avgEmptySlots: number;
  cellsWalked: number;
  storage: Record<string, number>;
  attrs: GameState['attrs'];
  /** 9 技能等级快照 */
  skills: Record<string, { lv: number; xp: number }>;
  /** 评价四档计数 [拙, 平, 佳, 绝] */
  evalTally: number[];
  /** A/B/C 完成计数 */
  clsTally: Record<string, number>;
  favor: number;
  blueprints: string[];
  /** 图纸节点解锁进度：每 C 技能已解锁到第几节点（BLUEPRINT_NODES 下标，0=未解锁） */
  blueprintNode: Record<string, number>;
  /** B 类缺料未完成次数 */
  starvedTasks: number;
  /** 缺料细分：材料不足 */
  starvedMat: number;
  /** 缺料细分：稀有料不足 */
  starvedRare: number;
  /** E8：缺稀有按 subCat 细分 */
  starvedBySubCat: Record<string, number>;
  /** 诊断用：C 类各 subCat 稀有产出计数（临时） */
  raresProduced: Record<string, number>;
  /** E8 Plan C v2：B 类各 subCat 稀有实际需求（已满足+未满足合计） */
  demandBySubCat: Record<string, number>;
  /** 仓内存货总件数 */
  storageCount: number;
  samples: number;
  /** 空转采样数（应为 0） */
  idleSamples: number;
  /** 超容却没在回城的采样数（应为 0） */
  overloadViolations: number;
  /** 已结算的随机事件条数（模拟器代玩家点掉，代表「玩家及时点」的供给上界） */
  eventsSettled: number;
  /** 累计获得的属性经验（四维合计，来自随机事件） */
  attrXpTotal: number;
  /** V4 金钱快照（文） */
  money: number;
  /** V4 累计获得 / 支出金钱（文） */
  moneyEarned: number;
  moneyEarnedWage: number;
  moneyEarnedBounty: number;
  moneySpent: number;
  /** V4 自动补货触发次数 */
  restockCount: number;
  /** 模拟结束时仍堆在容器里未处理的事件数（应接近 0；高说明玩家点不过来） */
  pendingLeft: number;
}

/**
 * 24 小时模拟（开发文档 §7.2 节奏验收）。
 *
 * ⚠ V4 R1 起默认 `autoEvents: true`：**随机事件会生成并被模拟器代玩家点掉**。
 * 原因：删掉临时属性桥后，四维只由随机事件供给，若模拟器不跑事件回路，
 * 校准出来的「属性 / 评价分布」是**测量失真**（事件一条没结算），不能作为调参依据。
 * 要复现旧口径（纯任务、不跑事件）传 `{ autoEvents: false }`。
 */
export function simulate(
  cfg: GameConfig,
  graph: Graph,
  hours = 24,
  seed = 20261001,
  opts?: { autoEvents?: boolean },
): SimResult {
  const autoEvents = opts?.autoEvents ?? true;
  const taskIndex: TaskIndex = buildTaskIndex(cfg);
  const ctx: TickCtx = { cfg, graph, taskIndex, online: autoEvents };
  const now = Date.now();
  const state = createInitialState(cfg, now, seed);
  tick(state, 1e-9, ctx); // 触发 syncPhase：接取队首

  const chunk = 30; // 秒
  const steps = Math.floor((hours * 3600) / chunk);
  let emptySum = 0;
  let samples = 0;
  let idleSamples = 0;
  let overloadViolations = 0;
  for (let i = 0; i < steps; i++) {
    tick(state, chunk, ctx);
    // 采样放在事件结算**之前**：事件会发物品，若先结算再采样，会把「事件塞满背包但还没到下次任务结算」
    // 记成「超容未回城」，那是采样时序造成的假告警（真实玩家下一次任务完成时同样会自动回城）。
    const empty = state.slots.filter((s) => s.kind === 'empty').length;
    emptySum += empty;
    samples++;
    if (state.phase.kind === 'idle') idleSamples++;
    if (bagSlotsUsed(state, cfg) > cfg.values.backPackSlotNum && state.phase.kind !== 'returning') {
      overloadViolations++;
    }
    if (autoEvents) autoResolveEvents(state, cfg);
  }
  const totalSec = hours * 3600;
  const skills: Record<string, { lv: number; xp: number }> = {};
  for (const [tag, p] of Object.entries(state.skills)) skills[tag] = { lv: p.lv, xp: p.xp };
  return {
    hours,
    tasksDone: state.stats.tasksDone,
    returnTrips: state.stats.returnTrips,
    avgTaskCycleSec: state.stats.tasksDone ? totalSec / state.stats.tasksDone : 0,
    tasksPerDay: (state.stats.tasksDone / hours) * 24,
    avgEmptySlots: samples ? emptySum / samples : 0,
    cellsWalked: state.stats.cellsWalked,
    storage: { ...state.storage },
    attrs: { ...state.attrs },
    skills,
    evalTally: [...state.stats.evalTally],
    clsTally: { ...state.stats.clsTally },
    favor: state.favor,
    blueprints: [...state.blueprints],
    blueprintNode: { ...state.blueprintNode },
    starvedTasks: state.stats.starvedTasks,
    starvedMat: state.stats.starvedMat ?? 0,
    starvedRare: state.stats.starvedRare ?? 0,
    starvedBySubCat: { ...state.stats.starvedBySubCat },
    raresProduced: { ...state.stats.raresProduced },
    demandBySubCat: { ...state.stats.demandBySubCat },
    storageCount: Object.values(state.storage).reduce((a, b) => a + b, 0),
    samples,
    idleSamples,
    overloadViolations,
    eventsSettled: state.stats.eventsSettled ?? 0,
    attrXpTotal: state.stats.attrXpTotal ?? 0,
    money: state.money ?? 0,
    moneyEarned: state.stats.moneyEarned ?? 0,
    moneyEarnedWage: state.stats.moneyEarnedWage ?? 0,
    moneyEarnedBounty: state.stats.moneyEarnedBounty ?? 0,
    moneySpent: state.stats.moneySpent ?? 0,
    restockCount: state.stats.restockCount ?? 0,
    pendingLeft: state.pending.length,
  };
}

/**
 * 模拟器代玩家把容器里的事件逐条点掉（多选项随机取一个，与真人决策同分布）。
 * 这是「玩家每次都及时点击」的上界；真实玩家会漏掉一部分（TTL 4h 后过期，不给奖励）。
 */
export function autoResolveEvents(state: GameState, cfg: GameConfig): void {
  let guard = 0;
  while (state.pending.length && guard++ < 50) {
    const p = state.pending[0];
    const def = eventByTag[p.tag];
    const n = def?.options?.length ?? 0;
    const optIdx = n > 0 ? randInt(state, 0, n - 1) : undefined;
    if (!resolveEvent(state, cfg, p.id, optIdx)) break;
  }
}

export interface OfflineResult {
  awayHours: number;
  settledHours: number;
  tasksDone: number;
  returnTrips: number;
  costMs: number;
}

/** 离线结算验证：时间回拨丢弃 + 上限 8 小时 + 离散事件推进（开发文档 §4.6 / §7.3） */
export function offlineSettle(cfg: GameConfig, graph: Graph, awayHours: number, seed = 7): OfflineResult {
  const ctx: TickCtx = { cfg, graph, taskIndex: buildTaskIndex(cfg) };
  const state = createInitialState(cfg, Date.now(), seed);
  tick(state, 1e-9, ctx);

  // 模拟「离开 X 小时后回来」
  const now = Date.now();
  state.lastTickAt = now - awayHours * 3600 * 1000;
  let elapsed = (now - state.lastTickAt) / 1000;
  if (elapsed < 0) elapsed = 0;
  const capped = Math.min(elapsed, OFFLINE_CAP_HOURS * 3600);

  const t0 = Date.now();
  tick(state, capped, ctx);
  const costMs = Date.now() - t0;

  return {
    awayHours,
    settledHours: capped / 3600,
    tasksDone: state.stats.tasksDone,
    returnTrips: state.stats.returnTrips,
    costMs,
  };
}
