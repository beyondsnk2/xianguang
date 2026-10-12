/**
 * 坐标点地图自检（退休格子模式后）：
 *  1. 读取 config/point-map.json（由 xlsx 派生的坐标点 MapModel）
 *  2. 读取真实 xlsx 配置（loadConfig + buildVGraph），构建向量图
 *  3. 对拍一致：point-map.json 的城市 / 州 / 连线集合 == 真实 xlsx
 *  4. 几何合法：坐标有限、道路引用解析、向量图全连通
 *
 * 运行：npm run check:point
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildVGraph, vdist, type VGraph } from '../src/game/vgraph';
import type { PointMapModel } from '../src/config/pointMap';
import { loadConfig } from './pickConfig';

function reachableCount(g: VGraph): number {
  const ids = [...g.nodes.keys()];
  if (!ids.length) return 0;
  const seen = new Set<string>([ids[0]]);
  const stack = [ids[0]];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of g.adj.get(cur) ?? []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return seen.size;
}

function main(): void {
  const file = resolve(process.cwd(), 'config', 'point-map.json');
  let raw: PointMapModel;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as PointMapModel;
  } catch (e) {
    console.error(`读取 ${file} 失败：${(e as Error).message}`);
    process.exit(1);
    return;
  }

  console.log('═══ 坐标点地图（point-map.json）═══');
  console.log(`城市        : ${raw.cities.length}`);
  console.log(`州(着色)    : ${(raw.states ?? []).length}`);
  console.log(`道路/连线   : ${raw.roads.length}`);

  // ── 几何合法性 ──
  const stateTags = new Set((raw.states ?? []).map((s) => s.tag));
  const vWarn: string[] = [];
  for (const c of raw.cities) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) vWarn.push(`城市 ${c.id} 坐标非有限值`);
    if (c.state && !stateTags.has(c.state)) vWarn.push(`城市 ${c.id} 的 state=${c.state} 不在 states 表`);
    if (!c.taskTypes || !c.taskTypes.length) vWarn.push(`城市 ${c.id} 没有任何设施类型`);
  }
  const refIds = new Set<string>([...raw.cities.map((c) => c.id), ...(raw.waypoints ?? []).map((w) => w.id)]);
  for (const r of raw.roads) {
    const [a, b] = r.pointRefs;
    if (!refIds.has(a)) vWarn.push(`道路 ${r.id} 引用未知参考点 ${a}`);
    if (!refIds.has(b)) vWarn.push(`道路 ${r.id} 引用未知参考点 ${b}`);
  }

  // ── 与真实 xlsx 配置对拍（忠实度）──
  let faithful = true;
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  try {
    const { config: real } = loadConfig();
    const realCities = new Set(real.cities.map((c) => c.tag));
    const pointCities = new Set(raw.cities.map((c) => c.id));
    const missingCity = [...realCities].filter((t) => !pointCities.has(t));
    const extraCity = [...pointCities].filter((t) => !realCities.has(t));
    console.log('────────── 与真实 xlsx 配置对拍 ──────────');
    console.log(`真实城数 ${realCities.size} / 点图城数 ${pointCities.size} ${missingCity.length || extraCity.length ? '✗' : '✓'}`);
    if (missingCity.length) console.log('  点图缺城:', missingCity.join(','));
    if (extraCity.length) console.log('  点图多城:', extraCity.join(','));

    const realStates = new Set(real.states.map((s) => s.tag));
    const pointStates = new Set((raw.states ?? []).map((s) => s.tag));
    const missingState = [...realStates].filter((t) => !pointStates.has(t));
    const extraState = [...pointStates].filter((t) => !realStates.has(t));
    console.log(`真实州数 ${realStates.size} / 点图州数 ${pointStates.size} ${missingState.length || extraState.length ? '✗' : '✓'}`);
    if (missingState.length) console.log('  点图缺州:', missingState.join(','));
    if (extraState.length) console.log('  点图多州:', extraState.join(','));

    const realLinks = new Set(real.links.map((l) => pairKey(l.tagA, l.tagB)));
    const pointLinks = new Set(raw.roads.map((r) => pairKey(r.pointRefs[0], r.pointRefs[1])));
    const missingLink = [...realLinks].filter((k) => !pointLinks.has(k));
    const extraLink = [...pointLinks].filter((k) => !realLinks.has(k));
    console.log(`真实连线 ${realLinks.size} / 点图连线 ${pointLinks.size} ${missingLink.length || extraLink.length ? '✗' : '✓'}`);
    if (missingLink.length) console.log('  点图缺连线:', missingLink.slice(0, 6).join(','), missingLink.length > 6 ? `…(${missingLink.length})` : '');
    if (extraLink.length) console.log('  点图多连线:', extraLink.slice(0, 6).join(','), extraLink.length > 6 ? `…(${extraLink.length})` : '');

    faithful = !missingCity.length && !extraCity.length && !missingState.length && !extraState.length && !missingLink.length && !extraLink.length;

    // ── 向量图连通性 ──
    const vgraph = buildVGraph(real);
    console.log('────────── 向量图连通性 ──────────');
    if (!vgraph) {
      console.log('  ⚠ 向量图构建失败（无城市坐标/连线）');
      faithful = false;
    } else {
      const reach = reachableCount(vgraph);
      console.log(`可达节点 ${reach}/${vgraph.nodes.size} ${reach === vgraph.nodes.size ? '✓ 全连通' : '✗ 存在孤立节点'}`);
      if (reach !== vgraph.nodes.size) faithful = false;
      const linkFail: string[] = [];
      for (const l of real.links) {
        if (vdist(vgraph, l.tagA, l.tagB) === null) linkFail.push(`${l.tagA}-${l.tagB}`);
      }
      console.log(`连线可达 ${real.links.length - linkFail.length}/${real.links.length} ${linkFail.length ? '✗ ' + linkFail.slice(0, 5).join('、') : '✓'}`);
      if (linkFail.length) faithful = false;
    }
  } catch (e) {
    console.log('────────── 与真实配置对拍 ──────────');
    console.log(`  （跳过：载入真实配置失败 ${String((e as Error).message)}）`);
  }

  console.log(`几何告警    : ${vWarn.length ? '' : '✓ 无'}`);
  for (const w of vWarn) console.log(`    ⚠ ${w}`);

  const ok = faithful && vWarn.length === 0;
  console.log(ok ? '\n✅ 坐标点地图通过（一致 + 连通）' : '\n❌ 未通过，请检查上方告警');
  process.exit(ok ? 0 : 1);
}

main();
