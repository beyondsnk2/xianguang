/**
 * 图纸节点解锁验证：按天推进，观察 blueprintNode（每 C 技能的节点进度）与
 * blueprints 总数、全局好感 favor 的联动，确认节点门槛（favor × C-tier）确实按
 * BLUEPRINT_NODES 逐档解锁，且不过早洪泛。
 */
import { loadConfig } from './pickConfig';
import { buildGraph } from '../src/game/graph';
import { simulate } from '../src/game/selfcheck';

const { config, picked } = loadConfig(process.argv[3]);
const graph = buildGraph(config);
console.log(`配置集：${picked.setName}  V${picked.version}`);

// 节点门槛（与 constants.ts 同源，仅用于打印对照）
const NODES = [
  { minFavor: 30, minCTier: 2, count: 1 },
  { minFavor: 80, minCTier: 3, count: 1 },
  { minFavor: 150, minCTier: 4, count: 1 },
  { minFavor: 240, minCTier: 5, count: 1 },
  { minFavor: 400, minCTier: 6, count: 2 },
  { minFavor: 640, minCTier: 7, count: 2 },
];

const days = (process.argv[2] || '7,14,30,60,90,120')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

console.log('天数 | 好感 | 图纸数 | 各C技能节点进度(sworn/visiting/envoy) | 理论应解锁节点(按 favor×tier)');
for (const d of days) {
  const sim = simulate(config, graph, d * 24);
  const node = sim.blueprintNode;
  const bySkill = ['sworn', 'visiting', 'envoy']
    .map((s) => `${s}=${node[s] ?? 0}`)
    .join(' ');
  // 理论：取该天各 C 技能 tier 与 favor，逐节点判定
  const tiers: Record<string, number> = {};
  for (const [tag, sk] of Object.entries(sim.skills)) {
    // skillTier 仅常量，这里直接按 lv 反推（lv1-10→t1 ... 91-100→t10，每10级一档）
    tiers[tag] = Math.min(10, Math.ceil(sk.lv / 10));
  }
  const cTiers = ['sworn', 'visiting', 'envoy'].map((s) => tiers[s] ?? 1);
  const minCTier = Math.min(...cTiers);
  let expected = 0;
  for (let i = 0; i < NODES.length; i++) {
    if (sim.favor >= NODES[i].minFavor && minCTier >= NODES[i].minCTier) expected = i + 1;
    else break;
  }
  console.log(
    `${String(d).padStart(4)} | ${String(sim.favor).padStart(5)} | ${String(sim.blueprints.length).padStart(4)} | ${bySkill.padEnd(34)} | 期望≥${expected}`,
  );
}
