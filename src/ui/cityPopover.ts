/**
 * 城市悬停 tooltip + 点击弹窗（地图锚定 popover）。
 *
 * 设计决议（2026-10-14，与用户确认）：
 *  - 形态：地图锚定 popover，不用左菜单 modal（modal 每 250ms 重建 + 遮罩挡地图）
 *  - 不做信息遮蔽：未造访城同样显示全部信息，只以徽章区分状态
 *  - 弹窗关闭：点弹窗外 / 弹窗内 ✕ / Esc；点同一城再点一次也可关
 *  - 定位：四向候选（右/左/下/上）→ 夹紧进地图面板 → 优先「不压住悬停城」且「离面板中心最近」
 *
 * 数据装配（buildCityInfo）与渲染分离；定位算法为纯函数，不碰 DOM。
 */
import { EVENT_DEFS } from '../game/event';
import { currentCell } from '../game/tick';
import { buildSubCatFacility, DEMAND_RATIO, BUY_PREMIUM, getDemand } from '../game/economy';
import { vpathFromPoint, vdist, type VGraph } from '../game/vgraph';
import { FAC_FALLBACK } from '../render/mapStyle';
import type { GameConfig, GameState } from '../game/types';
import { esc, fmtDur, itemName } from './format';

// ────────────────────────────── 数据装配 ──────────────────────────────

export interface CityFacilityInfo {
  /** 设施类型（nodeType，如 mine） */
  type: string;
  /** 设施中文名（tasks.nodeName，兜底 FAC_FALLBACK） */
  name: string;
  /** 任务类别 A/B/C（该设施任一任务的 cls） */
  cls: string;
  /** 本城是该设施的产地（demand 本地档）时的材料名列表 */
  localMats: string[];
}

export interface CityNeighborInfo {
  tag: string;
  name: string;
  /** 几何路径距离（坐标单位，1 位小数） */
  dist: number;
}

export interface CityRecipeBind {
  role: 'craft' | 'rare' | 'blueprint';
  name: string;
}

export interface CityInfo {
  tag: string;
  name: string;
  stateName: string | null;
  isStart: boolean;
  visited: boolean;
  /** 路径距离（几何）；不可达为 null */
  dist: number | null;
  /** 赶路时长（秒，1 倍速口径 = dist × values.speed）；不可达为 null */
  travelSec: number | null;
  facilities: CityFacilityInfo[];
  neighbors: CityNeighborInfo[];
  /** 本城产地材料名（demand 本地档 0.8× 的 subCat） */
  localSubCats: string[];
  recipes: CityRecipeBind[];
  /** 仅在本城触发的随机事件标题（EVENT_DEFS.cities 白名单） */
  eventTitles: string[];
  /** 任务板中目标为该城的任务数 */
  taskCount: number;
}

/** subCat → 展示名（取该 subCat 任一物品的中文名；查不到回显 subCat） */
function matName(cfg: GameConfig, sub: string): string {
  const it = cfg.items.find((i) => i.subCat === sub);
  return it ? itemName(it.tag, cfg) : sub;
}

/** 装配单座城市的全部弹窗信息（纯 cfg/state/vgraph 派生，确定性） */
export function buildCityInfo(
  cfg: GameConfig,
  state: GameState,
  vgraph: VGraph | null,
  tag: string,
): CityInfo | null {
  const cp = cfg.cityPointByTag[tag];
  const def = cfg.cityByTag[tag];
  if (!cp && !def) return null;
  const name = cp?.name ?? def?.name ?? tag;
  const stateTag = cp?.state ?? def?.state ?? null;
  const stateName = stateTag ? cfg.stateByTag[stateTag]?.name ?? null : null;

  // 路途：从角色实时位置（移动中取路径插值点）寻路到该城
  let dist: number | null = null;
  let travelSec: number | null = null;
  if (vgraph) {
    const p = vpathFromPoint(vgraph, currentCell(state), tag);
    if (p) {
      dist = Math.round(p.cost * 10) / 10;
      travelSec = p.cost * cfg.values.speed;
    }
  }

  // 产地：demand 本地档（DEMAND_RATIO.local = 0.8）的 subCat → 反查产出设施
  const demand = getDemand(cfg);
  const subFac = buildSubCatFacility(cfg); // subCat → 产出它的设施 nodeType
  const localSubs = Object.entries(demand[tag] ?? {})
    .filter(([, r]) => r === DEMAND_RATIO.local)
    .map(([s]) => s);
  const localByFac = new Map<string, string[]>();
  for (const s of localSubs) {
    const f = subFac[s];
    if (!f) continue;
    const list = localByFac.get(f) ?? [];
    list.push(matName(cfg, s));
    localByFac.set(f, list);
  }

  // 设施列表：taskTypes → 中文名 + 类别角标 + 产地标记
  const taskTypes = cp?.taskTypes ?? def?.taskTypes ?? [];
  const facilities: CityFacilityInfo[] = taskTypes.map((t) => {
    const anyTask = cfg.tasks.find((x) => x.nodeType === t);
    return {
      type: t,
      name: anyTask?.nodeName ?? FAC_FALLBACK[t] ?? t,
      cls: anyTask?.cls ?? '',
      localMats: localByFac.get(t) ?? [],
    };
  });

  // 邻城：cityLink 反查 + 几何距离，近者在前
  const neighbors: CityNeighborInfo[] = [];
  for (const l of cfg.links) {
    const other = l.tagA === tag ? l.tagB : l.tagB === tag ? l.tagA : null;
    if (!other) continue;
    const d = vgraph ? vdist(vgraph, tag, other) : null;
    if (d == null) continue;
    neighbors.push({ tag: other, name: cfg.cityByTag[other]?.name ?? other, dist: Math.round(d * 10) / 10 });
  }
  neighbors.sort((a, b) => a.dist - b.dist);

  // 配方属地：cityCraft/cityRare/cityBlueprint 反查（同族多阶共名，按 角色+名 去重）
  const recipes: CityRecipeBind[] = [];
  const seenRp = new Set<string>();
  for (const r of cfg.recipes) {
    const push = (role: CityRecipeBind['role'], nm: string): void => {
      const k = `${role}|${nm}`;
      if (seenRp.has(k)) return;
      seenRp.add(k);
      recipes.push({ role, name: nm });
    };
    if (r.cityCraftTag === tag) push('craft', r.name);
    if (r.cityRareTag === tag) push('rare', r.name);
    if (r.cityBlueprintTag === tag) push('blueprint', cfg.blueprintByTag[r.needBlueprint]?.name ?? r.needBlueprint);
  }

  // 事件白名单 + 任务板关联
  const eventTitles = EVENT_DEFS.filter((e) => e.cities?.includes(tag)).map((e) => e.title);
  const taskCount = state.slots.filter((s) => s.kind === 'task' && s.task.cityTag === tag).length;

  return {
    tag,
    name,
    stateName,
    isStart: state.startCity === tag,
    visited: state.visitedCities.includes(tag),
    dist,
    travelSec,
    facilities,
    neighbors,
    localSubCats: localSubs.map((s) => matName(cfg, s)),
    recipes,
    eventTitles,
    taskCount,
  };
}

// ────────────────────────────── 渲染 ──────────────────────────────

const CLS_BADGE: Record<string, string> = {
  A: '<i class="cls-a">采</i>',
  B: '<i class="cls-b">制</i>',
  C: '<i class="cls-c">人</i>',
};

/** 悬停 tooltip（4 行以内：城名/州 · 距离/赶路 · 造访状态 · 设施名） */
export function cityTipHtml(info: CityInfo): string {
  const vis = info.isStart
    ? '<div class="ct-vis start">出生地</div>'
    : info.visited
      ? '<div class="ct-vis on">已造访</div>'
      : '<div class="ct-vis off">未造访</div>';
  const travel =
    info.dist == null || info.travelSec == null
      ? '<b>不可达</b>'
      : `距离 <b>${info.dist}</b> · 赶路约 <b>${fmtDur(info.travelSec)}</b>`;
  return (
    `<div class="ct-head"><span class="ct-name">${esc(info.name)}</span>` +
    (info.stateName ? `<span class="ct-state">${esc(info.stateName)}</span>` : '') +
    `</div>` +
    `<div class="ct-row">${travel}</div>` +
    vis +
    (info.facilities.length
      ? `<div class="ct-facs">${info.facilities.map((f) => esc(f.name)).join(' · ')}</div>`
      : '')
  );
}

const RECIPE_ROLE: Record<CityRecipeBind['role'], string> = {
  craft: '成品',
  rare: '稀有',
  blueprint: '图纸',
};

/** 弹窗 body：P0 三区（路途/设施/邻城）+ P1 四区（供需/配方/传闻/任务） */
export function cityPopBodyHtml(info: CityInfo): string {
  const row = (k: string, v: string, sec = false): string =>
    `<div class="cp-row${sec ? ' cp-sec' : ''}"><span class="cp-k">${k}</span><span class="cp-v">${v}</span></div>`;

  const rows: string[] = [];
  rows.push(
    row(
      '路途',
      info.dist == null || info.travelSec == null
        ? '<span class="cp-bad">不可达</span>'
        : `路径距离 ${info.dist} · 赶路约 ${fmtDur(info.travelSec)}`,
    ),
  );

  const facs = info.facilities.length
    ? info.facilities
        .map((f) => {
          const badge = CLS_BADGE[f.cls] ?? '';
          const loc = f.localMats.length
            ? ` <span class="cp-loc">产地·${f.localMats.map(esc).join('/')}</span>`
            : '';
          return `<span class="chip">${esc(f.name)} ${badge}${loc}</span>`;
        })
        .join('')
    : '—';
  rows.push(row('设施', facs));

  const nbs = info.neighbors.length
    ? info.neighbors
        .map((n) => `<button class="cp-city-btn" data-city="${n.tag}">${esc(n.name)} ${n.dist}</button>`)
        .join('<span class="cp-sep">·</span>')
    : '—';
  rows.push(row('邻城', nbs));

  const sup = info.localSubCats.length
    ? `本地便宜：${info.localSubCats.map(esc).join('、')} 0.8×`
    : '非产地城';
  rows.push(row('城际供需', `${sup} · 补货买料 ${BUY_PREMIUM}×`, true));

  const rp = info.recipes.length
    ? info.recipes.map((r) => `${RECIPE_ROLE[r.role]}·${esc(r.name)}`).join('　')
    : '—';
  rows.push(row('配方属地', rp, true));

  rows.push(
    row(
      '本城传闻',
      info.eventTitles.length
        ? `${info.eventTitles.length} 条仅此城触发：${info.eventTitles.map(esc).join('、')}`
        : '无',
      true,
    ),
  );
  rows.push(row('任务关联', info.taskCount ? `任务板 ${info.taskCount} 个任务目标在此城` : '暂无', true));

  return rows.join('');
}

// ────────────────────────────── 定位（纯函数） ──────────────────────────────

interface Box {
  w: number;
  h: number;
}
interface Pt {
  x: number;
  y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** tooltip 跟随鼠标：默认右下，越界翻左上，最后夹紧进面板（保证完整可见） */
export function placeTip(pane: Box, cur: Pt, size: Box, m = 8): Pt {
  let x = cur.x + 16;
  let y = cur.y + 16;
  if (x + size.w + m > pane.w) x = cur.x - 16 - size.w;
  if (y + size.h + m > pane.h) y = cur.y - 16 - size.h;
  return { x: clamp(x, m, pane.w - m - size.w), y: clamp(y, m, pane.h - m - size.h) };
}

/**
 * popover 锚定城市：四向候选（右/左/下/上）→ 夹紧进面板 →
 * 优先「不压住城市 glyph」且「弹窗中心离面板中心最近」的候选。
 * 城市在面板正附近四向都躲不开时，退化为压得最少 + 最靠中心。
 */
export function placePopover(pane: Box, anchor: Pt, size: Box, cityR = 16, m = 8): Pt {
  const cands: Pt[] = [
    { x: anchor.x + cityR + 6, y: anchor.y - size.h / 2 },
    { x: anchor.x - cityR - 6 - size.w, y: anchor.y - size.h / 2 },
    { x: anchor.x - size.w / 2, y: anchor.y + cityR + 6 },
    { x: anchor.x - size.w / 2, y: anchor.y - cityR - 6 - size.h },
  ];
  const cx = pane.w / 2;
  const cy = pane.h / 2;
  let best: Pt = cands[0];
  let bestScore = -Infinity;
  for (const c of cands) {
    const x = clamp(c.x, m, pane.w - m - size.w);
    const y = clamp(c.y, m, pane.h - m - size.h);
    const coversCity =
      Math.abs(x + size.w / 2 - anchor.x) < size.w / 2 + cityR &&
      Math.abs(y + size.h / 2 - anchor.y) < size.h / 2 + cityR;
    const score = (coversCity ? -10000 : 0) - Math.hypot(x + size.w / 2 - cx, y + size.h / 2 - cy);
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}
