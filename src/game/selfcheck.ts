import type { GameConfig, GameState } from './types';
import { vdist, type VGraph } from './vgraph';
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

/**
 * 坐标模式路网对拍基准（向量图几何距离真值，必须全中）。
 * 按**配置文件名**分组；地图坐标/道路一改，需重跑 `npm run gen:pointmap` 后用
 * `tools/_dist_probe.ts` 重新取真值并刷新此处 expect。
 * 基准由 firstShow_V5.xlsx 实际坐标几何距离测得（四舍五入 2 位）。
 */
const V5_BENCHMARKS: { from: string; to: string; expect: number; label: string }[] = [
  { from: 'beiping', to: 'beiping', expect: 0, label: '蓟→蓟（同城，距离 0）' },
  { from: 'beiping', to: 'pingyuan', expect: 14.05, label: '蓟→北平（相邻城）' },
  { from: 'luoyang', to: 'xiangyang', expect: 9.86, label: '洛阳→襄阳' },
  { from: 'changan', to: 'jianye', expect: 34.64, label: '长安→建业（东西向）' },
  { from: 'jiaozhi', to: 'xiangping', expect: 63.86, label: '交趾→襄平（最远）' },
];

/**
 * 路网对拍基准（向量图几何距离真值）。
 * 按**配置文件名**分组：地图一旦改动，必须同步刷新对应分组的 expect。
 */
export const DIST_BENCHMARKS: Record<string, { from: string; to: string; expect: number; label: string }[]> = {
  'firstShow_V5.xlsx': V5_BENCHMARKS,
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

export function runSelfCheck(cfg: GameConfig, vgraph: VGraph | null): CheckResult {
  const items: CheckItem[] = [];

  // 1. 距离对拍（按配置文件名取基准；未登记的配置跳过）
  const bench = DIST_BENCHMARKS[cfg.meta.file] ?? [];
  for (const b of bench) {
    const d = vgraph ? vdist(vgraph, b.from, b.to) : null;
    const rd = d === null ? null : Math.round(d * 100) / 100;
    const actual = rd === null ? '不可达' : String(rd);
    items.push({ label: b.label, expect: String(b.expect), actual, ok: rd === b.expect });
  }

  // 2. 规模（向量图：城市点 + 拐点）
  const nodeCount = (cfg.cityPoints?.length ?? 0) + (cfg.waypoints?.length ?? 0);
  let edgeCount = 0;
  if (vgraph) for (const adj of vgraph.adj.values()) edgeCount += adj.length;
  edgeCount = Math.floor(edgeCount / 2);
  items.push({ label: '图规模（点）', expect: String(nodeCount), actual: String(nodeCount), ok: true });

  // 3. 连通性（向量图 DFS）
  let components = -1;
  if (vgraph) {
    const seen = new Set<string>();
    const startKey = vgraph.nodes.keys().next().value as string | undefined;
    if (startKey !== undefined) {
      const stack = [startKey];
      while (stack.length) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const e of vgraph.adj.get(cur) ?? []) if (!seen.has(e.to)) stack.push(e.to);
      }
    }
    components = seen.size === vgraph.nodes.size ? 1 : -1;
  }
  items.push({ label: '全图连通（单连通分量）', expect: '1', actual: components === 1 ? '1' : `${components}(未全连通)`, ok: components === 1 });

  // 3.5 cityLink 一致性（xlsx 与 pointmap 通用）
  const linkSet = new Set<string>();
  let dupLinks = 0;
  const linkedCities = new Set<string>();
  for (const l of cfg.links) {
    const k = l.tagA < l.tagB ? `${l.tagA}|${l.tagB}` : `${l.tagB}|${l.tagA}`;
    if (linkSet.has(k)) dupLinks++;
    linkSet.add(k);
    linkedCities.add(l.tagA);
    linkedCities.add(l.tagB);
  }
  const pointExists = (t: string) => !!cfg.cityByTag[t] || cfg.waypoints.some((w) => w.tag === t);
  const endpointsOk = cfg.links.every((l) => pointExists(l.tagA) && pointExists(l.tagB));
  items.push({
    label: '连线端点存在',
    expect: '全部存在',
    actual: endpointsOk ? '全部存在' : `缺失 ${cfg.links.filter((l) => !pointExists(l.tagA) || !pointExists(l.tagB)).length} 条`,
    ok: endpointsOk,
  });
  items.push({ label: '无重复 cityLink', expect: '0', actual: String(dupLinks), ok: dupLinks === 0 });
  const orphan = cfg.cities.filter((c) => !linkedCities.has(c.tag)).length;
  items.push({ label: '无孤儿城（每城≥1 link）', expect: '0', actual: String(orphan), ok: orphan === 0 });

  // 4. 距离分布（坐标模式：城市点对，按所属州分同城/跨州）
  const cps = cfg.cityPoints ?? [];
  const stateOf = (tag: string) => cfg.cityPointByTag[tag]?.state ?? null;
  const dists: { d: number; same: boolean }[] = [];
  if (vgraph) {
    for (let i = 0; i < cps.length; i++) {
      for (let j = i + 1; j < cps.length; j++) {
        const d = vdist(vgraph, cps[i].tag, cps[j].tag);
        if (d === null) continue;
        dists.push({ d, same: stateOf(cps[i].tag) === stateOf(cps[j].tag) });
      }
    }
  }
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const same = dists.filter((x) => x.same).map((x) => x.d);
  const cross = dists.filter((x) => !x.same).map((x) => x.d);
  const sameFac: number[] = [];
  const crossFac: number[] = [];
  const maxDist = dists.length ? Math.max(...dists.map((x) => x.d)) : 0;

  return {
    ok: items.every((i) => i.ok),
    items,
    stats: {
      nodeCount,
      edgeCount,
      cellCount: 0,
      components,
      facilityPairs: dists.length,
      avgAll: avg(dists.map((x) => x.d)),
      avgSameCity: avg(same),
      avgCrossCity: avg(cross),
      avgSameFacility: 0,
      avgCrossFacility: 0,
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
  vgraph: VGraph | null,
  hours = 24,
  seed = 20261001,
  opts?: { autoEvents?: boolean },
): SimResult {
  const autoEvents = opts?.autoEvents ?? true;
  const taskIndex: TaskIndex = buildTaskIndex(cfg);
  const ctx: TickCtx = { cfg, graph: undefined, vgraph, taskIndex, online: autoEvents };
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
export function offlineSettle(cfg: GameConfig, vgraph: VGraph | null, awayHours: number, seed = 7): OfflineResult {
  const ctx: TickCtx = { cfg, graph: undefined, vgraph, taskIndex: buildTaskIndex(cfg) };
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
