import type { CellVal, SheetLike } from './xlsxSource';
import {
  ATTR_KEYS,
  type AttrKey,
  type AttrLvRow,
  type Cell,
  type CityDef,
  type ConfigMeta,
  type GameConfig,
  type MapNodeDef,
  type MapRoadDef,
  type Range,
  type TaskDef,
} from '../game/types';

// ───────────────────────── 通用取值助手 ─────────────────────────

function asStr(v: CellVal): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

function asNum(v: CellVal, fallback = NaN): number {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return v;
  const n = Number(asStr(v));
  return Number.isFinite(n) ? n : fallback;
}

/** 'a;b' / 'a,b' → ['a','b']（分隔符兼容分号与逗号，统一按分号语义处理） */
function splitList(v: CellVal): string[] {
  const s = asStr(v);
  if (!s) return [];
  return s
    .split(/[;,，；]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** '5;7' → {min:5,max:7}；单值 '5' → {min:5,max:5} */
function parseRange(v: CellVal): Range | null {
  const parts = splitList(v).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 1) return { min: parts[0], max: parts[0] };
  const min = Math.min(parts[0], parts[1]);
  const max = Math.max(parts[0], parts[1]);
  return { min, max };
}

/** '8:9' → {x:8,y:9} */
function parseCell(s: string): Cell | null {
  const m = /^(-?\d+)\s*[:：]\s*(-?\d+)$/.exec(s.trim());
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * position 解析：
 *  - '8:9'        → 1 格
 *  - '10:10;11:11' → 矩形对角（左上 + 右下）→ 展开为 2×2 = 4 格
 */
function parseCells(v: CellVal): Cell[] {
  const parts = splitList(v);
  if (parts.length === 1) {
    const c = parseCell(parts[0]);
    return c ? [c] : [];
  }
  const corners = parts.map(parseCell);
  if (corners.length < 2 || corners.some((c) => !c)) return [];
  const a = corners[0] as Cell;
  const b = corners[corners.length - 1] as Cell;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  const out: Cell[] = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) out.push({ x, y });
  return out;
}

// ───────────────────────── 表解析规则 ─────────────────────────

type RowObj = Record<string, CellVal>;

/**
 * 《配置读取规范.md》解析规则：
 *  1. 跳过 `$` 开头的表（$caogao / $map / $mapRoute）
 *  2. 只保留第 1 行有字段名的列；无表头的列整列丢弃
 *  3. 空行跳过
 * 附：重复表头（如两列都叫 tag）取「有数据的那一列」，避免互相覆盖
 */
export function sheetToObjects(rows: CellVal[][]): RowObj[] {
  if (!rows.length) return [];
  const rawHeader = rows[0] ?? [];
  const header = rawHeader.map((h) => asStr(h));

  // 按字段名分组列下标
  const byName = new Map<string, number[]>();
  header.forEach((h, i) => {
    if (!h) return; // 无表头 → 整列丢弃
    const list = byName.get(h) ?? [];
    list.push(i);
    byName.set(h, list);
  });

  const body = rows.slice(1);
  // 重复表头：优先取有数据的列
  const chosen = new Map<string, number>();
  for (const [name, cols] of byName) {
    let pick = cols[0];
    if (cols.length > 1) {
      const withData = cols.find((ci) => body.some((r) => (r?.[ci] ?? null) !== null && asStr(r?.[ci] ?? null) !== ''));
      if (withData !== undefined) pick = withData;
    }
    chosen.set(name, pick);
  }

  const out: RowObj[] = [];
  for (const row of body) {
    const obj: RowObj = {};
    let any = false;
    for (const [name, ci] of chosen) {
      const v = row?.[ci] ?? null;
      const s = asStr(v);
      obj[name] = typeof v === 'number' ? v : s === '' ? null : s;
      if (obj[name] !== null) any = true;
    }
    if (!any) continue; // 空行跳过
    out.push(obj);
  }
  return out;
}

export function filterSheets(sheets: SheetLike[]): SheetLike[] {
  return sheets.filter((s) => !s.name.startsWith('$'));
}

// ───────────────────────── 结构化 ─────────────────────────

export interface ParsedConfig {
  config: GameConfig;
  warnings: string[];
}

export function parseWorkbook(sheets: SheetLike[], meta: Omit<ConfigMeta, 'sheets'>): ParsedConfig {
  const warnings: string[] = [];
  const tables: Record<string, RowObj[]> = {};
  const names: string[] = [];
  for (const s of sheets) {
    if (s.name.startsWith('$')) continue; // 规则 1
    names.push(s.name);
    tables[s.name] = sheetToObjects(s.rows);
  }

  // task
  const tasks: TaskDef[] = (tables['task'] ?? []).map((r) => ({
    tag: asStr(r['tag']),
    name: asStr(r['name']),
    nodeType: asStr(r['nodeType']),
    nodeName: asStr(r['nodeName']),
    needTime: asNum(r['needTime'], 60),
    getItem: asStr(r['getItem']) || null,
    getItemNum: parseRange(r['getItemNum']),
    getAttrXp: (asStr(r['getAttrXp']) as AttrKey) || null,
    getAttrXpNum: parseRange(r['getAttrXpNum']),
  })).filter((t) => t.tag);

  // city
  const cities: CityDef[] = (tables['city'] ?? []).map((r) => ({
    tag: asStr(r['tag']),
    name: asStr(r['name']),
    taskTypes: splitList(r['taskType']),
  })).filter((c) => c.tag);

  // mapNode
  const nodes: MapNodeDef[] = (tables['mapNode'] ?? []).map((r) => ({
    tag: asNum(r['tag'], NaN),
    name: asStr(r['name']),
    cells: parseCells(r['position']),
    belong: asStr(r['belong']) || null,
  })).filter((n) => Number.isFinite(n.tag) && n.cells.length > 0);

  // mapRoad
  const roads: MapRoadDef[] = (tables['mapRoad'] ?? []).map((r) => {
    const cells = parseCells(r['position']);
    return {
      tag: asNum(r['tag'], NaN),
      name: asStr(r['name']) || 'road',
      cell: cells[0] ?? { x: -1, y: -1 },
      roadType: asStr(r['roadType']) || 'plain',
    };
  }).filter((r) => Number.isFinite(r.tag) && r.cell.x >= 0);

  // attrLv
  const attrLv: AttrLvRow[] = (tables['attrLv'] ?? [])
    .map((r) => ({ lv: asNum(r['lv'], NaN), num: asNum(r['num'], NaN) }))
    .filter((r) => Number.isFinite(r.lv) && Number.isFinite(r.num));
  const needByLv: (number | null)[] = [null];
  for (const row of attrLv) needByLv[row.lv] = row.num;
  const attrLvNeed = (lv: number): number | null => needByLv[lv] ?? null;

  // config
  const rawCfg: Record<string, CellVal> = {};
  for (const r of tables['config'] ?? []) {
    const tag = asStr(r['tag']);
    if (tag) rawCfg[tag] = r['content'] ?? null;
  }
  const values = {
    speed: asNum(rawCfg['speed'], 20),
    backPackSlotNum: asNum(rawCfg['backPackSlotNum'], 6),
    itemStacking: asNum(rawCfg['itemStacking'], 5),
    initTaskListSlot: asNum(rawCfg['initTaskListSlot'], 7),
    startCityRand: splitList(rawCfg['startCityRand']),
    initAttr: {} as Record<AttrKey, Range>,
  };
  const initRangeCfg: [AttrKey, string][] = [
    ['force', 'initForce'],
    ['leadership', 'initLeadership'],
    ['intelligent', 'initIntelligence'],
    ['politics', 'initPolitics'],
  ];
  for (const [key, tag] of initRangeCfg) {
    values.initAttr[key] = parseRange(rawCfg[tag]) ?? { min: 2, max: 5 };
  }

  const taskByTag: Record<string, TaskDef> = {};
  for (const t of tasks) taskByTag[t.tag] = t;
  const cityByTag: Record<string, CityDef> = {};
  for (const c of cities) cityByTag[c.tag] = c;
  const nodeByTag: Record<number, MapNodeDef> = {};
  for (const n of nodes) nodeByTag[n.tag] = n;

  const config: GameConfig = {
    meta: { ...meta, sheets: names },
    tasks,
    taskByTag,
    cities,
    cityByTag,
    nodes,
    nodeByTag,
    roads,
    attrLv,
    attrLvNeed,
    values,
  };

  // ── 校验 ──
  if (!tasks.length) warnings.push('task 表为空');
  if (!cities.length) warnings.push('city 表为空');
  if (!nodes.length) warnings.push('mapNode 表为空');
  if (!roads.length) warnings.push('mapRoad 表为空');
  for (const t of tasks) {
    const citiesHave = cities.filter((c) => c.taskTypes.includes(t.nodeType));
    if (citiesHave.length !== 2) {
      warnings.push(`任务 ${t.tag}(${t.name}) 的设施 ${t.nodeType} 命中 ${citiesHave.length} 座城，预期 2 座`);
    }
    for (const c of citiesHave) {
      const hit = nodes.filter((n) => n.belong === c.tag && n.name === t.nodeType);
      if (hit.length !== 1) warnings.push(`${c.name}(${c.tag}) 的 ${t.nodeType} 节点数 = ${hit.length}，预期 1`);
    }
  }
  for (const k of ['speed', 'backPackSlotNum', 'itemStacking', 'initTaskListSlot']) {
    if (!(k in rawCfg)) warnings.push(`config 表缺少 ${k}，已使用默认值`);
  }
  if (!values.startCityRand.length) warnings.push('config.startCityRand 为空');
  for (const tag of values.startCityRand) {
    if (!cityByTag[tag]) warnings.push(`startCityRand 中的 ${tag} 不存在于 city 表`);
  }
  for (const key of ATTR_KEYS) void key;

  return { config, warnings };
}
