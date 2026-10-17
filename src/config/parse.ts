import type { CellVal, SheetLike } from './xlsxSource';
import { INIT_MONEY } from '../game/constants';
import {
  ATTR_KEYS,
  type AttrKey,
  type AttrLvRow,
  type BlueprintDef,
  type CityDef,
  type CityLinkDef,
  type ConfigMeta,
  type GameConfig,
  type ItemDef,
  type CityPoint,
  type Waypoint,
  type RoadLine,
  type MapBounds,
  type Bg1Config,
  type RegionDef,
  type PriceRow,
  type Range,
  type RecipeDef,
  type SkillDef,
  type StateDef,
  type SubCatRatioRow,
  type TaskDef,
  type ClassDef,
  type ClassAffinityRow,
  type ClassEffectRow,
  type ClassPromoteCondRow,
  type StandingDef,
  type AffLevel,
  type PromoteType,
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

/** '0.0/0.3/0.6/1.0' → [0, 0.3, 0.6, 1]（评价四档增量） */
function parseEvalInc(v: CellVal): number[] {
  const parts = asStr(v).split('/').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return [];
  return parts;
}

/** 'jingtie_4' → 'jingtie'（取物品品质子族） */
function subOf(tag: string): string {
  return tag.replace(/_\d+$/, '');
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
    cls: asStr(r['cls']) || '',
    skill: asStr(r['skill']),
    quality: asNum(r['quality'], 0),
    attrBaseline: asNum(r['attrBaseline'], 0),
    pinjie: asNum(r['pinjie'], 0),
    evalInc: parseEvalInc(r['evalInc']),
    mainOutput: asStr(r['mainOutput']),
    subOutput: asStr(r['subOutput']),
  })).filter((t) => t.tag);

  // 点位表：mapPoint（含 type 列：city/waypoint；无 type 列默认 city）。
  // 统一读入后按 type 分流为城市（CityDef + CityPoint）与拐点（Waypoint），两者同命名空间。
  const pointRows = tables['mapPoint'] ?? [];
  const cities: CityDef[] = [];
  const cityPoints: CityPoint[] = [];
  const cityPointByTag: Record<string, CityPoint> = {};
  const waypoints: Waypoint[] = [];
  for (const r of pointRows) {
    const tag = asStr(r['tag']);
    const name = asStr(r['name']);
    const x = asNum(r['x'], NaN);
    const y = asNum(r['y'], NaN);
    if (!tag || !name || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const type = asStr(r['type']) || 'city'; // 无 type 列 → 默认 city
    if (type === 'waypoint') {
      waypoints.push({ id: tag, tag, name, x, y });
    } else {
      const state = asStr(r['state']) || null;
      const taskTypes = splitList(r['taskType']);
      cities.push({ tag, name, x, y, taskTypes, state });
      const cp: CityPoint = { tag, name, x, y, state, taskTypes };
      cityPoints.push(cp);
      cityPointByTag[tag] = cp;
    }
  }

  // state（仅地理分组 + 着色标签，不进玩法逻辑）
  const states: StateDef[] = (tables['state'] ?? [])
    .map((r) => ({ tag: asStr(r['tag']), name: asStr(r['name']), color: asStr(r['color']) }))
    .filter((s) => s.tag && /^#[0-9a-fA-F]{6}$/.test(s.color));
  const stateByTag: Record<string, StateDef> = {};
  for (const s of states) stateByTag[s.tag] = s;

  // 全点位索引（城市 + 拐点，同命名空间），供连线端点校验与连通性判定
  const pointByTag: Record<string, { tag: string; x: number; y: number }> = {};
  for (const c of cities) pointByTag[c.tag] = c;
  for (const w of waypoints) pointByTag[w.tag] = w;

  // ── 向量地图层（坐标真相，直接由点位坐标 / 连线派生，无格子栅格化）──
  // 道路折线：mapPointLink（tagA/tagB 可引用任意点位 tag）
  const roadLines: RoadLine[] = (tables['mapPointLink'] ?? [])
    .map((r, i) => ({
      id: `rl${i + 1}`,
      refs: [asStr(r['tagA']), asStr(r['tagB'])] as [string, string],
      points: [],
    }))
    .filter((rl) => rl.refs[0] && rl.refs[1] && rl.refs[0] !== rl.refs[1]);
  // 坐标空间包围盒（含城市 + 拐点，外扩 pad 避免贴边）
  const pad = 20;
  const allX = cityPoints.map((c) => c.x);
  const allY = cityPoints.map((c) => c.y);
  const mapBounds: MapBounds = {
    w: Math.max(1, ...allX.map((x) => x)) + pad,
    h: Math.max(1, ...allY.map((y) => y)) + pad,
  };
  // 区域矩形：州仅为标签、不派生几何（去州化）。向量模式不再渲染州分区色块 → regions 始终为空。
  const regions: RegionDef[] = [];

  // attrLv
  const attrLv: AttrLvRow[] = (tables['attrLv'] ?? [])
    .map((r) => ({ lv: asNum(r['lv'], NaN), num: asNum(r['num'], NaN) }))
    .filter((r) => Number.isFinite(r.lv) && Number.isFinite(r.num));  const needByLv: (number | null)[] = [null];
  for (const row of attrLv) needByLv[row.lv] = row.num;
  const attrLvNeed = (lv: number): number | null => needByLv[lv] ?? null;

  const cityByTagEarly: Record<string, CityDef> = {};
  for (const c of cities) cityByTagEarly[c.tag] = c;
  const cityByName: Record<string, CityDef> = {};
  for (const c of cities) if (c.name) cityByName[c.name] = c;
  const cityTagOfName = (name: string): string | null =>
    cityByName[name]?.tag ?? (cityByTagEarly[name] ? name : null);

  // 连线（连通唯一事实源）：mapPointLink（端点可引用任意点位 tag）；dist 运行时按坐标几何实时算
  const links: CityLinkDef[] = (tables['mapPointLink'] ?? [])
    .map((r) => ({
      tagA: asStr(r['tagA']),
      tagB: asStr(r['tagB']),
    }))
    .filter((l) => l.tagA && l.tagB && l.tagA !== l.tagB);
  for (const l of links) {
    if (!pointByTag[l.tagA]) warnings.push(`连线端点 ${l.tagA} 不存在于点位表（mapPoint）`);
    if (!pointByTag[l.tagB]) warnings.push(`连线端点 ${l.tagB} 不存在于点位表（mapPoint）`);
    if (l.tagA === l.tagB) warnings.push(`连线自环：${l.tagA}`);
  }
  {
    const seen = new Set<string>();
    for (const l of links) {
      const k = l.tagA < l.tagB ? l.tagA + '|' + l.tagB : l.tagB + '|' + l.tagA;
      if (seen.has(k)) warnings.push(`mapPointLink 重复：${l.tagA}-${l.tagB}`);
      seen.add(k);
    }
  }
  // 连通性校验：基于全点位图（城市 + 拐点），所有点位应处同一连通分量；孤立城市（无连线）单独提示。
  {
    const allTags = Object.keys(pointByTag);
    if (allTags.length > 0) {
      const adj = new Map<string, string[]>();
      for (const t of allTags) adj.set(t, []);
      for (const l of links) {
        if (adj.has(l.tagA) && adj.has(l.tagB)) {
          adj.get(l.tagA)!.push(l.tagB);
          adj.get(l.tagB)!.push(l.tagA);
        }
      }
      const isolated = cities.filter((c) => (adj.get(c.tag)?.length ?? 0) === 0).map((c) => c.tag);
      if (isolated.length) warnings.push(`孤立城市（无任何连线）：${isolated.join(', ')}`);
      const start = cities[0]?.tag ?? allTags[0];
      const seenC = new Set<string>([start]);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nxt of adj.get(cur) ?? []) if (!seenC.has(nxt)) { seenC.add(nxt); stack.push(nxt); }
      }
      if (seenC.size < allTags.length) {
        const unreached = allTags.filter((t) => !seenC.has(t)).map((t) => t);
        warnings.push(`点位未全连通：仅 ${seenC.size}/${allTags.length} 点位可达，孤立分量含 ${unreached.join(', ')}`);
      }
    }
  }

  // skill（V2：9 技能 × A/B/C）
  const skillDefs: SkillDef[] = (tables['skill'] ?? []).map((r) => ({
    tag: asStr(r['tag']),
    name: asStr(r['name']),
    cls: asStr(r['cls']),
    mainNode: asStr(r['mainNode']),
    nodeName: asStr(r['nodeName']),
    pointCities: asStr(r['pointCities']),
    note: asStr(r['note']),
  })).filter((s) => s.tag);

  // classDefs / classAffinity / classPromoteCond / classEffect / standingDefs（V6 职业/身份系统）
  const classDefs: ClassDef[] = (tables['classDefs'] ?? []).map((r) => ({
    classType: asStr(r['classType']),
    name: asStr(r['name']),
    promoteCond: asStr(r['promoteCond']) || null,
    rankCount: asNum(r['rankCount'], 9),
    note: asStr(r['note']),
  })).filter((c) => c.classType);
  const classByTag: Record<string, ClassDef> = {};
  for (const c of classDefs) classByTag[c.classType] = c;

  const classAffinity: ClassAffinityRow[] = (tables['classAffinity'] ?? []).map((r) => ({
    classType: asStr(r['classType']),
    skill: asStr(r['skill']),
    aff: (asStr(r['aff']) === 'main' ? 'main' : asStr(r['aff']) === 'sub' ? 'sub' : 'main') as AffLevel,
  })).filter((a) => a.classType && a.skill);
  const classAffinityMap: Record<string, Record<string, AffLevel>> = {};
  for (const a of classAffinity) {
    if (!classAffinityMap[a.classType]) classAffinityMap[a.classType] = {};
    classAffinityMap[a.classType][a.skill] = a.aff;
  }

  const classPromoteCond: ClassPromoteCondRow[] = (tables['classPromoteCond'] ?? []).map((r) => ({
    condId: asStr(r['condId']),
    type: asStr(r['type']) as PromoteType,
    target: asStr(r['target']),
    threshold: asNum(r['threshold'], 0),
    note: asStr(r['note']),
  })).filter((c) => c.condId);
  const classPromoteCondByTag: Record<string, ClassPromoteCondRow> = {};
  for (const c of classPromoteCond) classPromoteCondByTag[c.condId] = c;

  const classEffect: ClassEffectRow[] = (tables['classEffect'] ?? []).map((r) => ({
    classType: asStr(r['classType']),
    rank: asNum(r['rank'], 1),
    effectKey: asStr(r['effectKey']),
    value: asNum(r['value'], 0),
    note: asStr(r['note']),
  })).filter((e) => e.classType && e.effectKey);

  const standingDefs: StandingDef[] = (tables['standingDefs'] ?? []).map((r) => ({
    standingTag: asStr(r['standingTag']),
    name: asStr(r['name']),
    reqClasses: asStr(r['reqClasses']),
    reqStandings: asStr(r['reqStandings']),
    note: asStr(r['note']),
  })).filter((s) => s.standingTag);
  const standingByTag: Record<string, StandingDef> = {};
  for (const s of standingDefs) standingByTag[s.standingTag] = s;

  // item（材料 27 / 稀有 54 / 成品 315 / 名品 3）
  const items: ItemDef[] = (tables['item'] ?? []).map((r) => {
    const tierRaw = asStr(r['tier']);
    return {
      tag: asStr(r['tag']),
      name: asStr(r['name']),
      cat: asStr(r['cat']),
      subCat: asStr(r['subCat']),
      tier: asNum(r['tier'], NaN),
      tierRaw,
      qMin: asNum(r['qMin'], 0),
      qMax: asNum(r['qMax'], 0),
      stack: asNum(r['stack'], 0),
      source: asStr(r['source']),
      // V4 经济列：旧配置无这两列 → 价格 0 / 可售 true，经济系统整体按「禁用」处理
      price: asNum(r['price'], 0),
      sellable: asNum(r['sellable'], 1) !== 0,
      note: asStr(r['note']),
    };
  }).filter((i) => i.tag);

  // price（V4 起）：cat × tier 基准价骨架。无此表 → 价格体系整体禁用
  const priceRows: PriceRow[] = (tables['price'] ?? []).map((r) => ({
    cat: asStr(r['cat']),
    tier: asNum(r['tier'], NaN),
    base: asNum(r['base'], 0),
    sellRatio: asNum(r['sellRatio'], 1),
    note: asStr(r['note']),
  })).filter((p) => p.cat && Number.isFinite(p.tier));
  const priceByKey: Record<string, number> = {};
  for (const p of priceRows) priceByKey[`${p.cat}|${p.tier}`] = p.base;

  // subCatRatio（V4 起）：稀有料稀缺系数。无此表 → 空对象（经济系统禁用时不参与）
  const subCatRatio: Record<string, SubCatRatioRow> = {};
  for (const r of tables['subCatRatio'] ?? []) {
    const sub = asStr(r['subCat']);
    if (!sub) continue;
    subCatRatio[sub] = {
      subCat: sub,
      skillPool: asStr(r['skillPool']),
      poolSize: asNum(r['poolSize'], 0),
      demandCount: asNum(r['demandCount'], 0),
      supplyShare: asNum(r['supplyShare'], 0),
      rawRatio: asNum(r['rawRatio'], 0),
      ratio: asNum(r['ratio'], 1),
      note: asStr(r['note']),
    };
  }

  // rareDropWeight（V4 / Plan C）：稀有 subCat → 掉率权重（手改优先，缺则回退配方需求推导）
  const dropWeightBySub: Record<string, number> = {};
  for (const r of tables['rareDropWeight'] ?? []) {
    const sub = asStr(r['subCat']);
    const w = asNum(r['weight'], NaN);
    // 存「表中存在」的权重（含 0）。0 是「显式抑制该稀有」的合法值，不能再回退到配方计数。
    if (sub && Number.isFinite(w)) dropWeightBySub[sub] = w;
  }

  // recipe（35 制造族 × 9 品质 = 315）
  const recipes: RecipeDef[] = (tables['recipe'] ?? []).map((r) => {
    const cityCraft = asStr(r['cityCraft']);
    const cityRare = asStr(r['cityRare']);
    const cityBlueprint = asStr(r['cityBlueprint']);
    return {
      tag: asStr(r['tag']),
      name: asStr(r['name']),
      skill: asStr(r['skill']),
      quality: asNum(r['quality'], 0),
      needItem1: asStr(r['needItem1']),
      needItem1Num: asNum(r['needItem1Num'], 0),
      matQualityFloor: asNum(r['matQualityFloor'], 0),
      needRare: asStr(r['needRare']),
      // 额外层：其他行当的 (q-1) 阶产出（V5 结构；旧配置无此三列 → 空，不参与消耗）
      needItem2: asStr(r['needItem2']),
      needItem2Num: asNum(r['needItem2Num'], 0),
      needRare2: asStr(r['needRare2']),
      needBlueprint: asStr(r['needBlueprint']),
      resultItem: asStr(r['resultItem']),
      resultNum: asNum(r['resultNum'], 0),
      cityCraft,
      cityRare,
      cityBlueprint,
      cityCraftTag: cityTagOfName(cityCraft),
      cityRareTag: cityTagOfName(cityRare),
      cityBlueprintTag: cityTagOfName(cityBlueprint),
      note: asStr(r['note']),
    };
  }).filter((r) => r.tag);

  // blueprint（只由 C 类产出）
  const blueprints: BlueprintDef[] = (tables['blueprint'] ?? []).map((r) => ({
    tag: asStr(r['tag']),
    name: asStr(r['name']),
    fromSkill: asStr(r['fromSkill']),
    note: asStr(r['note']),
  })).filter((b) => b.tag);

  const skillByTag: Record<string, SkillDef> = {};
  for (const s of skillDefs) skillByTag[s.tag] = s;
  const itemByTag: Record<string, ItemDef> = {};
  for (const i of items) itemByTag[i.tag] = i;
  const recipeByTag: Record<string, RecipeDef> = {};
  const recipeByResult: Record<string, RecipeDef> = {};
  for (const r of recipes) {
    recipeByTag[r.tag] = r;
    if (r.resultItem) recipeByResult[r.resultItem] = r;
  }
  const blueprintByTag: Record<string, BlueprintDef> = {};
  for (const b of blueprints) blueprintByTag[b.tag] = b;

  /**
   * C 类技能 → 可产出稀有料 subCat：由「图纸 → 它锁的 B 制造族 → 该族配方用到的稀有料」反推。
   * 数据实到这里出来：sworn→smithing→精铁/玄铁；visiting→alchemy→朱砂/百年参/雪莲；envoy→crafting→蚕丝/龙纹玉/犀角/南药。
   */
  const rareSubCatBySkill: Record<string, string[]> = {};
  for (const bp of blueprints) {
    if (!bp.fromSkill) continue;
    const set = new Set<string>();
    const skillsGated = new Set<string>();
    for (const r of recipes) {
      if (r.needBlueprint !== bp.tag) continue;
      skillsGated.add(r.skill);
      if (r.needRare) set.add(subOf(r.needRare));
    }
    for (const r of recipes) {
      if (!skillsGated.has(r.skill) || !r.needRare) continue;
      set.add(subOf(r.needRare));
    }
    rareSubCatBySkill[bp.fromSkill] = [...set].sort();
  }

  /**
   * Plan C：稀有掉率权重（C 类技能 → subCat → 权重）。
   * 优先用 `rareDropWeight` 表（实测烘焙、可手改）；缺表或某 subCat 缺行时，回退到「配方 needRare 计数」推导（同一池内归一化）。
   * 回退口径保证：即使不烘焙，Plan C 也按真实需求分布掉率，而非均匀。
   */
  const demandCountBySub: Record<string, number> = {};
  for (const r of recipes) {
    if (!r.needRare) continue;
    const s = subOf(r.needRare);
    demandCountBySub[s] = (demandCountBySub[s] ?? 0) + 1;
  }
  const rareSubCatWeightBySkill: Record<string, Record<string, number>> = {};
  for (const [skill, subs] of Object.entries(rareSubCatBySkill)) {
    const raw: Record<string, number> = {};
    for (const s of subs) {
      // 表中显式给了权重（即使 0）→ 直接用；表中无此 subCat 行 → 回退配方 needRare 计数
      raw[s] = s in dropWeightBySub ? (dropWeightBySub[s] ?? 0) : demandCountBySub[s] ?? 0;
    }
    const sum = Object.values(raw).reduce((a, b) => a + (b > 0 ? b : 0), 0);
    rareSubCatWeightBySkill[skill] = {};
    for (const s of subs) rareSubCatWeightBySkill[skill][s] = sum > 0 ? (raw[s] > 0 ? raw[s] : 0) / sum : 1 / subs.length;
  }

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
    // V4 金钱：config 表缺列时回落 INIT_MONEY（旧配置不崩，但经济系统本就因无 price 表而禁用）
    initMoney: asNum(rawCfg['initMoney'], INIT_MONEY),
    // V6 职业系统开关（缺列回落合理默认值；新配置应显式给）
    classUnlockSkillLvTotal: asNum(rawCfg['classUnlockSkillLvTotal'], 10),
    classSkillWeight: asNum(rawCfg['classSkillWeight'], 4),
    classSwitchCdSec: asNum(rawCfg['classSwitchCdSec'], 3600),
    classSlotBase: asNum(rawCfg['classSlotBase'], 1),
    classSlotStep: asNum(rawCfg['classSlotStep'], 3),
    classExpPerQuality: asNum(rawCfg['classExpPerQuality'], 3),
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

  // bg1 底图变换（config.bg1OffsetX/bg1OffsetY/bg1ScaleW/bg1ScaleH/bg1Opacity）。
  // 缺列回落默认；非法值夹紧：缩放必须 > 0（否则夹回 1），浓度夹紧到 [0,1]。
  const bg1ScaleW = asNum(rawCfg['bg1ScaleW'], 1);
  const bg1ScaleH = asNum(rawCfg['bg1ScaleH'], 1);
  const bg1Opacity = asNum(rawCfg['bg1Opacity'], 1);
  const bg1: Bg1Config = {
    offsetX: asNum(rawCfg['bg1OffsetX'], 0),
    offsetY: asNum(rawCfg['bg1OffsetY'], 0),
    scaleW: Number.isFinite(bg1ScaleW) && bg1ScaleW > 0 ? bg1ScaleW : 1,
    scaleH: Number.isFinite(bg1ScaleH) && bg1ScaleH > 0 ? bg1ScaleH : 1,
    opacity: Number.isFinite(bg1Opacity) ? Math.min(1, Math.max(0, bg1Opacity)) : 1,
  };

  const taskByTag: Record<string, TaskDef> = {};
  for (const t of tasks) taskByTag[t.tag] = t;
  const cityByTag: Record<string, CityDef> = {};
  for (const c of cities) cityByTag[c.tag] = c;

  const config: GameConfig = {
    meta: { ...meta, sheets: names },
    tasks,
    taskByTag,
    cities,
    cityByTag,
    cityByName,
    links,
    states,
    stateByTag,
    mapBgImg: asStr(rawCfg['mapBgImg']) || null,
    bg1,
    // 向量地图层（坐标真相）：直接由 xlsx 城市坐标 / 连线派生，无格子栅格化。
    cityPoints,
    cityPointByTag,
    waypoints,
    roadLines,
    regions,
    mapBounds,
    attrLv,
    attrLvNeed,
    values,
    skillDefs,
    skillByTag,
    items,
    itemByTag,
    recipes,
    recipeByTag,
    recipeByResult,
    blueprints,
    blueprintByTag,
    rareSubCatBySkill,
    rareSubCatWeightBySkill,
    priceRows,
    priceByKey,
    subCatRatio,
    classDefs,
    classByTag,
    classAffinityMap,
    classPromoteCond,
    classPromoteCondByTag,
    classEffect,
    standingDefs,
    standingByTag,
  };

  // ── 校验 ──
  if (!tasks.length) warnings.push('task 表为空');
  if (!cities.length) warnings.push('城市表（mapPoint，type=city）为空');
  // 坐标模式：城市必须带坐标（无坐标则无法在地图上定位，也不参与寻路）
  for (const c of cities) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      warnings.push(`city ${c.tag}(${c.name}) 缺少有效坐标 x/y`);
    }
  }
  for (const t of tasks) {
    const citiesHave = cities.filter((c) => c.taskTypes.includes(t.nodeType));
    if (citiesHave.length < 1) {
      warnings.push(`任务 ${t.tag}(${t.name}) 的设施 ${t.nodeType} 未命中任何城市（坐标模式下由城市 taskType 承载）`);
    }
  }
  for (const k of ['speed', 'backPackSlotNum', 'itemStacking', 'initTaskListSlot']) {
    if (!(k in rawCfg)) warnings.push(`config 表缺少 ${k}，已使用默认值`);
  }
  // bg1 底图参数：配了背景图才校验（无图时不生效）
  if (config.mapBgImg) {
    for (const k of ['bg1ScaleW', 'bg1ScaleH'] as const) {
      const v = asNum(rawCfg[k], 1);
      if (!(Number.isFinite(v) && v > 0)) warnings.push(`config.${k} 非法（应 > 0），已回落 1`);
    }
    const op = asNum(rawCfg['bg1Opacity'], 1);
    if (Number.isFinite(op) && (op < 0 || op > 1)) warnings.push('config.bg1Opacity 超出 [0,1]，已夹紧');
  }
  if (!values.startCityRand.length) warnings.push('config.startCityRand 为空');
  for (const tag of values.startCityRand) {
    if (!cityByTag[tag]) warnings.push(`startCityRand 中的 ${tag} 不存在于 city 表`);
  }
  for (const key of ATTR_KEYS) void key;

  // ── V2 红线校验（仅在配置了 skill/item/recipe 表时生效，V1 配置直接跳过） ──
  if (skillDefs.length) {
    const agg = (title: string, bad: string[], hint = ''): void => {
      if (!bad.length) return;
      warnings.push(`${title}：${bad.length} 条${hint ? `（${hint}）` : ''} · 示例 ${bad.slice(0, 3).join('、')}`);
    };

    // ① 图纸只能由 C 类技能产出（C 是 B 的前置，不可跳过）
    agg(
      '红线①/② 图纸来源非 C 类技能',
      blueprints.filter((b) => skillByTag[b.fromSkill]?.cls !== 'C').map((b) => `${b.tag}←${b.fromSkill || '(空)'}`),
    );

    // ① 稀有材料只有 C 类能给：来源标注必须是 C类独占，且能被某个 C 技能的产出集合覆盖
    const rares = items.filter((i) => i.cat === '稀有');
    agg(
      '红线① 稀有材料来源标注异常',
      rares.filter((i) => i.source !== 'C类独占').map((i) => `${i.tag}:${i.source || '(空)'}`),
    );
    const covered = new Set<string>();
    for (const subs of Object.values(rareSubCatBySkill)) for (const s of subs) covered.add(s);
    agg('红线① 稀有材料无 C 类产出源', rares.filter((i) => !covered.has(i.subCat)).map((i) => i.tag));

    // ⑥ 稀有材料的产出品质下界 ≥ 4
    agg('红线⑥ 稀有材料品质下界 < 4', rares.filter((i) => i.qMin < 4).map((i) => `${i.tag}(q${i.qMin})`));

    // ③ 高阶配方的「图纸城 / 材料A城 / 材料B城」三城必须互异，且图纸城不能缺
    const missingBpCity: string[] = [];
    const notDistinct: string[] = [];
    for (const r of recipes) {
      if (r.needBlueprint && !r.cityBlueprintTag) missingBpCity.push(`${r.tag} 需 ${r.needBlueprint} 但 cityBlueprint 为空`);
      const trio = [r.cityCraftTag, r.cityRareTag, r.cityBlueprintTag].filter(Boolean) as string[];
      if (trio.length === 3 && new Set(trio).size < 3) notDistinct.push(`${r.tag}: ${trio.join('/')}`);
    }
    agg('红线③ 配方未登记图纸城', missingBpCity);
    agg('红线③ 配方三城不互异', notDistinct);

    // ④/⑤ 投喂铁律：n 品制造只吃 q≥n 的材料
    agg(
      '红线④/⑤ matQualityFloor < 配方品质',
      recipes
        .filter((r) => r.matQualityFloor < r.quality)
        .map((r) => `${r.tag}(q${r.quality}/floor${r.matQualityFloor})`),
    );

    // 任务基型必须铺满 9 技能 × 9 品质，且每格唯一（滑动窗口依赖该前提）
    const combos = new Map<string, number>();
    for (const t of tasks) {
      if (!t.skill || !t.quality) continue;
      const key = `${t.skill}|${t.quality}`;
      combos.set(key, (combos.get(key) ?? 0) + 1);
    }
    const dupes = [...combos.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    const missing: string[] = [];
    for (const s of skillDefs) for (let q = 1; q <= 9; q++) if (!combos.has(`${s.tag}|${q}`)) missing.push(`${s.tag}|q${q}`);
    agg('滑动窗口 任务基型重复', dupes);
    agg('滑动窗口 任务基型缺失（应为 9 技能 × 9 品质）', missing);

    // 运行时保障：A 类任务的产出若是稀有材料，会直接破坏「A 供量 / C 供质」
    agg(
      '红线① A 类任务产出稀有材料',
      tasks.filter((t) => t.cls === 'A' && itemByTag[t.mainOutput]?.cat === '稀有').map((t) => t.tag),
    );

    // ── V4 价格体系校验（仅在配置了 price 表时生效，旧配置直接跳过）──
    if (priceRows.length) {
      // 工钱/赏金/补货都读 `材料|tier`，骨架必须铺满 1-9，否则高品工钱会回落到 0
      const matTiers = priceRows.filter((p) => p.cat === '材料').map((p) => p.tier);
      const missTier: string[] = [];
      for (let t = 1; t <= 9; t++) if (!matTiers.includes(t)) missTier.push(`材料|t${t}`);
      agg('价格骨架 材料 tier 1-9 缺失', missTier);

      // 材料骨架必须随 tier 单调递增（三阶当量的前提：高品天然值钱）
      const sorted = priceRows.filter((p) => p.cat === '材料').sort((a, b) => a.tier - b.tier);
      const notMono: string[] = [];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].base <= sorted[i - 1].base) notMono.push(`t${sorted[i - 1].tier}(${sorted[i - 1].base})≥t${sorted[i].tier}(${sorted[i].base})`);
      }
      agg('价格骨架 材料基准价非单调递增', notMono);

      // 名品必须不可售（它是成就物不是货；一旦能卖会压制成品种类）
      agg('价格 名品未标记不可售', items.filter((i) => i.cat === '名品' && i.sellable).map((i) => i.tag));

      // 除名品外所有物品都应有正价（成品按配方推导，漏配 = 配方缺失）
      agg(
        '价格 物品缺基准价',
        items.filter((i) => i.cat !== '名品' && !(i.price > 0)).map((i) => `${i.tag}(${i.cat})`),
      );
    }
  }

  // ── V6 职业系统校验 ──
  if (classDefs.length) {
    const affClasses = new Set(classAffinity.map((a) => a.classType));
    for (const c of classDefs) {
      if (!affClasses.has(c.classType)) warnings.push(`classDefs ${c.classType} 在 classAffinity 表无亲密度行`);
      if (c.promoteCond) {
        for (const id of c.promoteCond.split(';')) {
          const cid = id.trim();
          if (cid && !classPromoteCondByTag[cid]) warnings.push(`classDefs ${c.classType} 的 promoteCond=${cid} 在 classPromoteCond 表缺失`);
        }
      }
    }
    for (const a of classAffinity) {
      if (!cfg_skillHasTag(skillDefs, a.skill)) warnings.push(`classAffinity ${a.classType}/${a.skill} 的技能 tag 不在 skill 表`);
    }
  }

  return { config, warnings };
}

/** 校验技能 tag 是否存在于 skill 表（V6 职业亲密度引用） */
function cfg_skillHasTag(skillDefs: SkillDef[], tag: string): boolean {
  return skillDefs.some((s) => s.tag === tag);
}
