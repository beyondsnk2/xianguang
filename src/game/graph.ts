import type { Cell, GameConfig } from './types';

export interface GraphNode {
  id: number;
  kind: 'facility' | 'road';
  tag: number;
  name: string;
  belong: string | null;
  cells: Cell[];
}

export interface Graph {
  nodes: GraphNode[];
  /** ⚠ 仅设施/州府（mapNode.tag 1–16）。道路格 tag 也是数字且与之重叠，不可混用 */
  nodeByTag: Map<number, GraphNode>;
  roadByTag: Map<number, GraphNode>;
  cells: Cell[];
  /** key = y * 1000 + x → cellId */
  cellIdByKey: Map<number, number>;
  /** cellId → nodeId */
  nodeOfCell: number[];
  adj: number[][];
  cost: number[][];
  /** 节点级邻接（用于核对「96 点 97 边」） */
  nodeAdj: Set<number>[];
}

/** roadType → 每格移动成本（沿用开发文档：预留扩展，现全为 plain） */
const ROAD_TYPE_COST: Record<string, number> = { plain: 1, official: 1 };
const DEFAULT_ROAD_COST = 1;

export const cellKey = (c: Cell): number => c.y * 1000 + c.x;

export function buildGraph(cfg: GameConfig): Graph {
  const nodes: GraphNode[] = [];

  // 设施 / 州府（多格合并为一个超节点，内部移动成本 0）
  for (const n of cfg.nodes) {
    nodes.push({ id: nodes.length, kind: 'facility', tag: n.tag, name: n.name, belong: n.belong, cells: n.cells.slice() });
  }
  // 道路格（逐格，每格一个节点）
  for (const r of cfg.roads) {
    nodes.push({ id: nodes.length, kind: 'road', tag: r.tag, name: r.name, belong: null, cells: [r.cell] });
  }

  const cells: Cell[] = [];
  const cellIdByKey = new Map<number, number>();
  const nodeOfCell: number[] = [];
  const roadCostOfCell: number[] = [];
  nodes.forEach((node, nodeId) => {
    for (const c of node.cells) {
      const k = cellKey(c);
      if (cellIdByKey.has(k)) continue; // 理论上不会重叠
      const id = cells.length;
      cells.push(c);
      cellIdByKey.set(k, id);
      nodeOfCell.push(nodeId);
      roadCostOfCell.push(node.kind === 'road' ? (ROAD_TYPE_COST[roadTypeOf(cfg, node.tag)] ?? DEFAULT_ROAD_COST) : DEFAULT_ROAD_COST);
    }
  });

  // 四邻域连边：同节点内 cost = 0，跨节点 cost = 目标格成本
  const adj: number[][] = cells.map(() => []);
  const cost: number[][] = cells.map(() => []);
  const nodeAdj: Set<number>[] = nodes.map(() => new Set<number>());
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let id = 0; id < cells.length; id++) {
    const c = cells[id];
    for (const [dx, dy] of dirs) {
      const nb = cellIdByKey.get(cellKey({ x: c.x + dx, y: c.y + dy }));
      if (nb === undefined) continue;
      const sameNode = nodeOfCell[id] === nodeOfCell[nb];
      adj[id].push(nb);
      cost[id].push(sameNode ? 0 : roadCostOfCell[nb]);
      if (!sameNode) {
        nodeAdj[nodeOfCell[id]].add(nodeOfCell[nb]);
        nodeAdj[nodeOfCell[nb]].add(nodeOfCell[id]);
      }
    }
  }

  // mapNode.tag(1–16) 与 mapRoad.tag(1–80) 都是数字，必须分表索引，绝不能混用
  const nodeByTag = new Map<number, GraphNode>();
  const roadByTag = new Map<number, GraphNode>();
  for (const n of nodes) {
    if (n.kind === 'facility') nodeByTag.set(n.tag, n);
    else roadByTag.set(n.tag, n);
  }

  return { nodes, nodeByTag, roadByTag, cells, cellIdByKey, nodeOfCell, adj, cost, nodeAdj };
}

function roadTypeOf(cfg: GameConfig, roadTag: number): string {
  const r = cfg.roads.find((x) => x.tag === roadTag);
  return r?.roadType ?? 'plain';
}

export interface PathResult {
  cells: Cell[];
  /** 总格数（跨节点步数，州府内部移动为 0） */
  cost: number;
}

/**
 * Dijkstra 最短路（**禁止用曼哈顿距离估算**）。
 * @param from 起点格
 * @param targets 终点候选格（设施多格时任取一格即算到达）
 */
export function findPath(g: Graph, from: Cell, targets: Cell[]): PathResult | null {
  const startId = g.cellIdByKey.get(cellKey(from));
  if (startId === undefined) return null;
  const targetIds = targets.map((c) => g.cellIdByKey.get(cellKey(c))).filter((v): v is number => v !== undefined);
  if (!targetIds.length) return null;

  const n = g.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[startId] = 0;

  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = 1;
    const au = g.adj[u];
    const cu = g.cost[u];
    for (let k = 0; k < au.length; k++) {
      const v = au[k];
      const nd = dist[u] + cu[k];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }

  let endId = -1;
  let bestCost = Infinity;
  for (const t of targetIds) {
    if (dist[t] < bestCost) {
      bestCost = dist[t];
      endId = t;
    }
  }
  if (endId < 0 || !Number.isFinite(bestCost)) return null;

  const path: Cell[] = [];
  for (let cur = endId; cur !== -1; cur = prev[cur]) {
    path.push(g.cells[cur]);
    if (cur === startId) break;
  }
  path.reverse();
  return { cells: path, cost: bestCost };
}

/** 从某格走到指定节点（设施多格时取最近的一格） */
export function pathToNode(g: Graph, from: Cell, nodeTag: number): PathResult | null {
  const node = g.nodeByTag.get(nodeTag);
  if (!node) return null;
  return findPath(g, from, node.cells);
}

/** 从某格走到「最近的州府」 */
export function pathToNearestCity(g: Graph, from: Cell): { path: PathResult; nodeTag: number } | null {
  let best: { path: PathResult; nodeTag: number } | null = null;
  for (const node of g.nodes) {
    if (node.name !== 'city') continue;
    const p = pathToNode(g, from, node.tag);
    if (!p) continue;
    if (!best || p.cost < best.path.cost) best = { path: p, nodeTag: node.tag };
  }
  return best;
}

/** 节点两两最短路（用于自检对拍） */
export function nodeDistance(g: Graph, fromTag: number, toTag: number): number | null {
  const a = g.nodeByTag.get(fromTag);
  const b = g.nodeByTag.get(toTag);
  if (!a || !b || !a.cells.length || !b.cells.length) return null;
  const p = findPath(g, a.cells[0], b.cells);
  return p ? p.cost : null;
}
