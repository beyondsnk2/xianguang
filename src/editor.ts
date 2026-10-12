/**
 * sanwalk 地图编辑器（独立页面，挂在 vite dev 下 /editor.html）。
 * 功能：基于 xlsx 生成可拖动地图（城市 / 拐点 / 连线），左侧拖动改坐标，右侧增删节点与连线，导出 mapPoint 版 xlsx 与 json。
 * 数据模型遵循「mapPoint 一张表用 type 区分 city/waypoint；mapPointLink 表达任意两点连通」的设计。
 * 读取兼容旧表名（city / cityLink），导出统一为新表名（mapPoint / mapPointLink）。
 */
import * as XLSX from 'xlsx';

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
const BG_URLS = ['/bg1.png', '/bg2.png'];
const bgState = {
  visible: [true, false] as boolean[],   // bg1 默认显示，bg2 默认隐藏
  opacity: [1, 0.85] as number[],
  dx: 0, dy: 0, scale: 1,                // 两张图共用的位移 / 缩放（围绕区域中心）
};
let bgEls: (SVGImageElement | null)[] = [null, null];

let nodes: MapNode[] = [];
let links: MapLink[] = [];
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
      <span>缩放</span><input type="number" id="bg-scale" class="num" step="0.01" value="1" />
    </div>
    <div class="bg-ctrl">
      <span>bg1浓度</span><input type="range" id="bg1-op" min="0" max="1" step="0.05" value="1" />
      <span>bg2浓度</span><input type="range" id="bg2-op" min="0" max="1" step="0.05" value="0.85" />
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
      <select id="l-a"></select> — <select id="l-b"></select>
      <button id="btn-add-link">＋ 新增</button>
    </div>
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
.svg-wrap{flex:1;overflow:hidden;background:radial-gradient(circle at 50% 40%, #2a2418, #15110b)}
#map{width:100%;height:100%}
.side-pane{width:320px;background:#1c160d;border-left:1px solid #3a2e1a;padding:12px;overflow:auto}
.side-pane h3{margin:14px 0 6px;color:#c9a24a;font-size:14px}
.bg-ctrl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#b8a98a;margin:4px 0}
.bg-ctrl input[type="checkbox"]{accent-color:#c9a24a}
.bg-ctrl input[type="range"]{flex:1;min-width:60px;accent-color:#c9a24a}
.bg-ctrl .num{width:64px;background:#2a2218;color:#e8e0cf;border:1px solid #3a2e1a;padding:3px 4px}
.add-node input,.add-link select{background:#2a2218;color:#e8e0cf;border:1px solid #3a2e1a;padding:4px;margin:2px}
.add-node button,.add-link button{background:#c9a24a;color:#1a140c;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;margin:2px}
#node-list,#link-list{list-style:none;padding:0;margin:0}
#node-list li,#link-list li{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #2a2218;font-size:13px}
#node-list .tag{font-weight:600;color:#c9a24a}
#node-list .ty{color:#8a7a5a;font-size:11px}
#node-list button,#link-list button{margin-left:auto;background:#a44;color:#fff;border:0;padding:2px 8px;border-radius:3px;cursor:pointer}
`;
document.head.appendChild(style);

svgEl = document.getElementById('map') as unknown as SVGSVGElement;

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

  const ptRows: any[] =
    wb.SheetNames.includes('mapPoint')
      ? (XLSX.utils.sheet_to_json(wb.Sheets['mapPoint'], { defval: null }) as any[])
      : [];
  if (!ptRows.length && wb.SheetNames.includes('city')) {
    ptRows.push(...(XLSX.utils.sheet_to_json(wb.Sheets['city'], { defval: null }) as any[]));
  }
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
    .filter((n) => n.tag && Number.isFinite(n.x) && Number.isFinite(n.y));

  const linkRows: any[] =
    wb.SheetNames.includes('mapPointLink')
      ? (XLSX.utils.sheet_to_json(wb.Sheets['mapPointLink'], { defval: null }) as any[])
      : [];
  if (!linkRows.length && wb.SheetNames.includes('cityLink')) {
    linkRows.push(...(XLSX.utils.sheet_to_json(wb.Sheets['cityLink'], { defval: null }) as any[]));
  }
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
function applyBgTransform(img: SVGImageElement) {
  const b = bounds();
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  // 位移 + 围绕区域中心的缩放
  img.setAttribute(
    'transform',
    `translate(${bgState.dx},${bgState.dy}) translate(${cx},${cy}) scale(${bgState.scale}) translate(${-cx},${-cy})`
  );
}
function applyBgVisibility(i: number) {
  const el = bgEls[i];
  if (!el) return;
  el.style.display = bgState.visible[i] ? '' : 'none';
  el.setAttribute('opacity', String(bgState.opacity[i]));
}

/* ───────────────────────────── 渲染地图 ───────────────────────────── */
function renderMap() {
  const b = bounds();
  const W = b.maxX - b.minX;
  const H = b.maxY - b.minY;
  svgEl.setAttribute('viewBox', `${b.minX} ${b.minY} ${W} ${H}`);
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  nodeEls.clear();
  linkElMap.clear();

  // 底图：垫在最底层（城市之下），铺满当前区域矩形
  bgEls = [null, null];
  for (let i = 0; i < BG_URLS.length; i++) {
    const img = document.createElementNS(SVGNS, 'image') as SVGImageElement;
    img.setAttribute('href', BG_URLS[i]);
    img.setAttribute('x', String(b.minX));
    img.setAttribute('y', String(b.minY));
    img.setAttribute('width', String(W));
    img.setAttribute('height', String(H));
    img.setAttribute('preserveAspectRatio', 'none');
    img.style.pointerEvents = 'none'; // 不挡节点的拖动
    img.addEventListener('error', () => {
      img.style.display = 'none';
      setStatus(`底图 ${BG_URLS[i]} 加载失败（public/ 下缺文件？）`);
    });
    svgEl.appendChild(img);
    bgEls[i] = img;
    applyBgTransform(img);
    applyBgVisibility(i);
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
window.addEventListener('mousemove', (e) => {
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
  dragging = null;
});

/* ───────────────────────────── 右侧面板 ───────────────────────────── */
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

  const ll = document.getElementById('link-list')!;
  ll.innerHTML = '';
  for (const l of links) {
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

/* ── 底图控件 ── */
(document.getElementById('bg1-vis') as HTMLInputElement).onchange = (e) => {
  bgState.visible[0] = (e.target as HTMLInputElement).checked;
  applyBgVisibility(0);
};
(document.getElementById('bg2-vis') as HTMLInputElement).onchange = (e) => {
  bgState.visible[1] = (e.target as HTMLInputElement).checked;
  applyBgVisibility(1);
};
for (const [id, key] of [['bg-dx', 'dx'], ['bg-dy', 'dy']] as const) {
  document.getElementById(id)!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    bgState[key] = Number.isFinite(v) ? v : 0;
    for (const el of bgEls) if (el) applyBgTransform(el);
  });
}
document.getElementById('bg-scale')!.addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 0) bgState.scale = v; // 非法值忽略，避免缩放成 0
  for (const el of bgEls) if (el) applyBgTransform(el);
});
for (const [id, idx] of [['bg1-op', 0], ['bg2-op', 1]] as const) {
  document.getElementById(id)!.addEventListener('input', (e) => {
    bgState.opacity[idx] = Number((e.target as HTMLInputElement).value);
    applyBgVisibility(idx);
  });
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
