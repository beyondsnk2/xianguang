/**
 * 向量地图图（V-Point）：城市/拐点作为离散坐标节点，道路为几何折线（非格子）。
 * 与格子真相模型（graph.ts / buildGraph / findPath）完全并存——xlsx 配置走格子，
 * ?pointmap 配置走本向量图。Dijkstra 在节点图上跑，返回真实几何折线 + 欧氏距离，
 * 因此「显示直线 = 角色移动 = 玩法距离」三者天然统一，且无栅格化损耗。
 */

import type { Cell, GameConfig } from './types';

export interface VNode {
  id: string;
  x: number;
  y: number;
  kind: 'city' | 'waypoint';
}

export interface VEdge {
  to: string;
  /** 本节点 → to 的折线几何（含两端点，坐标空间浮点） */
  geom: Cell[];
}

export interface VGraph {
  nodes: Map<string, VNode>;
  adj: Map<string, VEdge[]>;
  bounds: { w: number; h: number };
}

export interface VPath {
  /** 含起点与终点的完整折线（坐标空间浮点） */
  points: Cell[];
  /** 折线欧氏总长 = 角色移动距离 = 玩法距离 */
  cost: number;
}

/** 由 GameConfig 的向量层构建图；无向量层返回 null（调用方回退格子图） */
export function buildVGraph(cfg: GameConfig): VGraph | null {
  if (!cfg.cityPoints.length && !cfg.waypoints.length) return null;
  const nodes = new Map<string, VNode>();
  for (const c of cfg.cityPoints) nodes.set(c.tag, { id: c.tag, x: c.x, y: c.y, kind: 'city' });
  for (const w of cfg.waypoints) nodes.set(w.tag, { id: w.tag, x: w.x, y: w.y, kind: 'waypoint' });

  const adj = new Map<string, VEdge[]>();
  const ensure = (id: string): VEdge[] => {
    let e = adj.get(id);
    if (!e) {
      e = [];
      adj.set(id, e);
    }
    return e;
  };

  for (const rl of cfg.roadLines) {
    const [a, b] = rl.refs;
    if (!nodes.has(a) || !nodes.has(b)) continue; // 引用了未知节点
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    const pts =
      rl.points && rl.points.length >= 2
        ? rl.points.map((p) => ({ x: p.x, y: p.y }))
        : [
            { x: na.x, y: na.y },
            { x: nb.x, y: nb.y },
          ];
    ensure(a).push({ to: b, geom: pts });
    ensure(b).push({ to: a, geom: pts.slice().reverse().map((p) => ({ x: p.x, y: p.y })) });
  }

  const xs = [...nodes.values()].map((n) => n.x);
  const ys = [...nodes.values()].map((n) => n.y);
  const bounds = {
    w: Math.max(1, ...xs.map((x) => x)),
    h: Math.max(1, ...ys.map((y) => y)),
  };
  return { nodes, adj, bounds };
}

function segLen(pts: Cell[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return s;
}

/** 节点间最短几何路径（Dijkstra，O(V²)，节点数为城市+拐点，几十~几百足够） */
export function vfindPath(g: VGraph, fromId: string, toId: string): VPath | null {
  if (!g.nodes.has(fromId) || !g.nodes.has(toId)) return null;
  if (fromId === toId) {
    const n = g.nodes.get(fromId)!;
    return { points: [{ x: n.x, y: n.y }], cost: 0 };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; geom: Cell[] }>();
  for (const id of g.nodes.keys()) dist.set(id, Infinity);
  dist.set(fromId, 0);
  const visited = new Set<string>();

  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        u = id;
      }
    }
    if (u === null) break;
    if (u === toId) break;
    visited.add(u);
    for (const e of g.adj.get(u) ?? []) {
      const nd = best + segLen(e.geom);
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: u, geom: e.geom });
      }
    }
  }

  if (!prev.has(toId)) return null;
  const geoms: Cell[][] = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    if (!p) return null;
    geoms.push(p.geom);
    cur = p.from;
  }
  geoms.reverse();

  const pts: Cell[] = [];
  for (const g2 of geoms) {
    if (!pts.length) pts.push(...g2);
    else pts.push(...g2.slice(1)); // 跳过共享端点，避免重复
  }
  return { points: pts, cost: dist.get(toId) ?? Infinity };
}

export function vdist(g: VGraph, a: string, b: string): number | null {
  const p = vfindPath(g, a, b);
  return p ? p.cost : null;
}

/** 最近节点（城市或拐点），用于从当前浮点坐标出发寻路 */
export function nearestNodeId(g: VGraph, pos: Cell): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of g.nodes.values()) {
    const d = Math.hypot(n.x - pos.x, n.y - pos.y);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

/** 从任意浮点坐标出发到指定城市的最短几何路径（自动吸附到最近节点） */
export function vpathFromPoint(g: VGraph, from: Cell, toId: string): VPath | null {
  const start = nearestNodeId(g, from);
  if (!start) return null;
  const p = vfindPath(g, start, toId);
  if (!p) return null;
  const lead = Math.hypot(from.x - p.points[0].x, from.y - p.points[0].y);
  return { points: [{ x: from.x, y: from.y }, ...p.points], cost: p.cost + lead };
}

/** 到最近城市的路径（用于背包满自动回城） */
export function vpathToNearestCity(g: VGraph, from: Cell): VPath | null {
  let target: string | null = null;
  let bestD = Infinity;
  for (const n of g.nodes.values()) {
    if (n.kind !== 'city') continue;
    const d = Math.hypot(n.x - from.x, n.y - from.y);
    if (d < bestD) {
      bestD = d;
      target = n.id;
    }
  }
  if (!target) return null;
  return vpathFromPoint(g, from, target);
}
