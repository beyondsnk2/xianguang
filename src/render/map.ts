import { MAP_H, MAP_W } from '../game/constants';
import type { Cell, GameConfig, GameState, MapNodeDef } from '../game/types';
import type { Graph } from '../game/graph';
import { findPath } from '../game/graph';
import { currentCell, pointOnPath } from '../game/tick';
import {
  BG,
  BLOCK,
  DYN,
  FAC_FALLBACK,
  NEUTRAL_BLOCK,
  NODE,
  ROAD,
  SMOOTH,
} from './mapStyle';

const DEBUG_GRID =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debugGrid');

interface Pt {
  x: number;
  y: number;
}

/** 平滑后的曲线：格坐标折线 + 每点的「累计格数」标签（用于 §三 按格进度取点） */
interface SmoothCurve {
  pts: Pt[];
  labels: number[];
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  /** 每格屏幕像素 */
  private s = 30;
  private ox = 0;
  private oy = 0;
  private w = 0;
  private h = 0;
  /** 地图逻辑尺寸，由配置推导（setMapSize 覆盖常量默认值） */
  private mapW = MAP_W;
  private mapH = MAP_H;

  // ── 烘焙缓存（L0–L3） ──
  private cfgKey = '';
  /** 文明区距离场（格）：-1 = 区外 */
  private gf: Int16Array | null = null;
  /** 每格所属州 tag（仅文明区内有效），null = 无 */
  private gstTag: (string | null)[] | null = null;
  /** L1 城块色斑离屏层（低分辨率，缩放时平滑放大） */
  private blockCanvas: HTMLCanvasElement | null = null;
  /** L2 城际曲线（格坐标平滑折线，每帧按当前缩放描边） */
  private roadCurves: SmoothCurve[] = [];
  /** 州名质心（格坐标） */
  private stateCentroids: { name: string; gx: number; gy: number }[] = [];

  /** L0 背景离屏层（按画布尺寸烘焙） */
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgKey = '';
  private bgImg: HTMLImageElement | null = null;
  private bgImgName: string | null = null;
  private bgLoaded = false;

  /** L4 动态路径平滑缓存（按 phase.path 引用缓存，避免逐帧重算） */
  private pathCache = new Map<Cell[], SmoothCurve>();
  /** 节点格中心缓存（格坐标，与缩放无关；按节点引用缓存，避免逐帧重算） */
  private nodeCenters: Map<MapNodeDef, Pt> | null = null;
  /** 设施中文名缓存（按 cfg.tasks 烘焙一次，避免逐帧线性扫描） */
  private facLabels: Map<string, string> | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
    this.resize();
  }

  /** 按配置实际占地设置地图尺寸（V2 起不再是固定 36×30） */
  setMapSize(w: number, h: number): void {
    this.mapW = Math.max(1, w);
    this.mapH = Math.max(1, h);
    // 地图尺寸变化 → 距离场 / 城块 / 曲线 / 州名全部失效
    this.gf = null;
    this.gstTag = null;
    this.blockCanvas = null;
    this.roadCurves = [];
    this.stateCentroids = [];
    this.nodeCenters = null;
    this.facLabels = null;
    this.cfgKey = '';
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bgCanvas = null; // 画布尺寸变化 → 背景重烘
  }

  fit(): void {
    this.s = Math.min(this.w / this.mapW, this.h / this.mapH) * 0.94;
    this.ox = (this.w - this.mapW * this.s) / 2;
    this.oy = (this.h - this.mapH * this.s) / 2;
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

  private px(gx: number): number {
    return this.ox + gx * this.s;
  }
  private py(gy: number): number {
    return this.oy + gy * this.s;
  }

  // ───────────────────────── 烘焙（L0–L3） ─────────────────────────

  /** 惰性烘焙：配置指纹变化时才重算（R3：setMapSize 后惰性触发） */
  private ensureBaked(cfg: GameConfig, graph: Graph): void {
    const key = `${this.mapW}x${this.mapH}|${cfg.meta.setName}@${cfg.meta.version}|${cfg.links.length}|${cfg.states.length}|${cfg.mapBgImg ?? ''}`;
    if (key === this.cfgKey && this.gf) return;
    this.cfgKey = key;
    this.nodeCenters = new Map();
    this.facLabels = new Map();
    for (const t of cfg.tasks ?? []) this.facLabels.set(t.nodeType, t.nodeName);
    this.bakeCivilized(cfg);
    this.bakeBlock(cfg);
    this.roadCurves = this.buildRoads(cfg, graph);
    this.stateCentroids = this.buildStateCentroids(cfg);
    this.loadBg(cfg);
  }

  /** L1 距离场 + 州色场：文明区 = 节点格 ∪ 道路格的 BFS 距离 ≤ R；块并集即大陆 */
  private bakeCivilized(cfg: GameConfig): void {
    const W = this.mapW;
    const H = this.mapH;
    const gf = new Int16Array(W * H).fill(-1);
    const st = new Array<string | null>(W * H).fill(null);
    const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
    const qx: number[] = [];
    const qy: number[] = [];
    let qh = 0;

    // 源：所有节点格 + 道路格
    const seedCell = (x: number, y: number) => {
      if (!inB(x, y)) return;
      const i = y * W + x;
      if (gf[i] === -1) {
        gf[i] = 0;
        qx.push(x);
        qy.push(y);
      }
    };
    for (const n of cfg.nodes) for (const c of n.cells) seedCell(c.x, c.y);
    for (const r of cfg.roads) seedCell(r.cell.x, r.cell.y);

    // 距离场 BFS
    while (qh < qx.length) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;
      const d = gf[y * W + x];
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inB(nx, ny)) continue;
        const i = ny * W + nx;
        if (gf[i] === -1 || gf[i] > d + 1) {
          gf[i] = d + 1;
          qx.push(nx);
          qy.push(ny);
        }
      }
    }

    // 州色场：从城格 BFS，只进入文明区（gf ≤ R）
    const cityNodes = cfg.nodes.filter((n) => n.name === 'city');
    qx.length = 0;
    qy.length = 0;
    qh = 0;
    for (const n of cityNodes) {
      const city = cfg.cityByTag[n.belong ?? ''];
      const tag = city?.state ?? null;
      if (!tag) continue;
      for (const c of n.cells) {
        if (!inB(c.x, c.y)) continue;
        const i = c.y * W + c.x;
        if (st[i] === null) {
          st[i] = tag;
          qx.push(c.x);
          qy.push(c.y);
        }
      }
    }
    while (qh < qx.length) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;
      const tag = st[y * W + x]!;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inB(nx, ny)) continue;
        const i = ny * W + nx;
        if (gf[i] === -1 || gf[i] > BLOCK.civilizedRadius) continue;
        if (st[i] === null) {
          st[i] = tag;
          qx.push(nx);
          qy.push(ny);
        }
      }
    }

    this.gf = gf;
    this.gstTag = st;
  }

  /** L1 城块色斑烘焙（低分辨率离屏，缩放时平滑放大 → 有机边界） */
  private bakeBlock(cfg: GameConfig): void {
    const gf = this.gf;
    const gst = this.gstTag;
    const W = this.mapW;
    const H = this.mapH;
    const BW = BLOCK.bakeW;
    const BH = BLOCK.bakeH;
    const img = new ImageData(BW, BH);
    const d = img.data;

    for (let j = 0; j < BH; j++) {
      for (let i = 0; i < BW; i++) {
        const o = (j * BW + i) * 4;
        // 像素 → 格坐标（domain warp 后采样）
        let gx = (i / BW) * W;
        let gy = (j / BH) * H;
        const [wx, wy] = warp(gx, gy, BLOCK.warpAmp);
        const cxi = Math.round(wx);
        const cyi = Math.round(wy);
        const inB = cxi >= 0 && cyi >= 0 && cxi < W && cyi < H;
        const dist = inB ? gf![cyi * W + cxi] : -1;
        if (dist < 0 || dist > BLOCK.civilizedRadius) {
          d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; // 透出背景
          continue;
        }
        const tag = inB ? gst![cyi * W + cxi] : null;
        const hex = tag ? cfg.stateByTag[tag]?.color ?? NEUTRAL_BLOCK : NEUTRAL_BLOCK;
        let r = parseInt(hex.slice(1, 3), 16);
        let g = parseInt(hex.slice(3, 5), 16);
        let b = parseInt(hex.slice(5, 7), 16);
        // 距离衰减：城心浓、边缘淡
        const t = Math.min(1, dist / BLOCK.civilizedRadius);
        const a = BLOCK.alphaCore + (BLOCK.alphaEdge - BLOCK.alphaCore) * t;
        // 笔触细噪声
        const nz = (fbm(gx * 0.5, gy * 0.5) - 0.5) * 2 * BLOCK.noiseAmp;
        d[o] = clamp255(r + nz);
        d[o + 1] = clamp255(g + nz);
        d[o + 2] = clamp255(b + nz);
        d[o + 3] = Math.round(a * 255);
      }
    }
    const oc = document.createElement('canvas');
    oc.width = BW;
    oc.height = BH;
    oc.getContext('2d')!.putImageData(img, 0, 0);
    this.blockCanvas = oc;
  }

  /** L2 道路：每条 cityLink 跑 findPath 取真实路网路径 → 剪掉城内格、锚定城心 → 平滑 */
  private buildRoads(cfg: GameConfig, graph: Graph): SmoothCurve[] {
    const curves: SmoothCurve[] = [];
    const keyOf = (c: Cell) => c.y * 1000 + c.x;
    for (const link of cfg.links) {
      const A = cfg.cityByTag[link.tagA];
      const B = cfg.cityByTag[link.tagB];
      if (!A || !B) continue;
      const aNode = cfg.nodes.find((n) => n.name === 'city' && n.belong === A.tag);
      const bNode = cfg.nodes.find((n) => n.name === 'city' && n.belong === B.tag);
      if (!aNode || !bNode || !aNode.cells.length || !bNode.cells.length) continue;
      const res = findPath(graph, aNode.cells[0], bNode.cells);
      if (!res || res.cells.length < 2) continue;

      // 剪掉起终点城内格（避免曲线在 2×2 城块内绕角/绕城边设施出钩）
      const inA = new Set(aNode.cells.map(keyOf));
      const inB = new Set(bNode.cells.map(keyOf));
      const cs = res.cells;
      let lo = 0;
      let hi = cs.length - 1;
      while (lo < hi && inA.has(keyOf(cs[lo]))) lo++;
      while (hi > lo && inB.has(keyOf(cs[hi]))) hi--;
      const mid = cs.slice(lo, hi + 1);

      const cA = nodeGridCenter(aNode);
      const cB = nodeGridCenter(bNode);
      const curve: SmoothCurve =
        mid.length >= 2
          ? smoothPath(mid)
          : { pts: [{ x: cs[lo].x + 0.5, y: cs[lo].y + 0.5 }], labels: [0] };
      // 首尾锚定城心（曲线从城郭中心向外辐射，城名下方穿出）
      curve.pts.unshift({ x: cA.x, y: cA.y });
      curve.pts.push({ x: cB.x, y: cB.y });
      curve.labels.unshift(0);
      curve.labels.push(curve.labels[curve.labels.length - 1] + 1);
      curves.push(curve);
    }
    return curves;
  }

  /** L3 州名质心（格坐标），放大前用于大号低对比州名 */
  private buildStateCentroids(cfg: GameConfig): { name: string; gx: number; gy: number }[] {
    const acc = new Map<string, { x: number; y: number; n: number; name: string }>();
    for (const node of cfg.nodes) {
      if (node.name !== 'city') continue;
      const tag = cfg.cityByTag[node.belong ?? '']?.state;
      if (!tag) continue;
      const c = nodeGridCenter(node);
      const e = acc.get(tag) ?? { x: 0, y: 0, n: 0, name: cfg.stateByTag[tag]?.name ?? tag };
      e.x += c.x;
      e.y += c.y;
      e.n++;
      acc.set(tag, e);
    }
    return [...acc.values()].map((e) => ({ name: e.name, gx: e.x / e.n, gy: e.y / e.n }));
  }

  /** L0 背景：mapBgImg 有值 → 加载 cover 铺满 + 压暗；无/失败 → 程序化占位 */
  private loadBg(cfg: GameConfig): void {
    const name = cfg.mapBgImg ?? null;
    this.bgImgName = name;
    this.bgImg = null;
    this.bgLoaded = false;
    if (name) {
      const img = new Image();
      img.onload = () => {
        this.bgImg = img;
        this.bgLoaded = true;
        this.bgCanvas = null; // 触发重烘
      };
      img.onerror = () => {
        this.bgImg = null;
        this.bgLoaded = false;
        this.bgCanvas = null;
      };
      img.src = name.startsWith('/') ? name : `/${name}`;
    }
  }

  /** 当前背景缓存指纹（画布尺寸 + 背景图名 + 加载状态） */
  private bgKeyNow(): string {
    return `${this.w}x${this.h}:${this.bgImgName}:${this.bgLoaded}`;
  }

  /** 烘焙背景到离屏（按当前画布尺寸） */
  private bakeBg(): void {
    const w = this.w;
    const h = this.h;
    const oc = document.createElement('canvas');
    oc.width = w;
    oc.height = h;
    const c = oc.getContext('2d')!;
    if (this.bgLoaded && this.bgImg) {
      // cover 铺满
      const iw = this.bgImg.width;
      const ih = this.bgImg.height;
      const scale = Math.max(w / iw, h / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      c.drawImage(this.bgImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
      c.fillStyle = BG.darken;
      c.fillRect(0, 0, w, h);
    } else {
      // 程序化占位：暗色渐变 + 云纹 + 晕影
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, BG.gradient[0]);
      g.addColorStop(0.5, BG.gradient[1]);
      g.addColorStop(1, BG.gradient[2]);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.globalAlpha = BG.cloudAlpha;
      for (let i = 0; i < BG.cloudSpots; i++) {
        const x = hash2(i, 7) * w;
        const y = hash2(i, 13) * h;
        const r = (60 + hash2(i, 29) * 160) * Math.max(1, w / 1200);
        const rg = c.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, BG.cloudColor);
        rg.addColorStop(1, 'rgba(210,205,180,0)');
        c.fillStyle = rg;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      const v = c.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.3,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.75,
      );
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, BG.vignette);
      c.fillStyle = v;
      c.fillRect(0, 0, w, h);
    }
    this.bgCanvas = oc;
    this.bgKey = this.bgKeyNow();
  }

  // ───────────────────────── 主绘制 ─────────────────────────

  draw(cfg: GameConfig, graph: Graph, state: GameState, nowMs: number): void {
    const ctx = this.ctx;
    const s = this.s;
    this.ensureBaked(cfg, graph);

    if (!this.bgCanvas || this.bgKey !== this.bgKeyNow()) {
      this.bakeBg();
    }

    ctx.save();
    ctx.clearRect(0, 0, this.w, this.h);

    // L0 背景
    if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0, this.w, this.h);

    // L1 城块色斑（缩放平滑放大 → 有机边界）
    if (this.blockCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.blockCanvas, this.px(0), this.py(0), this.mapW * s, this.mapH * s);
      ctx.imageSmoothingQuality = 'low';
    }

    // L2 道路（双层描边，合并 Path2D → 2 次 stroke）
    this.drawRoads();

    // L3 节点
    this.drawNodes(cfg);

    // L4 动态（角色 + 路径）
    this.drawDynamic(state, nowMs);

    // R7 调试网格（校验曲线与格子路径贴合度）
    if (DEBUG_GRID) this.drawDebugGrid(cfg);

    ctx.restore();
  }

  private drawRoads(): void {
    const ctx = this.ctx;
    const s = this.s;
    if (!this.roadCurves.length) return;
    const roadW = Math.max(ROAD.widthMin, s * ROAD.widthK);
    const halo = new Path2D();
    const bright = new Path2D();
    for (const curve of this.roadCurves) {
      const p = curve.pts;
      if (p.length < 2) continue;
      halo.moveTo(this.px(p[0].x), this.py(p[0].y));
      bright.moveTo(this.px(p[0].x), this.py(p[0].y));
      for (let i = 1; i < p.length; i++) {
        halo.lineTo(this.px(p[i].x), this.py(p[i].y));
        bright.lineTo(this.px(p[i].x), this.py(p[i].y));
      }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ROAD.halo;
    ctx.lineWidth = roadW * 1.5;
    ctx.stroke(halo);
    ctx.strokeStyle = ROAD.bright;
    ctx.lineWidth = roadW;
    ctx.stroke(bright);
  }

  private drawNodes(cfg: GameConfig): void {
    const ctx = this.ctx;
    const s = this.s;

    // 州名（放大前显示，低对比大号）
    if (s < NODE.stateNameMaxS) {
      ctx.font = `700 ${Math.max(14, s * 1.8)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(245,239,220,0.16)';
      for (const sc of this.stateCentroids) {
        ctx.fillText(sc.name, this.px(sc.gx), this.py(sc.gy));
      }
    }

    // 设施点（在城下，避免遮挡城名）
    for (const node of cfg.nodes) {
      if (node.name === 'city') continue;
      const c = this.nodeScreenCenter(node);
      const r = Math.max(NODE.facilityDotMin, s * NODE.facilityDotK);
      ctx.fillStyle = NODE.facilityDot;
      ctx.strokeStyle = NODE.facilityDotStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (s > NODE.facilityNameMinS) {
        const label = this.facilityLabel(node.name);
        ctx.font = `${Math.max(9, Math.min(18, s * 0.55))}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, s * 0.1);
        ctx.strokeStyle = 'rgba(8,10,14,0.78)';
        ctx.strokeText(label, c.x, c.y);
        ctx.fillStyle = '#f7f9fc';
        ctx.fillText(label, c.x, c.y);
      }
    }

    // 城郭图标 + 城名
    for (const node of cfg.nodes) {
      if (node.name !== 'city') continue;
      const c = this.nodeScreenCenter(node);
      const name = cfg.cityByTag[node.belong ?? '']?.name ?? '州府';
      this.drawCityGlyph(c.x, c.y, s * NODE.cityGlyphScale, name);
    }
  }

  /** 城郭图标：米白圆角矩形 + 4 垛口 + 中央朱红块 + 黑描边；锚点 = 2×2 中心 */
  private drawCityGlyph(x: number, y: number, s: number, name: string): void {
    const ctx = this.ctx;
    const w = s * NODE.cityGlyphW;
    const h = s * NODE.cityGlyphH;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = 'rgba(10,8,4,0.6)';
    ctx.shadowBlur = s * 0.5;
    ctx.shadowOffsetY = s * 0.15;
    ctx.fillStyle = NODE.cityFill;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    const t = w / 7;
    for (let i = 0; i < 4; i++) ctx.fillRect(-w / 2 + i * t * 2, -h / 2 - t * 0.9, t, t * 0.9);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = NODE.cityStroke;
    ctx.lineWidth = Math.max(0.8, s * 0.07);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = NODE.cityCore;
    ctx.fillRect(-w * 0.18, -h * 0.15, w * 0.36, h * 0.35);
    ctx.restore();

    if (s > NODE.cityNameMinS) {
      ctx.font = `600 ${Math.max(10, Math.min(16, s * 0.95))}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,16,10,0.75)';
      ctx.strokeText(name, x, y + h * 0.75);
      ctx.fillStyle = '#F5EFDC';
      ctx.fillText(name, x, y + h * 0.75);
    }
  }

  private drawDynamic(state: GameState, nowMs: number): void {
    const ctx = this.ctx;
    const s = this.s;
    const phase = state.phase;

    // 角色锚点（格坐标）
    let charGrid: Pt;

    if (phase.kind === 'moving' || phase.kind === 'returning') {
      const path = phase.path;
      const sc = this.getSmooth(path);
      const L = path.length;
      const progress = phase.total > 0 ? Math.min(1, Math.max(0, 1 - phase.remain / phase.total)) : 1;
      const g = progress * (L - 1);
      const bright = phase.kind === 'returning' ? DYN.returningBright : DYN.movingBright;
      const base = phase.kind === 'returning' ? DYN.returningBase : DYN.movingBase;
      this.drawPhasePath(sc, g, bright, base);

      // 目的地靶标（path 末端，与角色标记造型区分开）
      const end = sc.pts[sc.pts.length - 1];
      this.drawDestination(end.x, end.y, bright, nowMs);

      charGrid = charOnCurve(sc, g);
    } else {
      const c = currentCell(state);
      charGrid = { x: c.x + 0.5, y: c.y + 0.5 };
    }

    const cx = this.px(charGrid.x);
    const cy = this.py(charGrid.y);
    const r = Math.max(DYN.charRadiusMin, s * DYN.charRadiusK);
    const ping = phase.kind === 'working' ? 'rgba(240,200,116,' : 'rgba(120,200,255,';

    // (2) 对比光晕：径向渐变暖白光晕（任意背景上都把角色托起来）
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * DYN.charGlowK);
    glow.addColorStop(0, DYN.charGlow);
    glow.addColorStop(1, 'rgba(245,247,251,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * DYN.charGlowK, 0, Math.PI * 2);
    ctx.fill();

    // (1) 定位脉冲环：呼吸圈 + 向外扩散圈（始终画在当前位置，最抓眼）
    const period = DYN.charPingPeriod;
    const t = (nowMs % period) / period; // 0..1 扩散进度
    const breathe = 0.5 + 0.5 * Math.sin((nowMs / period) * Math.PI * 2);
    ctx.lineWidth = Math.max(1.2, s * 0.06);
    ctx.strokeStyle = `${ping}${0.4 + 0.35 * breathe})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r * DYN.charPingBaseK * (0.9 + 0.15 * breathe), 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.strokeStyle = `${ping}${(1 - t) * 0.5})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (DYN.charPingBaseK + (DYN.charPingSpreadK - DYN.charPingBaseK) * t), 0, Math.PI * 2);
    ctx.stroke();

    // 锚定实环（steady 蓝环）：让当前位置“锁住”始终清晰可辨
    ctx.strokeStyle = `${ping}0.9)`;
    ctx.lineWidth = Math.max(1.5, s * 0.08);
    ctx.beginPath();
    ctx.arc(cx, cy, r * DYN.charAnchorK, 0, Math.PI * 2);
    ctx.stroke();

    // (3) 角色本体：深色描边衬底 → 白点 → 中心点（保证任意底色下勾出轮廓、最上层）
    ctx.fillStyle = DYN.charOutline;
    ctx.beginPath();
    ctx.arc(cx, cy, r * DYN.charOutlineK, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5f7fb';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = DYN.charOutline;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 目的地靶标：与角色标记造型区分，强化“这是目的地”语义（外圈脉冲 + 内圈 + 中心实心 + 十字准星） */
  private drawDestination(gx: number, gy: number, color: string, nowMs: number): void {
    const ctx = this.ctx;
    const s = this.s;
    const cx = this.px(gx);
    const cy = this.py(gy);
    const base = Math.max(7, s * 0.55);
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 350);

    // 外圈脉冲（柔和呼吸）
    ctx.globalAlpha = 0.45 + 0.4 * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, s * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, base * (1.0 + 0.12 * pulse), 0, Math.PI * 2);
    ctx.stroke();

    // 内圈 + 中心实心点（靶心）
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, s * 0.05);
    ctx.beginPath();
    ctx.arc(cx, cy, base * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, s * 0.12), 0, Math.PI * 2);
    ctx.fill();

    // 十字准星（4 个短刻度），明确“目标/落点”
    const tick0 = base * 0.72;
    const tick1 = base * 1.25;
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      ctx.moveTo(cx + dx * tick0, cy + dy * tick0);
      ctx.lineTo(cx + dx * tick1, cy + dy * tick1);
    }
    ctx.stroke();
  }

  /** 当前路径：已走段暗色铺底，剩余段亮色（按 §三 格进度切分） */
  private drawPhasePath(sc: SmoothCurve, g: number, bright: string, base: string): void {
    const ctx = this.ctx;
    const s = this.s;
    const { pts } = sc;
    if (pts.length < 2) return;
    const roadW = Math.max(2, s * ROAD.widthK);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 已走段（整条铺底）
    ctx.strokeStyle = base;
    ctx.lineWidth = roadW;
    ctx.beginPath();
    ctx.moveTo(this.px(pts[0].x), this.py(pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this.px(pts[i].x), this.py(pts[i].y));
    ctx.stroke();

    // 剩余段（亮色）：在 g 处切分
    const { k, bx, by } = splitCurve(sc, g);
    // 剩余段（亮色 + 微光 + 略粗）：与暖米色道路强反差，浮于路网之上
    ctx.save();
    ctx.shadowColor = bright;
    ctx.shadowBlur = Math.max(3, s * 0.25);
    ctx.strokeStyle = bright;
    ctx.lineWidth = Math.max(roadW + 1, s * 0.22);
    ctx.beginPath();
    ctx.moveTo(this.px(bx), this.py(by));
    for (let i = k + 1; i < pts.length; i++) ctx.lineTo(this.px(pts[i].x), this.py(pts[i].y));
    ctx.stroke();
    ctx.restore();
  }

  private drawDebugGrid(cfg: GameConfig): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,80,80,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.mapW; x++) {
      ctx.moveTo(Math.round(this.px(x)) + 0.5, this.py(0));
      ctx.lineTo(Math.round(this.px(x)) + 0.5, this.py(this.mapH));
    }
    for (let y = 0; y <= this.mapH; y++) {
      ctx.moveTo(this.px(0), Math.round(this.py(y)) + 0.5);
      ctx.lineTo(this.px(this.mapW), Math.round(this.py(y)) + 0.5);
    }
    ctx.stroke();
    // 格心点（节点格 / 道路格）
    ctx.fillStyle = 'rgba(255,80,80,0.5)';
    const dot = (x: number, y: number) => {
      ctx.beginPath();
      ctx.arc(this.px(x + 0.5), this.py(y + 0.5), 1.2, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const n of cfg.nodes) for (const c of n.cells) dot(c.x, c.y);
    for (const r of cfg.roads) dot(r.cell.x, r.cell.y);
  }

  // ───────────────────────── 工具 ─────────────────────────

  private nodeCenter(node: MapNodeDef): Pt {
    let m = this.nodeCenters;
    if (!m) { m = new Map(); this.nodeCenters = m; }
    let c = m.get(node);
    if (!c) { c = nodeGridCenter(node); m.set(node, c); }
    return c;
  }

  private nodeScreenCenter(node: MapNodeDef): Pt {
    const c = this.nodeCenter(node);
    return { x: this.px(c.x), y: this.py(c.y) };
  }

  /** 设施中文名（优先配置 tasks 表 nodeName，兜底 FAC_FALLBACK；已烘焙进 facLabels） */
  private facilityLabel(name: string): string {
    return this.facLabels?.get(name) ?? FAC_FALLBACK[name] ?? name;
  }

  /** L4 动态路径平滑（按引用缓存） */
  private getSmooth(path: Cell[]): SmoothCurve {
    let sc = this.pathCache.get(path);
    if (!sc) {
      sc = smoothPath(path);
      if (this.pathCache.size > 32) this.pathCache.clear();
      this.pathCache.set(path, sc);
    }
    return sc;
  }

  /** 供外部画「预计路径」用（按钮 hover 等） */
  pointAt(path: Cell[], progress: number): Cell | null {
    return pointOnPath(path, progress);
  }
}

// ════════════════════ 模块级纯函数（噪声 / 平滑 / 几何） ════════════════════

const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    sum += vnoise(x * f, y * f) * amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

/** domain warp：采样前加低频噪声位移（fbm 2~3 octave） */
function warp(x: number, y: number, amt: number): [number, number] {
  return [
    x + (fbm(x * BLOCK.warpFreq, y * BLOCK.warpFreq) - 0.5) * amt,
    y + (fbm(x * BLOCK.warpFreq + 37, y * BLOCK.warpFreq + 53) - 0.5) * amt,
  ];
}

/** 节点外接矩形中心（格坐标）：1 格 → 格心；2×2 → 块心 */
export function nodeGridCenter(node: MapNodeDef): Pt {
  const xs = node.cells.map((c) => c.x);
  const ys = node.cells.map((c) => c.y);
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  return { x: x1 + (Math.max(...xs) - x1 + 1) / 2, y: y1 + (Math.max(...ys) - y1 + 1) / 2 };
}

function douglasPeucker(pts: Pt[], eps: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const pa = pts[a];
    const pb = pts[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - pa.x) * dy - (pts[i].y - pa.y) * dx) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx]);
      stack.push([idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, u: number): Pt {
  const u2 = u * u;
  const u3 = u2 * u;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * u +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * u +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
  };
}

/**
 * 路径平滑（L2 / L4 共用）：
 * 格序列 → Douglas-Peucker 去共线 → 法向低幅弯曲 → Catmull-Rom 采样。
 * 返回密集折线 + 每点「累计格数」标签（原序列下标），供 §三 按格进度取点。
 */
export function smoothPath(cells: Cell[]): SmoothCurve {
  const L = cells.length;
  if (L === 0) return { pts: [], labels: [] };
  if (L === 1) return { pts: [{ x: cells[0].x + 0.5, y: cells[0].y + 0.5 }], labels: [0] };

  const P: Pt[] = cells.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }));
  const keep = douglasPeucker(P, SMOOTH.dpTolerance);

  // 合并过近的保留点：控制点间距过短时 Catmull-Rom 会过冲成环
  const Q: Pt[] = [];
  const qi: number[] = [];
  for (const i of keep) {
    const p = P[i];
    const last = Q[Q.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < SMOOTH.minCtrlDist) continue;
    Q.push(p);
    qi.push(i);
  }
  // 末端必须保留（角色取点依赖终点标签）
  if (qi[qi.length - 1] !== L - 1) {
    Q.push(P[L - 1]);
    qi.push(L - 1);
  }
  if (Q.length < 2) return { pts: [P[0], P[L - 1]], labels: [0, L - 1] };

  // 法向弯曲（默认关闭，见 SMOOTH.bendAmp）：仅当开启且相邻段足够长时施加，
  // 相位取自格位置而非点序，保证共享走廊的曲线获得一致偏移、互不穿插
  if (SMOOTH.bendAmp > 0) {
    for (let j = 1; j < Q.length - 1; j++) {
      const p0 = Q[j - 1];
      const p1 = Q[j];
      const p2 = Q[j + 1];
      const lenPrev = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const lenNext = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const len = Math.min(lenPrev, lenNext);
      if (len < 1.2) continue;
      const amp = Math.min(SMOOTH.bendAmp, len * 0.18);
      const dx = p2.x - p0.x;
      const dy = p2.y - p0.y;
      const dl = Math.hypot(dx, dy) || 1;
      const ph = Math.sin(p1.x * 1.3 + p1.y * 0.9);
      Q[j] = { x: p1.x + (-dy / dl) * amp * ph, y: p1.y + (dx / dl) * amp * ph };
    }
  }

  const pts: Pt[] = [];
  const labels: number[] = [];
  const n = Q.length;
  const get = (i: number) => Q[Math.max(0, Math.min(n - 1, i))];
  for (let j = 0; j < n - 1; j++) {
    const p0 = get(j - 1);
    const p1 = Q[j];
    const p2 = Q[j + 1];
    const p3 = get(j + 2);
    const a = qi[j];
    const b = qi[j + 1];
    if (j === 0) {
      pts.push(p1);
      labels.push(a);
    }
    for (let t = 1; t <= SMOOTH.catmullSteps; t++) {
      const u = t / SMOOTH.catmullSteps;
      pts.push(catmull(p0, p1, p2, p3, u));
      labels.push(a + (b - a) * u);
    }
  }
  return { pts, labels };
}

/** §三 取点：按格进度 g 在平滑曲线上插值（非弧长均匀），返回格坐标 */
function charOnCurve(sc: SmoothCurve, g: number): Pt {
  if (sc.pts.length === 1) return sc.pts[0];
  const { bx, by } = splitCurve(sc, g);
  return { x: bx, y: by };
}

/** 在平滑曲线上按格进度 g 切分，返回分段索引 k 与切点 bx/by（drawPhasePath 与 charOnCurve 共用） */
function splitCurve(sc: SmoothCurve, g: number): { k: number; bx: number; by: number } {
  const { pts, labels } = sc;
  let k = 0;
  while (k < labels.length - 1 && labels[k + 1] <= g) k++;
  const frac = labels[k + 1] > labels[k] ? (g - labels[k]) / (labels[k + 1] - labels[k]) : 0;
  return { k, bx: pts[k].x + (pts[k + 1].x - pts[k].x) * frac, by: pts[k].y + (pts[k + 1].y - pts[k].y) * frac };
}


