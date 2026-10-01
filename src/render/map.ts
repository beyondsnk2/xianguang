import { CELL_PX, MAP_H, MAP_W } from '../game/constants';
import type { Cell, GameConfig, GameState } from '../game/types';
import type { Graph } from '../game/graph';
import { currentCell, pointOnPath } from '../game/tick';

const NODE_COLORS: Record<string, string> = {
  city: '#d9a441',
  barrack: '#c0553b',
  market: '#4f9d69',
  farmland: '#8fae4a',
  tavern: '#b06ab3',
  academy: '#4a8fae',
  mine: '#8a8f9c',
};

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  /** 每格屏幕像素 */
  private s = CELL_PX;
  private ox = 0;
  private oy = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  fit(): void {
    this.s = Math.min(this.w / MAP_W, this.h / MAP_H) * 0.94;
    this.ox = (this.w - MAP_W * this.s) / 2;
    this.oy = (this.h - MAP_H * this.s) / 2;
  }

  zoom(factor: number, cx = this.w / 2, cy = this.h / 2): void {
    const before = this.s;
    this.s = Math.min(120, Math.max(6, this.s * factor));
    const k = this.s / before;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
  }

  pan(dx: number, dy: number): void {
    this.ox += dx;
    this.oy += dy;
  }

  private px(cx: number): number {
    return this.ox + cx * this.s;
  }
  private py(cy: number): number {
    return this.oy + cy * this.s;
  }

  draw(cfg: GameConfig, graph: Graph, state: GameState, nowMs: number): void {
    const ctx = this.ctx;
    const s = this.s;
    ctx.save();
    ctx.fillStyle = '#0e1015';
    ctx.fillRect(0, 0, this.w, this.h);

    // 地图底板
    ctx.fillStyle = '#141821';
    ctx.fillRect(this.px(0), this.py(0), MAP_W * s, MAP_H * s);

    // 网格
    ctx.strokeStyle = '#1b2030';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= MAP_W; x++) {
      ctx.moveTo(Math.round(this.px(x)) + 0.5, this.py(0));
      ctx.lineTo(Math.round(this.px(x)) + 0.5, this.py(MAP_H));
    }
    for (let y = 0; y <= MAP_H; y++) {
      ctx.moveTo(this.px(0), Math.round(this.py(y)) + 0.5);
      ctx.lineTo(this.px(MAP_W), Math.round(this.py(y)) + 0.5);
    }
    ctx.stroke();

    // 道路格
    ctx.fillStyle = '#33384a';
    for (const node of graph.nodes) {
      if (node.kind !== 'road') continue;
      for (const c of node.cells) {
        ctx.fillRect(this.px(c.x) + 1, this.py(c.y) + 1, s - 2, s - 2);
      }
    }

    // 设施 / 州府
    for (const node of graph.nodes) {
      if (node.kind !== 'facility') continue;
      const color = NODE_COLORS[node.name] ?? '#7a7f8a';
      const box = nodeBox(node.cells); // {x1,y1,w,h}
      ctx.fillStyle = color;
      if (box.w > 1 || box.h > 1) {
        // 多格节点（州府 2×2）整块填充：中间不留网格线
        ctx.fillRect(this.px(box.x1), this.py(box.y1), box.w * s, box.h * s);
      } else {
        ctx.fillRect(this.px(box.x1) + 1, this.py(box.y1) + 1, s - 2, s - 2);
      }

      // 名称：只取第一个汉字，居中显示在格子里
      const scx = this.px(box.x1 + box.w / 2);
      const scy = this.py(box.y1 + box.h / 2);
      if (s >= 12) {
        const full = nodeLabel(cfg, node.name, node.belong);
        // 州府 2×2 显示全称，单格设施只取第一个汉字
        const label = node.name === 'city' ? full : firstChar(full);
        const size = Math.max(9, Math.min(40, (box.w * s * 0.85) / label.length, box.h * s * 0.55));
        ctx.font = `${Math.round(size)}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, s * 0.12);
        ctx.strokeStyle = 'rgba(8,10,14,0.78)';
        ctx.strokeText(label, scx, scy);
        ctx.fillStyle = '#f7f9fc';
        ctx.fillText(label, scx, scy);
      }
      // 州府外框
      if (node.name === 'city') {
        ctx.strokeStyle = '#f0c874';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.px(box.x1) + 1, this.py(box.y1) + 1, box.w * s - 2, box.h * s - 2);
      }
    }

    // 当前路径
    const phase = state.phase;
    if (phase.kind === 'moving' || phase.kind === 'returning') {
      const path = phase.path;
      const progress = phase.total > 0 ? Math.min(1, Math.max(0, 1 - phase.remain / phase.total)) : 1;
      ctx.lineWidth = Math.max(2, s * 0.16);
      ctx.lineCap = 'round';
      ctx.strokeStyle = phase.kind === 'returning' ? 'rgba(95,179,122,0.55)' : 'rgba(217,164,65,0.5)';
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const c = path[i];
        const x = this.px(c.x + 0.5);
        const y = this.py(c.y + 0.5);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 剩余路段
      const startIdx = Math.min(path.length - 1, Math.floor(progress * (path.length - 1)));
      ctx.strokeStyle = phase.kind === 'returning' ? '#5fb37a' : '#f0c874';
      ctx.beginPath();
      for (let i = startIdx; i < path.length; i++) {
        const c = path[i];
        const x = this.px(c.x + 0.5);
        const y = this.py(c.y + 0.5);
        if (i === startIdx) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 目标点标记
      const target = path[path.length - 1];
      ctx.strokeStyle = phase.kind === 'returning' ? '#5fb37a' : '#f0c874';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.px(target.x + 0.5), this.py(target.y + 0.5), s * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 角色
    const pos = currentCell(state);
    const r = Math.max(3, s * 0.32);
    const cx = this.px(pos.x + 0.5);
    const cy = this.py(pos.y + 0.5);
    if (phase.kind === 'working') {
      const pulse = 0.5 + 0.5 * Math.sin(nowMs / 300);
      ctx.strokeStyle = `rgba(240,200,116,${0.25 + 0.5 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.4 + 0.5 * pulse), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#f5f7fb';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1a1d24';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
  }

  /** 供外部画「预计路径」用（按钮 hover 等） */
  pointAt(path: Cell[], progress: number): Cell | null {
    return pointOnPath(path, progress);
  }
}

export interface NodeBox {
  x1: number;
  y1: number;
  w: number;
  h: number;
}

/** 节点占地的外接矩形（连续坐标）：1 格设施 → 1×1，州府 → 2×2 */
export function nodeBox(cells: Cell[]): NodeBox {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  return { x1, y1, w: Math.max(...xs) - x1 + 1, h: Math.max(...ys) - y1 + 1 };
}

/** 名称只取第一个汉字：兵营→兵，上庸→上 */
export function firstChar(text: string): string {
  return [...text][0] ?? text;
}

function nodeLabel(cfg: GameConfig, name: string, belong: string | null): string {
  if (name === 'city') return cfg.cityByTag[belong ?? '']?.name ?? '州府';
  const def = cfg.tasks.find((t) => t.nodeType === name);
  return def?.nodeName ?? name;
}
