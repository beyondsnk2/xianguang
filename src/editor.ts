/**
 * sanwalk 地图编辑器（独立页面，挂在 vite dev 下 /editor.html）。
 * 功能：基于 xlsx 生成可拖动地图（城市 / 拐点 / 连线），左侧拖动改坐标，右侧增删节点与连线，导出 mapPoint 版 xlsx 与 json。
 * 数据模型遵循「mapPoint 一张表用 type 区分 city/waypoint；mapPointLink 表达任意两点连通」的设计。
 * 只读新表名（mapPoint / mapPointLink），导出统一为新表名。
 * 底图（bg1/bg2）的位移 / 缩放 / 浓度初始值读 xlsx 的 config 表（bg1OffsetX/bg1OffsetY/
 * bg1ScaleW/bg1ScaleH/bg1Opacity/mapBgImg），与游戏同源；浓度控件为小数（0~1）。
 */
import * as XLSX from 'xlsx';
import { bgImageRect, type BgRect } from './shared/bgGeom';

type NodeType = 'city' | 'waypoint';
interface MapNode {
  tag: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  state?: string | null;
  taskTypes?: string[];
}
interface MapLink {
  tagA: string;
  tagB: string;
}
interface MapState {
  tag: string;
  name: string;
  color: string;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const DEFAULT_XLSX_URL = '/config/firstShow_V5.xlsx';

/* ── 底图（垫在城市/连线之下，随区域矩形铺满）── */
/* bgUrls[0] 默认 /bg1.png；xlsx config 表配了 mapBgImg 时以它为准（与游戏同源） */
const bgUrls: string[] = ['/bg1.png', '/bg2.png'];
const bgState = {
  visible: [true, false] as boolean[],   // bg1 默认显示，bg2 默认隐藏
  opacity: [1, 0.85] as number[],
  dx: 0, dy: 0, scaleX: 1, scaleY: 1,      // 两张图共用的位移 / 缩放（围绕区域中心，X/Y 方向独立）
};
let bgEls: (SVGImageElement | null)[] = [null, null];

/* 底图自然尺寸探测缓存：SVG <image> 不暴露 naturalWidth，用 HTMLImageElement 探测。
   拿不到尺寸（探测中 / 加载失败）→ 底图不参与几何计算、不计入内容矩形，
   与游戏侧「图未加载完不画」行为一致。 */
let bgSizes: ({ w: number; h: number } | null)[] = [null, null];
const bgProbed = [false, false];
function probeBg(i: number): void {
  if (bgProbed[i]) return;
  bgProbed[i] = true;
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      bgSizes[i] = { w: img.naturalWidth, h: img.naturalHeight };
      applyBgRect(i);
      applyView();
    }
  };
  img.onerror = () => {
    bgSizes[i] = null;
  };
  img.src = bgUrls[i];
}

/* ── 视图整体缩放：viewBox 始终为全 bounds，svg 像素尺寸 = 世界尺寸 × 基准比例 × zoom；
   平移由 .svg-wrap 的原生滚动条 / 拖拽完成，节点坐标与底图不受影响 ── */
let viewZoom = 1;

let nodes: MapNode[] = [];
let links: MapLink[] = [];
let linkFilter = ''; // 下方连线列表筛选词（空 = 全部可见）
let states: MapState[] = [];
let originalWb: any = null;
let originalSheetNames: string[] = [];

let svgEl!: SVGSVGElement;
const nodeEls = new Map<string, SVGGElement>();
const linkElMap = new Map<string, SVGLineElement>(); // key: `${tagA}|${tagB}`
let dragging: string | null = null;

/* ───────────────────────────── 布局 ───────────────────────────── */
const root = document.getElementById('root')!;
root.innerHTML = `
<div class="layout">
  <div class="map-pane">
    <div class="toolbar">
      <button id="btn-open">打开 xlsx</button>
      <button id="btn-export-xlsx">导出 xlsx</button>
      <button id="btn-export-json">导出 json</button>
      <span id="status">加载中…</span>
      <span class="zoom-ctl">
        <span>整体缩放</span>
        <input type="range" id="view-zoom" min="0.1" max="8" step="0.05" value="1" />
        <span id="view-zoom-val">100%</span>
      </span>
      <input type="file" id="file" accept=".xlsx,.xls" style="display:none" />
    </div>
    <div class="svg-wrap"><svg id="map" preserveAspectRatio="xMidYMid meet"></svg></div>
  </div>
  <div class="side-pane">
    <h3>底图（bg1 / bg2）</h3>
    <div class="bg-ctrl">
      <label><input type="checkbox" id="bg1-vis" checked /> bg1</label>
      <label><input type="checkbox" id="bg2-vis" /> bg2</label>
    </div>
    <div class="bg-ctrl">
      <span>位移X</span><input type="number" id="bg-dx" class="num" step="0.5" value="0" />
      <span>位移Y</span><input type="number" id="bg-dy" class="num" step="0.5" value="0" />
    </div>
    <div class="bg-ctrl">
      <span>缩放X</span><input type="number" id="bg-scale-x" class="num" step="0.01" value="1" />
      <span>缩放Y</span><input type="number" id="bg-scale-y" class="num" step="0.01" value="1" />
    </div>
    <div class="bg-ctrl">
      <span>bg1浓度</span><input type="range" id="bg1-op" min="0" max="1" step="0.01" value="1" />
      <input type="number" id="bg1-op-num" class="num" min="0" max="1" step="0.01" value="1" title="bg1 浓度（0~1 小数）" />
      <span>bg2浓度</span><input type="range" id="bg2-op" min="0" max="1" step="0.01" value="0.85" />
      <input type="number" id="bg2-op-num" class="num" min="0" max="1" step="0.01" value="0.85" title="bg2 浓度（0~1 小数）" />
    </div>
    <h3>节点（城市 / 拐点）</h3>
    <div class="add-node">
      tag<input id="n-tag" size="8" /> name<input id="n-name" size="8" />
      <select id="n-type"><option value="city">城市</option><option value="waypoint">拐点</option></select>
      <button id="btn-add-node">＋ 新增</button>
    </div>
    <ul id="node-list"></ul>
    <h3>连线</h3>
    <div class="add-link">
      <div class="link-pick">
        <input id="l-a-q" class="link-q" type="search" placeholder="筛选 A：tag / 名称" />
        <select id="l-a"></select>
      </div>
      <span class="link-dash">—</span>
      <div class="link-pick">
        <input id="l-b-q" class="link-q" type="search" placeholder="筛选 B：tag / 名称" />
        <select id="l-b"></select>
      </div>
      <button id="btn-add-link">＋ 新增</button>
    </div>
    <input id="link-q" class="link-q link-list-q" type="search" placeholder="筛选连线：tag / 名称（默认全部）" />
    <ul id="link-list"></ul>
  </div>
</div>`;

const style = document.createElement('style');
style.textContent = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#15110b;color:#e8e0cf}
.layout{display:flex;height:100vh}
.map-pane{flex:1;display:flex;flex-direction:column;min-width:0}
.toolbar{padding:8px;background:#221a10;display:flex;gap:8px;align-items:center}
.toolbar button{background:#c9a24a;color:#1a140c;border:0;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:600}
.toolbar button:hover{background:#e0b85a}
#status{color:#b8a98a;font-size:13px;margin-left:auto}
.zoom-ctl{display:flex;align-items:center;gap:6px;font-size:12px;color:#b8a98a;white-space:nowrap}
.zoom-ctl input[type=range]{width:140px;accent-color:#c9a24a}
#view-zoom-val{min-width:44px;text-align:right;color:#c9a24a}
.svg-wrap{flex:1;overflow:auto;background:radial-gradient(circle at 50% 40%, #2a2418, #15110b)}
.svg-wrap::-webkit-scrollbar{width:10px;height:10px}
.svg-wrap::-webkit-scrollbar-thumb{background:#3a2e1a;border-radius:5px}
.svg-wrap::-webkit-scrollbar-track{background:#1c160d}
#map{display:block;cursor:grab}
.side-pane{width:320px;background:#1c160d;border-left:1px solid #3a2e1a;padding:12px;overflow:auto}
.side-pane h3{margin:14px 0 6px;color:#c9a24a;font-size:14px}
.bg-ctrl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#b8a98a;margin:4px 0}
.bg-ctrl input[type="checkbox"]{accent-color:#c9a24a}
.bg-ctrl input[type="range"]{flex:1;min-width:60px;accent-color:#c9a24a}
.bg-ctrl .num{width:64px;background:#2a2218;color:#e8e0cf;border:1px solid #3a2e1a;padding:3px 4px}
.add-node input,.add-link select,.add-link .link-q{background:#2a2218;color:#e8e0cf;border:1px solid #3a2e1a;padding:4px;margin:2px}
.add-node button,.add-link button{background:#c9a24a;color:#1a140c;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;margin:2px}
.add-link{display:flex;align-items:center;gap:2px}
.link-pick{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.link-pick select{width:100%}
.link-dash{color:#8a7a5a;padding:0 2px}
.link-list-q{width:100%;margin:4px 0 2px}
#link-list .none{color:#8a7a5a;font-size:12px;padding:4px 0}
#node-list,#link-list{list-style:none;padding:0;margin:0}
#node-list li,#link-list li{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #2a2218;font-size:13px}
#node-list .tag{font-weight:600;color:#c9a24a}
#node-list .ty{color:#8a7a5a;font-size:11px}
#node-list button,#link-list button{margin-left:auto;background:#a44;color:#fff;border:0;padding:2px 8px;border-radius:3px;cursor:pointer}
`;
document.head.appendChild(style);

svgEl = document.getElementById('map') as unknown as SVGSVGElement;
const svgWrap = document.querySelector('.svg-wrap') as HTMLElement;

/* ───────────────────────────── 工具 ───────────────────────────── */
function setStatus(s: string) {
  document.getElementById('status')!.textContent = s;
}
function r2(v: number) {
  return Math.round(v * 100) / 100;
}
function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────────────────────────── 解析 xlsx ───────────────────────────── */
function parseWorkbook(wb: any) {
  originalWb = wb;
  originalSheetNames = wb.SheetNames.slice();

  const ptRows: any[] = wb.SheetNames.includes('mapPoint')
    ? (XLSX.utils.sheet_to_json(wb.Sheets['mapPoint'], { defval: null }) as any[])
    : [];
  nodes = ptRows
    .map((r) => {
      const type: NodeType = (r['type'] || 'city') === 'waypoint' ? 'waypoint' : 'city';
      const tt = typeof r['taskType'] === 'string' && r['taskType'] ? String(r['taskType']) : '';
      return {
        tag: String(r['tag'] ?? '').trim(),
        name: String(r['name'] ?? '').trim(),
        type,
        x: Number(r['x']),
        y: Number(r['y']),
        state: r['state'] ?? null,
        taskTypes: tt ? tt.split(';').map((s: string) => s.trim()).filter(Boolean) : [],
      };
    })
    // 过滤条件与 config/parse.ts 的点位读取严格一致（tag/name 非空 + 坐标有限），
    // 保证编辑器点位集合 = 游戏 cityPoints ∪ waypoints（底图基准包围盒两边同源）
    .filter((n) => n.tag && n.name && Number.isFinite(n.x) && Number.isFinite(n.y));

  const linkRows: any[] = wb.SheetNames.includes('mapPointLink')
    ? (XLSX.utils.sheet_to_json(wb.Sheets['mapPointLink'], { defval: null }) as any[])
    : [];
  links = linkRows
    .map((r) => ({ tagA: String(r['tagA'] ?? '').trim(), tagB: String(r['tagB'] ?? '').trim() }))
    .filter((l) => l.tagA && l.tagB && l.tagA !== l.tagB);

  const stRows: any[] = wb.SheetNames.includes('state')
    ? (XLSX.utils.sheet_to_json(wb.Sheets['state'], { defval: null }) as any[])
    : [];
  states = stRows
    .map((r) => ({
      tag: String(r['tag'] ?? '').trim(),
      name: String(r['name'] ?? '').trim(),
      color: String(r['color'] ?? '#888888').trim(),
    }))
    .filter((s) => s.tag && /^#[0-9a-fA-F]{6}$/.test(s.color));

  // config 表：bg1 底图初值（与游戏同源；缺列/非法值用默认）
  const cfgRows: any[] = wb.SheetNames.includes('config')
    ? (XLSX.utils.sheet_to_json(wb.Sheets['config'], { defval: null }) as any[])
    : [];
  const cfgMap: Record<string, any> = {};
  for (const r of cfgRows) {
    const t = String(r['tag'] ?? '').trim();
    if (t) cfgMap[t] = r['content'];
  }
  const numOr = (v: any, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  bgState.dx = numOr(cfgMap['bg1OffsetX'], 0);
  bgState.dy = numOr(cfgMap['bg1OffsetY'], 0);
  bgState.scaleX = numOr(cfgMap['bg1ScaleW'], 1) || 1; // 0/NaN → 1，避免缩放成 0
  bgState.scaleY = numOr(cfgMap['bg1ScaleH'], 1) || 1;
  bgState.opacity[0] = Math.min(1, Math.max(0, numOr(cfgMap['bg1Opacity'], 1)));
  const bgImgName = String(cfgMap['mapBgImg'] ?? '').trim();
  if (bgImgName) bgUrls[0] = bgImgName.startsWith('/') ? bgImgName : `/${bgImgName}`;
  syncBgControls();

  resetViewZoom();
  renderMap();
  renderSidebar();
  setStatus(`已加载：${nodes.length} 节点 / ${links.length} 连线 / ${states.length} 州`);
}

/* ───────────────────────────── 计算包围盒 ───────────────────────────── */
function bounds() {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const pad = 8;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/* ───────────────────────────── 底图渲染 / 控制 ───────────────────────────── */
/* 内容矩形 = 节点区域 ∪ 各张可见底图的终态矩形。
   底图几何 = shared/bgGeom.bgImageRect（与游戏 render/map.ts 同一函数）：
   基准 = 点位包围盒（无 pad）→ 图像 cover 铺满 → 绕中心 scaleW/H → offset 平移。
   「编辑器所见 = 游戏所见」靠这一行 import 保证，几何公式不允许在编辑器里重写。
   底图放大 / 位移后不裁切：溢出部分进入 viewBox 与滚动范围，可拖动 / 滚到时看全。 */
function contentRect(b = bounds()) {
  let minX = b.minX,
    minY = b.minY,
    maxX = b.maxX,
    maxY = b.maxY;
  for (let i = 0; i < bgUrls.length; i++) {
    if (!bgState.visible[i]) continue;
    const r = bgRectOf(i);
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const pad = 0; // bounds 自身已带 padding；这里不再外扩，保证默认状态无滚动条
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
/* 视图基准比例（zoom=1 时地图铺满可视区的较小边）。
   粘性语义：只在「配置重载 / 窗口尺寸变化」时重算（viewBase=null 失效）。
   **不能跟着 bounds 实时重算**——拖动节点会改变 bounds（节点包围盒），
   若 base 跟着漂移，松手瞬间整个地图会缩放重排，表现为「拖完节点像被弹回
   初始位置」（襄平拖出包围盒 → bW 变大 → base 变小 → svg 像素尺寸缩水）。
   用 offsetWidth/offsetHeight（布局边框盒，不受滚动条显隐影响）而非 clientWidth/Height：
   底图放大后滚动条出现会缩小 client 尺寸。 */
let viewBase: number | null = null;
function computeBase(): number {
  const b = bounds();
  const bW = b.maxX - b.minX;
  const bH = b.maxY - b.minY;
  return Math.min((svgWrap.offsetWidth || 800) / bW, (svgWrap.offsetHeight || 600) / bH);
}
/* 视图整体缩放：viewBox 恒为内容矩形；svg 像素尺寸按「基准比例 × zoom」设置，
   内容超出 .svg-wrap 即出现滚动条。
   不变式：视口中心的「世界坐标」与像素比例（基准比例 × zoom）在 viewBox 变化时保持——
   底图缩放 / 位移只改底图自身变换与滚动范围，城市 / 道路的大小与位置不受影响；
   拖动节点同理：bounds 变化只扩 viewBox / 滚动范围，不改变像素比例。 */
function applyView() {
  const b = bounds();
  const c = contentRect(b);
  const W = c.maxX - c.minX;
  const H = c.maxY - c.minY;
  // 旧视口参数：viewBox 第 1/2 位为旧内容原点、3/4 位为旧内容宽高。
  // viewBox 坐标即世界坐标，视口中心须加回旧原点才是世界坐标（漏加会导致
  // viewBox 原点移动时视图整体跳动——表现为底图缩放影响了上方的城市/道路）。
  const vb = (svgEl.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const oldW = vb.length >= 4 && vb[2] > 0 ? vb[2] : 0;
  const oldMinX = vb.length >= 4 && Number.isFinite(vb[0]) ? vb[0] : 0;
  const oldMinY = vb.length >= 4 && Number.isFinite(vb[1]) ? vb[1] : 0;
  const oldPW = Number(svgEl.getAttribute('width'));
  const oldScale = oldW > 0 && oldPW > 0 ? oldPW / oldW : 0;
  const cx = oldScale > 0 ? oldMinX + (svgWrap.scrollLeft + svgWrap.clientWidth / 2) / oldScale : (b.minX + b.maxX) / 2;
  const cy = oldScale > 0 ? oldMinY + (svgWrap.scrollTop + svgWrap.clientHeight / 2) / oldScale : (b.minY + b.maxY) / 2;
  svgEl.setAttribute('viewBox', `${c.minX} ${c.minY} ${W} ${H}`);
  if (viewBase === null) viewBase = computeBase();
  const base = viewBase;
  const pw = Math.max(1, Math.round(W * base * viewZoom));
  const ph = Math.max(1, Math.round(H * base * viewZoom));
  svgEl.setAttribute('width', String(pw));
  svgEl.setAttribute('height', String(ph));
  const scale = pw / W;
  // 世界坐标换算回新 viewBox 下的像素位置：保持视口中心的内容点不跳
  svgWrap.scrollLeft = (cx - c.minX) * scale - svgWrap.clientWidth / 2;
  svgWrap.scrollTop = (cy - c.minY) * scale - svgWrap.clientHeight / 2;
}
/** 重新加载配置时复位视图缩放（滑条回 100%，基准比例失效，清掉旧像素尺寸以便重新居中） */
function resetViewZoom() {
  viewZoom = 1;
  viewBase = null;
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  const s = document.getElementById('view-zoom') as HTMLInputElement | null;
  if (s) s.value = '1';
  const v = document.getElementById('view-zoom-val');
  if (v) v.textContent = '100%';
}
/* 第 i 张底图的终态矩形（坐标空间）：与游戏 render/map.ts 共用 shared/bgGeom.bgImageRect。
   未拿到图像自然尺寸（探测中 / 加载失败）→ null（不画、不计入内容矩形）。 */
function bgRectOf(i: number): BgRect | null {
  const sz = bgSizes[i];
  if (!sz) return null;
  return bgImageRect(
    { scaleW: bgState.scaleX, scaleH: bgState.scaleY, offsetX: bgState.dx, offsetY: bgState.dy },
    nodes,
    sz.w,
    sz.h,
  );
}
/* 把终态矩形写入 SVG image：x/y/w/h 即游戏 canvas drawImage 的同一矩形；
   preserveAspectRatio=none 与 canvas drawImage 行为一致（拉伸填满目标矩形）。
   注意：不再使用 bounds 矩形 + transform 的老方案——那与游戏的 cover 模型不同源。 */
function applyBgRect(i: number): void {
  const el = bgEls[i];
  if (!el) return;
  const r = bgRectOf(i);
  if (!r) return; // 尺寸未就绪 / 无点位 → 保持默认空矩形
  el.setAttribute('x', String(r.x));
  el.setAttribute('y', String(r.y));
  el.setAttribute('width', String(r.w));
  el.setAttribute('height', String(r.h));
}
function applyBgRects(): void {
  for (let i = 0; i < bgEls.length; i++) applyBgRect(i);
}
function applyBgVisibility(i: number) {
  const el = bgEls[i];
  if (!el) return;
  el.style.display = bgState.visible[i] ? '' : 'none';
  el.setAttribute('opacity', String(bgState.opacity[i]));
}
/** 把 bgState 同步到右侧控件（加载 xlsx 后调用，使 config 表里的 bg1 初值可见可调） */
function syncBgControls(): void {
  const set = (id: string, v: number): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(v);
  };
  set('bg-dx', bgState.dx);
  set('bg-dy', bgState.dy);
  set('bg-scale-x', bgState.scaleX);
  set('bg-scale-y', bgState.scaleY);
  set('bg1-op', bgState.opacity[0]);
  set('bg1-op-num', bgState.opacity[0]);
  set('bg2-op', bgState.opacity[1]);
  set('bg2-op-num', bgState.opacity[1]);
}

/* ───────────────────────────── 渲染地图 ───────────────────────────── */
function renderMap() {
  applyView();
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  nodeEls.clear();
  linkElMap.clear();

  // 底图：垫在最底层（城市之下）。几何不在这里算——x/y/w/h 由探测到图像
  // 自然尺寸后按 shared/bgGeom.bgImageRect 写入（与游戏 drawImage 同一矩形）。
  bgEls = [null, null];
  bgSizes = [null, null];
  bgProbed[0] = false;
  bgProbed[1] = false;
  for (let i = 0; i < bgUrls.length; i++) {
    const img = document.createElementNS(SVGNS, 'image') as SVGImageElement;
    img.setAttribute('href', bgUrls[i]);
    img.setAttribute('preserveAspectRatio', 'none'); // 与 canvas drawImage 一致：拉伸填满目标矩形
    img.style.pointerEvents = 'none'; // 不挡节点的拖动
    img.addEventListener('error', () => {
      bgState.visible[i] = false; // 加载失败 → 不计入内容矩形，避免空留滚动范围
      bgSizes[i] = null;
      applyBgVisibility(i);
      const cb = document.getElementById(i === 0 ? 'bg1-vis' : 'bg2-vis') as HTMLInputElement | null;
      if (cb) cb.checked = false;
      applyView();
      setStatus(`底图 ${bgUrls[i]} 加载失败（public/ 下缺文件？）`);
    });
    svgEl.appendChild(img);
    bgEls[i] = img;
    applyBgVisibility(i);
    probeBg(i); // 拿到自然尺寸 → applyBgRect + applyView
  }

  // 连线
  for (const l of links) {
    const a = nodes.find((n) => n.tag === l.tagA);
    const c = nodes.find((n) => n.tag === l.tagB);
    if (!a || !c) continue;
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(c.x));
    line.setAttribute('y2', String(c.y));
    line.setAttribute('stroke', '#c9a24a');
    line.setAttribute('stroke-width', '0.4');
    line.setAttribute('opacity', '0.85');
    svgEl.appendChild(line);
    linkElMap.set(`${l.tagA}|${l.tagB}`, line);
  }

  // 节点
  for (const n of nodes) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    g.style.cursor = 'move';
    if (n.type === 'city') {
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', '-1.6');
      rect.setAttribute('y', '-1.2');
      rect.setAttribute('width', '3.2');
      rect.setAttribute('height', '2.4');
      rect.setAttribute('fill', '#f2ead2');
      rect.setAttribute('stroke', '#2a2018');
      rect.setAttribute('stroke-width', '0.2');
      g.appendChild(rect);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', '0');
      t.setAttribute('y', '3.6');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '1.6');
      t.setAttribute('fill', '#f5efdc');
      t.setAttribute('stroke', '#1a140c');
      t.setAttribute('stroke-width', '0.3');
      t.setAttribute('paint-order', 'stroke');
      t.textContent = n.name;
      g.appendChild(t);
    } else {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', '0.9');
      c.setAttribute('fill', '#9aa3b2');
      c.setAttribute('stroke', '#0a0c0e');
      c.setAttribute('stroke-width', '0.2');
      g.appendChild(c);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', '0');
      t.setAttribute('y', '2.4');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '1.4');
      t.setAttribute('fill', '#cdd5e0');
      t.setAttribute('stroke', '#1a140c');
      t.setAttribute('stroke-width', '0.25');
      t.setAttribute('paint-order', 'stroke');
      t.textContent = n.name;
      g.appendChild(t);
    }
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = n.tag;
    });
    svgEl.appendChild(g);
    nodeEls.set(n.tag, g);
  }
}

/* ───────────────────────────── 拖动 ───────────────────────────── */
function screenToSvg(e: MouseEvent) {
  const pt = svgEl.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return null;
  return pt.matrixTransform(ctm.inverse());
}
/* 平移：在空白处 / 底图上按住拖动 → 转成 .svg-wrap 的滚动位移（与滚动条同一套位置） */
let panning: { x: number; y: number; sl: number; st: number } | null = null;
svgEl.addEventListener('mousedown', (e) => {
  if (dragging) return; // 节点拖动优先，不触发平移
  e.preventDefault(); // 阻止底图 <image> 的原生拖拽与文本选中
  panning = { x: e.clientX, y: e.clientY, sl: svgWrap.scrollLeft, st: svgWrap.scrollTop };
  svgEl.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (panning) {
    svgWrap.scrollLeft = panning.sl - (e.clientX - panning.x);
    svgWrap.scrollTop = panning.st - (e.clientY - panning.y);
    return;
  }
  if (!dragging) return;
  const loc = screenToSvg(e);
  if (!loc) return;
  const n = nodes.find((x) => x.tag === dragging);
  if (!n) return;
  n.x = r2(loc.x);
  n.y = r2(loc.y);
  const g = nodeEls.get(n.tag);
  if (g) g.setAttribute('transform', `translate(${n.x},${n.y})`);
  // 同步相连连线
  for (const l of links) {
    if (l.tagA !== n.tag && l.tagB !== n.tag) continue;
    const line = linkElMap.get(`${l.tagA}|${l.tagB}`);
    if (!line) continue;
    const a = nodes.find((x) => x.tag === l.tagA)!;
    const c = nodes.find((x) => x.tag === l.tagB)!;
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(c.x));
    line.setAttribute('y2', String(c.y));
  }
});
window.addEventListener('mouseup', () => {
  const moved = dragging !== null;
  dragging = null;
  if (panning) {
    panning = null;
    svgEl.style.cursor = '';
  }
  // 拖动节点 → 点位包围盒（底图基准）可能变化 → 底图矩形与滚动范围重算
  if (moved) {
    applyBgRects();
    applyView();
  }
});

/* ───────────────────────────── 右侧面板 ───────────────────────────── */
/* 连线端点快速筛选：原生 select 不支持输入，用过滤框按 tag / 名称缩小选项。
   已选项恒可见——过滤词不匹配当前选择时也不丢失所选端点。 */
function filterLinkOptions(side: 'a' | 'b') {
  const q = (document.getElementById(`l-${side}-q`) as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  const sel = document.getElementById(`l-${side}`) as HTMLSelectElement;
  const cur = sel.value;
  let shown = 0;
  for (const o of Array.from(sel.options)) {
    const hit = !q || o.value.toLowerCase().includes(q) || (o.textContent || '').toLowerCase().includes(q);
    if (hit) shown++;
    o.style.display = hit || o.value === cur ? '' : 'none';
  }
  if (q) setStatus(`筛选「${q}」：${shown} 个匹配`);
}

function renderSidebar() {
  const nl = document.getElementById('node-list')!;
  nl.innerHTML = '';
  for (const n of nodes) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.innerHTML = `<span class="tag">${n.tag}</span> <span class="nm">${n.name}</span> <span class="ty">${n.type === 'city' ? '城' : '拐'}</span>`;
    li.appendChild(info);
    const del = document.createElement('button');
    del.textContent = '删';
    del.onclick = () => deleteNode(n.tag);
    li.appendChild(del);
    nl.appendChild(li);
  }

  const la = document.getElementById('l-a') as HTMLSelectElement;
  const lb = document.getElementById('l-b') as HTMLSelectElement;
  la.innerHTML = '';
  lb.innerHTML = '';
  for (const n of nodes) {
    const o1 = document.createElement('option');
    o1.value = n.tag;
    o1.textContent = `${n.name}(${n.tag})`;
    la.appendChild(o1);
    const o2 = o1.cloneNode(true) as HTMLOptionElement;
    lb.appendChild(o2);
  }
  // 列表重建后按当前过滤词恢复可见性（删节点 / 加节点不清空用户的筛选）
  filterLinkOptions('a');
  filterLinkOptions('b');

  const ll = document.getElementById('link-list')!;
  ll.innerHTML = '';
  // 筛选：tagA / tagB 的 tag 或名称命中输入内容才显示；无筛选词时全部可见
  const q = linkFilter.trim().toLowerCase();
  const shown = links.filter((l) => {
    if (!q) return true;
    const na = nodes.find((n) => n.tag === l.tagA)?.name ?? '';
    const nb = nodes.find((n) => n.tag === l.tagB)?.name ?? '';
    return (
      l.tagA.toLowerCase().includes(q) ||
      l.tagB.toLowerCase().includes(q) ||
      na.toLowerCase().includes(q) ||
      nb.toLowerCase().includes(q)
    );
  });
  for (const l of shown) {
    const li = document.createElement('li');
    const na = nodes.find((n) => n.tag === l.tagA)?.name ?? l.tagA;
    const nb = nodes.find((n) => n.tag === l.tagB)?.name ?? l.tagB;
    const span = document.createElement('span');
    span.textContent = `${na} — ${nb}`;
    li.appendChild(span);
    const del = document.createElement('button');
    del.textContent = '删';
    del.onclick = () => deleteLink(l);
    li.appendChild(del);
    ll.appendChild(li);
  }
  if (q && !shown.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = `无匹配「${linkFilter.trim()}」的连线`;
    ll.appendChild(li);
  }
  if (q) setStatus(`连线筛选「${linkFilter.trim()}」：${shown.length}/${links.length} 条`);
}

function deleteNode(tag: string) {
  nodes = nodes.filter((n) => n.tag !== tag);
  links = links.filter((l) => l.tagA !== tag && l.tagB !== tag);
  renderMap();
  renderSidebar();
}
function addNode() {
  const tag = (document.getElementById('n-tag') as HTMLInputElement).value.trim();
  const name = (document.getElementById('n-name') as HTMLInputElement).value.trim();
  const type = (document.getElementById('n-type') as HTMLSelectElement).value as NodeType;
  if (!tag || !name) {
    setStatus('tag 和 name 必填');
    return;
  }
  if (nodes.some((n) => n.tag === tag)) {
    setStatus('tag 已存在');
    return;
  }
  const b = bounds();
  nodes.push({ tag, name, type, x: r2((b.minX + b.maxX) / 2), y: r2((b.minY + b.maxY) / 2) });
  renderMap();
  renderSidebar();
}
function deleteLink(l: MapLink) {
  links = links.filter((x) => !(x.tagA === l.tagA && x.tagB === l.tagB));
  renderMap();
  renderSidebar();
}
function addLink() {
  const a = (document.getElementById('l-a') as HTMLSelectElement).value;
  const b = (document.getElementById('l-b') as HTMLSelectElement).value;
  if (!a || !b || a === b) {
    setStatus('请选择两个不同的节点');
    return;
  }
  const k1 = `${a}|${b}`;
  const k2 = `${b}|${a}`;
  if (links.some((l) => `${l.tagA}|${l.tagB}` === k1 || `${l.tagA}|${l.tagB}` === k2)) {
    setStatus('连线已存在');
    return;
  }
  links.push({ tagA: a, tagB: b });
  renderMap();
  renderSidebar();
}

/* ───────────────────────────── 导出 ───────────────────────────── */
function exportXlsx() {
  const out = XLSX.utils.book_new();
  const mpRows = nodes.map((n) => ({
    tag: n.tag,
    name: n.name,
    type: n.type,
    taskType: n.type === 'city' ? (n.taskTypes || []).join(';') : '',
    state: n.type === 'city' ? n.state || '' : '',
    x: n.x,
    y: n.y,
  }));
  XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet(mpRows), 'mapPoint');
  const mlRows = links.map((l) => ({ tagA: l.tagA, tagB: l.tagB }));
  XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet(mlRows), 'mapPointLink');
  // 保留其余表（state / attrLv / skill / recipe …）原样写回
  for (const name of originalSheetNames) {
    if (name === 'city' || name === 'cityLink' || name === 'mapPoint' || name === 'mapPointLink') continue;
    XLSX.utils.book_append_sheet(out, originalWb.Sheets[name], name);
  }
  const buf = XLSX.write(out, { bookType: 'xlsx', type: 'array' });
  download(new Blob([buf]), 'firstShow_V5.xlsx');
  setStatus('已导出 xlsx（mapPoint 版，其余表原样保留）');
}
function exportJson() {
  const b = bounds();
  const cities = nodes
    .filter((n) => n.type === 'city')
    .map((n) => ({ id: n.tag, name: n.name, x: r2(n.x), y: r2(n.y), state: n.state || undefined, taskTypes: n.taskTypes || [] }));
  const waypoints = nodes
    .filter((n) => n.type === 'waypoint')
    .map((n) => ({ id: n.tag, name: n.name, x: r2(n.x), y: r2(n.y) }));
  const st = states.map((s) => ({ tag: s.tag, name: s.name, color: s.color }));
  const roads = links.map((l, i) => ({ id: `r${i + 1}`, pointRefs: [l.tagA, l.tagB] }));
  const model = {
    meta: {
      name: `sanwalk 坐标点地图（${cities.length}城/${waypoints.length}拐点/${st.length}州，编辑器导出）`,
      width: Math.ceil(b.maxX - b.minX),
      height: Math.ceil(b.maxY - b.minY),
    },
    cities,
    waypoints,
    states: st,
    roads,
  };
  download(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }), 'point-map.json');
  setStatus('已导出 json（含 waypoints）');
}

/* ───────────────────────────── 事件绑定 ───────────────────────────── */
document.getElementById('file')!.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const wb = XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' });
    parseWorkbook(wb);
  };
  reader.readAsArrayBuffer(file);
});
document.getElementById('btn-open')!.onclick = () => document.getElementById('file')!.click();
document.getElementById('btn-export-xlsx')!.onclick = exportXlsx;
document.getElementById('btn-export-json')!.onclick = exportJson;
document.getElementById('btn-add-node')!.onclick = addNode;
document.getElementById('btn-add-link')!.onclick = addLink;

/* ── 连线端点筛选框：输入即过滤；回车快捷路径 ── */
for (const side of ['a', 'b'] as const) {
  const q = document.getElementById(`l-${side}-q`) as HTMLInputElement;
  const sel = document.getElementById(`l-${side}`) as HTMLSelectElement;
  q.addEventListener('input', () => filterLinkOptions(side));
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const visible = Array.from(sel.options).filter((o) => o.style.display !== 'none');
    if (visible.length === 1) {
      // 唯一匹配 → 直接选中并新增，省一次点击
      sel.value = visible[0].value;
      addLink();
    } else if (visible.length > 1) {
      sel.focus(); // 多个匹配 → 聚焦到选择框，从过滤后的短列表里挑
    } else {
      setStatus('无匹配节点');
    }
  });
}

/* ── 下方连线列表筛选框：输入即过滤；清空恢复全部显示 ── */
const linkListQ = document.getElementById('link-q') as HTMLInputElement;
linkListQ.addEventListener('input', () => {
  linkFilter = linkListQ.value;
  renderSidebar();
});

/* ── 视图整体缩放滑条 ── */
const viewZoomSlider = document.getElementById('view-zoom') as HTMLInputElement;
const viewZoomVal = document.getElementById('view-zoom-val')!;
viewZoomSlider.addEventListener('input', () => {
  const v = Number(viewZoomSlider.value);
  if (!Number.isFinite(v) || v <= 0) return;
  viewZoom = v;
  viewZoomVal.textContent = `${Math.round(v * 100)}%`;
  applyView();
});
// 窗口尺寸变化 → 基准比例失效，按新可视区重算（保持视图形心内容点）
window.addEventListener('resize', () => {
  viewBase = null;
  applyView();
});

/* ── 底图控件 ── */
// 位移 / 缩放 / 显隐会改变内容矩形 → 每次变更后重算 viewBox 与滚动范围
(document.getElementById('bg1-vis') as HTMLInputElement).onchange = (e) => {
  bgState.visible[0] = (e.target as HTMLInputElement).checked;
  applyBgVisibility(0);
  applyView();
};
(document.getElementById('bg2-vis') as HTMLInputElement).onchange = (e) => {
  bgState.visible[1] = (e.target as HTMLInputElement).checked;
  applyBgVisibility(1);
  applyView();
};
for (const [id, key] of [['bg-dx', 'dx'], ['bg-dy', 'dy']] as const) {
  document.getElementById(id)!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    bgState[key] = Number.isFinite(v) ? v : 0;
    applyBgRects();
    applyView();
  });
}
for (const [id, key] of [['bg-scale-x', 'scaleX'], ['bg-scale-y', 'scaleY']] as const) {
  document.getElementById(id)!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0) bgState[key] = v; // 非法值忽略，避免缩放成 0
    applyBgRects();
    applyView();
  });
}
/* 浓度：滑条 + 数字输入双向同步（小数 0~1，step 0.01；非法输入保持原值） */
for (const [idx, sliderId, numId] of [
  [0, 'bg1-op', 'bg1-op-num'],
  [1, 'bg2-op', 'bg2-op-num'],
] as const) {
  const slider = document.getElementById(sliderId) as HTMLInputElement;
  const numEl = document.getElementById(numId) as HTMLInputElement;
  const apply = (raw: number): void => {
    const v = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : bgState.opacity[idx];
    bgState.opacity[idx] = Math.round(v * 100) / 100; // 两位小数，避免 0.30000000000000004 类浮点噪声
    slider.value = String(bgState.opacity[idx]);
    numEl.value = String(bgState.opacity[idx]);
    applyBgVisibility(idx);
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  numEl.addEventListener('input', () => apply(Number(numEl.value)));
}

/* ───────────────────────────── 启动：自动加载项目 xlsx ───────────────────────────── */
async function loadFromUrl(url: string) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    parseWorkbook(wb);
  } catch (err) {
    setStatus(`自动加载 ${url} 失败：${(err as Error).message}（请点“打开 xlsx”手动选择）`);
  }
}
loadFromUrl(DEFAULT_XLSX_URL);
