import type { GameConfig, GameState } from './types';
import type { Graph } from './graph';
import { nodeDistance } from './graph';
import { buildTaskIndex, type TaskIndex } from './taskGen';
import { bagSlotsUsed, createInitialState } from './state';
import { tick, type TickCtx } from './tick';
import { OFFLINE_CAP_HOURS } from './constants';

export interface CheckItem {
  label: string;
  expect: string;
  actual: string;
  ok: boolean;
}

/** 开发文档 §7.1 路网对拍基准（Dijkstra 真值，必须全中） */
export const DIST_BENCHMARKS: { from: number; to: number; expect: number; label: string }[] = [
  { from: 2, to: 4, expect: 6, label: '兵营/上庸 → 农田/上庸（同城）' },
  { from: 2, to: 8, expect: 22, label: '兵营/上庸 → 矿山/新野' },
  { from: 1, to: 13, expect: 31, label: '州府上庸 → 州府襄阳' },
  { from: 2, to: 14, expect: 37, label: '兵营/上庸 → 矿山/襄阳' },
  { from: 6, to: 14, expect: 55, label: '酒馆/新野 → 矿山/襄阳（最远）' },
];

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

  // 1. 距离对拍
  for (const b of DIST_BENCHMARKS) {
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
  samples: number;
  /** 空转采样数（应为 0） */
  idleSamples: number;
  /** 超容却没在回城的采样数（应为 0） */
  overloadViolations: number;
}

/** 24 小时模拟（开发文档 §7.2 节奏验收） */
export function simulate(cfg: GameConfig, graph: Graph, hours = 24, seed = 20261001): SimResult {
  const taskIndex: TaskIndex = buildTaskIndex(cfg);
  const ctx: TickCtx = { cfg, graph, taskIndex };
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
    const empty = state.slots.filter((s) => s.kind === 'empty').length;
    emptySum += empty;
    samples++;
    if (state.phase.kind === 'idle') idleSamples++;
    if (bagSlotsUsed(state, cfg) > cfg.values.backPackSlotNum && state.phase.kind !== 'returning') {
      overloadViolations++;
    }
  }
  const totalSec = hours * 3600;
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
    samples,
    idleSamples,
    overloadViolations,
  };
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
