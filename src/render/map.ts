import type { Cell, GameConfig, GameState } from '../game/types';
import { currentCell, pointOnPath } from '../game/tick';
import {
  BG,
  DYN,
  NODE,
  ROAD,
} from './mapStyle';
import { bgImageRect } from '../shared/bgGeom';

const DEBUG_GRID =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debugGrid');

interface Pt {
  x: number;
  y: number;
}

/** 平滑后的曲线：坐标空间折线 + 每点的点序号标签（用于按路径进度取点） */
interface SmoothCurve {
  pts: Pt[];
  labels: number[];
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  /** 每坐标单位的屏幕像素 */
  private s = 30;
  private ox = 0;
  private oy = 0;
  private w = 0;
  private h = 0;
  /** 地图逻辑尺寸（坐标空间），由配置 mapBounds 推导（setMapSize 覆盖初始占位） */
  private mapW = 1;
  private mapH = 1;

  // ── 烘焙缓存（L0–L2） ──
  private cfgKey = '';
  /** L2 城际曲线（坐标空间折线，每帧按当前缩放描边） */
  private roadCurves: SmoothCurve[] = [];

  /** L0 程序化占位离屏层（按画布尺寸烘焙；bg1 图可用时不走此路） */
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgKey = '';
  private bgImg: HTMLImageElement | null = null;
  private bgImgName: string | null = null;
  private bgLoaded = false;

  /** L4 动态路径平滑缓存（按 phase.path 引用缓存，避免逐帧重算） */
  private pathCache = new Map<Cell[], SmoothCurve>();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
    this.resize();
  }

  /** 按配置实际占地设置地图尺寸（坐标空间，由 mapBounds 给出） */
  setMapSize(w: number, h: number): void {
    this.mapW = Math.max(1, w);
    this.mapH = Math.max(1, h);
    // 地图尺寸变化 → 曲线缓存失效（去州化：无州分区色块/州名）
    this.roadCurves = [];
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

  /** 悬停命中半径（像素）：城郭 glyph 固定 13px，取略大值容错 */
  private static readonly CITY_HIT_R = 14;

  /**
   * 屏幕坐标 → 城市 tag；无命中返回 null。
   * 按 glyph 中心距离就近命中（坐标模式唯一口径）。
   */
  hitCity(sx: number, sy: number, cfg: GameConfig): string | null {
    const r = MapRenderer.CITY_HIT_R;
    let best: string | null = null;
    let bestD = r;
    for (const cp of cfg.cityPoints) {
      const d = Math.hypot(this.px(cp.x) - sx, this.py(cp.y) - sy);
      if (d < bestD) {
        bestD = d;
        best = cp.tag;
      }
    }
    return best;
  }

  /** 城市 tag → 屏幕坐标（popover 锚点用）；找不到返回 null */
  cityScreenPos(cfg: GameConfig, tag: string): Pt | null {
    const cp = cfg.cityPointByTag[tag];
    return cp ? { x: this.px(cp.x), y: this.py(cp.y) } : null;
  }

  private px(gx: number): number {
    return this.ox + gx * this.s;
  }
  private py(gy: number): number {
    return this.oy + gy * this.s;
  }

  // ───────────────────────── 烘焙（L0–L3） ─────────────────────────

  /** 惰性烘焙：配置指纹变化时才重算（R3：setMapSize 后惰性触发）。
   *  坐标模式：城市/拐点/道路/区域基于离散坐标，无格子烘焙。 */
  private ensureBaked(cfg: GameConfig): void {
    const key = `${this.mapW}x${this.mapH}|${cfg.meta.setName}@${cfg.meta.version}|${cfg.links.length}|${cfg.mapBgImg ?? ''}|${cfg.roadLines?.length ?? 0}`;
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.mapW = Math.max(1, cfg.mapBounds?.w ?? 1);
    this.mapH = Math.max(1, cfg.mapBounds?.h ?? 1);
    this.roadCurves = this.buildRoadsVector(cfg);
    this.loadBg(cfg);
  }


  /**
   * L2 道路：roadLines 的几何折线直接转 SmoothCurve（pts=坐标空间折线，labels=点序号）。
   * 直线/折线原样描边（drawRoads 只走折线，不做贝塞尔，避免几何折线被二次弯曲）。
   * 兜底：无 points 时按 refs 两端节点坐标画直线（与 buildVGraph 的兜底一致，保证
   * 「显示直线 = 角色移动 = 玩法距离」三者统一）。
   */
  private buildRoadsVector(cfg: GameConfig): SmoothCurve[] {
    const curves: SmoothCurve[] = [];
    const ptOf = (id: string): Pt | null => {
      const cp = cfg.cityPointByTag[id];
      if (cp) return { x: cp.x, y: cp.y };
      const wp = cfg.waypoints.find((w) => w.id === id);
      return wp ? { x: wp.x, y: wp.y } : null;
    };
    for (const rl of cfg.roadLines) {
      let pts: Pt[];
      if (rl.points && rl.points.length >= 2) {
        pts = rl.points.map((p) => ({ x: p.x, y: p.y }));
      } else {
        const a = ptOf(rl.refs[0]);
        const b = ptOf(rl.refs[1]);
        if (!a || !b) continue;
        pts = [a, b];
      }
      curves.push({ pts, labels: pts.map((_, i) => i) });
    }
    return curves;
  }

  /** L0 背景：mapBgImg 有值 → 加载 bg1 图（坐标空间按 config.bg1 变换绘制）；无/失败 → 程序化占位 */
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

  /** 烘焙程序化占位底图到离屏（按当前画布尺寸；bg1 图可用时不走此路，见 drawBgImage） */
  private bakeBg(): void {
    const w = this.w;
    const h = this.h;
    const oc = document.createElement('canvas');
    oc.width = w;
    oc.height = h;
    const c = oc.getContext('2d')!;
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
    this.bgCanvas = oc;
    this.bgKey = this.bgKeyNow();
  }

  /**
   * bg1 底图变换（config.bg1*）→ 坐标空间矩形。
   * 几何逻辑唯一真相在 shared/bgGeom.ts（与地图编辑器共用，保证「编辑器所见 = 游戏所见」）：
   * 基准 = 全部点位（城市 + 拐点）包围盒；图像按基准矩形 cover 铺满 →
   * 按 scaleW/scaleH 围绕基准中心缩放 → 按 offsetX/offsetY 平移。
   */
  private bgRect(cfg: GameConfig, img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
    return bgImageRect(cfg.bg1, [...cfg.cityPoints, ...cfg.waypoints], img.width, img.height);
  }

  /** L0 bg1 底图：坐标空间直接绘制（随视图平移/缩放），浓度取 config.bg1.opacity */
  private drawBgImage(cfg: GameConfig): void {
    const img = this.bgImg;
    if (!img) return;
    const r = this.bgRect(cfg, img);
    if (!r) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, cfg.bg1.opacity));
    ctx.drawImage(img, this.px(r.x), this.py(r.y), r.w * this.s, r.h * this.s);
    ctx.restore();
  }

  // ───────────────────────── 主绘制 ─────────────────────────

  draw(cfg: GameConfig, state: GameState, nowMs: number): void {
    const ctx = this.ctx;
    this.ensureBaked(cfg);

    ctx.save();
    ctx.clearRect(0, 0, this.w, this.h);

    // L0 背景：bg1 底图（坐标空间，随视图平移/缩放）优先；无图/加载失败 → 程序化占位（画布空间烘焙）
    if (this.bgLoaded && this.bgImg) {
      this.drawBgImage(cfg);
    } else {
      if (!this.bgCanvas || this.bgKey !== this.bgKeyNow()) this.bakeBg();
      if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0, this.w, this.h);
    }

    // L2 道路（双层描边，合并 Path2D → 2 次 stroke）
    this.drawRoads();

    // L3 节点（拐点 + 城市）
    this.drawNodes(cfg);

    // L4 动态（角色 + 路径）
    this.drawDynamic(state, nowMs);

    // 调试网格（校验坐标空间点位与道路贴合度）
    if (DEBUG_GRID) this.drawDebugGrid(cfg);

    ctx.restore();
  }

  private drawRoads(): void {
    const ctx = this.ctx;
    if (!this.roadCurves.length) return;
    // 坐标空间大、s 极小，道路用固定像素宽（含 halo），避免被缩成发丝
    const roadW = 4;
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

  /** 节点绘制：拐点 + 城市（离散坐标；城市/拐点用固定像素尺寸，不随 s 缩放）。去州化：不渲染州分区色块/州名。 */
  private drawNodes(cfg: GameConfig): void {
    const ctx = this.ctx;

    // 拐点（小圆点，无州色）
    for (const w of cfg.waypoints) {
      const x = this.px(w.x);
      const y = this.py(w.y);
      const r = 5;
      ctx.fillStyle = '#9aa3b2';
      ctx.strokeStyle = 'rgba(8,10,14,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 城市（固定像素尺寸城郭图标 + 城名；坐标空间大、s 极小，不能按 s 缩放否则不可见）
    const glyphPx = 13;
    for (const cp of cfg.cityPoints) {
      this.drawCityGlyph(this.px(cp.x), this.py(cp.y), glyphPx, cp.name);
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

    // 角色锚点（坐标空间）
    let charGrid: Pt;

    if (phase.kind === 'moving') {
      const path = phase.path;
      const sc = this.getSmooth(path);
      const L = path.length;
      const progress = phase.total > 0 ? Math.min(1, Math.max(0, 1 - phase.remain / phase.total)) : 1;
      const g = progress * (L - 1);
      const bright = DYN.movingBright;
      const base = DYN.movingBase;
      this.drawPhasePath(sc, g, bright, base);

      // 目的地靶标（path 末端，与角色标记造型区分开）
      const end = sc.pts[sc.pts.length - 1];
      this.drawDestination(end.x, end.y, bright, nowMs);

      charGrid = charOnCurve(sc, g);
    } else {
      // 坐标空间即是真实坐标，直接落点
      const c = currentCell(state);
      charGrid = { x: c.x, y: c.y };
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

  /** 当前路径：已走段暗色铺底，剩余段亮色（按路径进度切分） */
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

  /** 调试网格：坐标空间网格 + 城市/拐点锚点 */
  private drawDebugGrid(cfg: GameConfig): void {
    const ctx = this.ctx;
    const step = 50;
    ctx.strokeStyle = 'rgba(255,80,80,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.mapW; x += step) {
      ctx.moveTo(Math.round(this.px(x)) + 0.5, this.py(0));
      ctx.lineTo(Math.round(this.px(x)) + 0.5, this.py(this.mapH));
    }
    for (let y = 0; y <= this.mapH; y += step) {
      ctx.moveTo(this.px(0), Math.round(this.py(y)) + 0.5);
      ctx.lineTo(this.px(this.mapW), Math.round(this.py(y)) + 0.5);
    }
    ctx.stroke();
    const dot = (x: number, y: number, col: string, rad: number) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(this.px(x), this.py(y), rad, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const cp of cfg.cityPoints) dot(cp.x, cp.y, 'rgba(80,200,120,0.9)', 4);
    for (const w of cfg.waypoints) dot(w.x, w.y, 'rgba(255,180,80,0.9)', 3);
  }

  // ───────────────────────── 工具 ─────────────────────────

  /** L4 动态路径平滑（按引用缓存）：坐标空间折线直接复用，index 标签供 splitCurve 按进度取点 */
  private getSmooth(path: Cell[]): SmoothCurve {
    let sc = this.pathCache.get(path);
    if (!sc) {
      sc = { pts: path.map((c) => ({ x: c.x, y: c.y })), labels: path.map((_, i) => i) };
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

// ════════════════════ 模块级纯函数（几何） ════════════════════

/** §三 取点：按路径进度 g 在平滑曲线上插值（非弧长均匀），返回坐标 */
function charOnCurve(sc: SmoothCurve, g: number): Pt {
  if (sc.pts.length === 1) return sc.pts[0];
  const { bx, by } = splitCurve(sc, g);
  return { x: bx, y: by };
}

/** 在平滑曲线上按路径进度 g 切分，返回分段索引 k 与切点 bx/by（drawPhasePath 与 charOnCurve 共用） */
function splitCurve(sc: SmoothCurve, g: number): { k: number; bx: number; by: number } {
  const { pts, labels } = sc;
  let k = 0;
  while (k < labels.length - 1 && labels[k + 1] <= g) k++;
  const frac = labels[k + 1] > labels[k] ? (g - labels[k]) / (labels[k + 1] - labels[k]) : 0;
  return { k, bx: pts[k].x + (pts[k + 1].x - pts[k].x) * frac, by: pts[k].y + (pts[k + 1].y - pts[k].y) * frac };
}

/** 确定性伪随机哈希 → [0,1)（程序化背景云纹光斑定位，需稳定不随帧闪烁） */
function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}


