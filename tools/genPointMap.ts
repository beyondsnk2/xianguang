/**
 * 坐标模式：从真实 xlsx 配置直读「坐标点 MapModel」。
 *  - 城市：直接取 xlsx mapPoint 表的 x/y 离散坐标（坐标真相，不再反推格子块中心）
 *  - 州：straight 复制（含 #RRGGBB 着色）
 *  - mapPointLink：每条转成一条 pointRefs=[tagA,tagB] 的道路
 *
 * 运行：npm run gen:pointmap    （产物 config/point-map.json）
 * 旧 demo 若仍在，自动备份为 config/point-map-demo.json
 *
 * 说明：坐标模式下 xlsx 是唯一真相，point-map.json 仅作为「启动自动重生成的派生产物」
 * （供 checkPoint 一致性校验与人工核对），运行时不再由 ?pointmap 叠加。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './pickConfig';
import type { PointMapModel, PointCity, PointState, PointRoad } from '../src/config/pointMap';

export function generatePointMap(opts: { configDir?: string } = {}): void {
  const { config, picked } = loadConfig(undefined, opts.configDir);

  // ── 1. 城市：直接读 xlsx 坐标（坐标真相）──
  const cities: PointCity[] = config.cities.map((c) => ({
    id: c.tag,
    name: c.name,
    x: Math.round(c.x * 100) / 100,
    y: Math.round(c.y * 100) / 100,
    state: c.state ?? undefined,
    taskTypes: Array.isArray(c.taskTypes) ? c.taskTypes : [],
  }));
  const unpositioned = cities.filter((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y)).map((c) => c.id);

  // ── 2. 州（含着色）──
  const states: PointState[] = config.states.map((s) => ({
    tag: s.tag,
    name: s.name,
    color: s.color,
  }));

  // ── 3. mapPointLink → 道路（直接引用点位 tag）──
  const roads: PointRoad[] = config.links.map((l, i) => ({
    id: `r${i + 1}`,
    pointRefs: [l.tagA, l.tagB],
  }));

  // ── 4. 坐标包围盒 → 地图尺寸（仅用于产物结构占位，坐标空间不再栅格化）──
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of cities) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  const pad = 4;
  const width = Math.ceil(maxX - minX) + 1 + pad;
  const height = Math.ceil(maxY - minY) + 1 + pad;

  const model: PointMapModel = {
    meta: {
      name: `sanwalk 坐标点地图（${cities.length}城${states.length}州，源自 ${picked.file}）`,
      width,
      height,
    },
    cities,
    states,
    roads,
  };

  const outDir = opts.configDir ?? path.join(process.cwd(), 'config');
  const target = path.join(outDir, 'point-map.json');
  if (fs.existsSync(target)) {
    const old = JSON.parse(fs.readFileSync(target, 'utf8'));
    if ((old.cities?.length ?? 0) < cities.length) {
      fs.writeFileSync(path.join(outDir, 'point-map-demo.json'), JSON.stringify(old, null, 2));
      console.log('(旧 demo 已备份为 config/point-map-demo.json)');
    }
  }
  fs.writeFileSync(target, JSON.stringify(model, null, 2));

  console.log(`✅ 已生成 config/point-map.json`);
  console.log(`   来源     : ${picked.file} (${picked.setName} V${picked.version})`);
  console.log(`   城市     : ${cities.length}（无坐标点: ${unpositioned.length ? unpositioned.join(',') : '无'}）`);
  console.log(`   州       : ${states.length}`);
  console.log(`   道路/连线: ${roads.length}`);
  console.log(`   坐标包围盒: ${width}×${height}`);
}

// 仅当作为独立脚本显式传入 'gen' 参数时执行（npm run gen:pointmap）。
// 被 vite 配置 import 时不会触发，由 vite 的 buildStart 钩子调用，避免重复执行。
if (process.argv[2] === 'gen') generatePointMap();
