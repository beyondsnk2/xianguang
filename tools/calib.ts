/**
 * 成长校准工具（长期迭代用）：按天推进 V2 存档，观察技能档位→品质窗口→产出的联动节奏。
 *
 * 用法：npm run calib（默认跑到 120 天） / npm run calib <天数,天数,...>（如 7,30,60）
 * 它是 `npm run check`（24h 快照）的补充：只看 24h 看不出「窗口何时上移」「高阶多久断供」。
 */
import { loadConfig } from './pickConfig';
import { buildGraph } from '../src/game/graph';
import { simulate } from '../src/game/selfcheck';
import { skillTier, qualityWindow, qualityWeights } from '../src/game/skill';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// 与 npm run check 同一套「最大版本」规则（曾硬编码 V3，升 V4 后校准跑错配置）
const { config, picked } = loadConfig(process.argv[3]);
console.log(`配置集：${picked.setName}  版本：V${picked.version}  文件：${picked.file}`);
const graph = buildGraph(config);

const arg = process.argv[2];
const days = arg ? arg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) : [1, 2, 3, 7, 14, 30, 60, 90, 120];

console.log('档位 → 开放品质（权重 低/中/高）');
for (let tier = 1; tier <= 10; tier++) {
  const w = qualityWindow(tier);
  const ws = qualityWeights(tier).map((x) => x.toFixed(1)).join('/');
  console.log(`  tier ${String(tier).padStart(2)} → 品质 ${w.min}-${w.max}  权重 ${ws}`);
}

console.log('\n天数 | 任务/天 | 技能等级 | 档位分布 | 最高品质 | 仓库件数 | A/B/C 完成 | B缺料率 | 拙/平/佳/绝 | 四维(武/统/智/政) | 事件/天 | 属性经验/天');
let lastStarved: Record<string, number> = {};
let lastDemand: Record<string, number> = {};
for (const d of days) {
  const sim = simulate(config, graph, d * 24);
  const lvs = Object.values(sim.skills).map((s) => s.lv);
  const min = Math.min(...lvs);
  const max = Math.max(...lvs);
  const tiers: Record<number, number> = {};
  for (const l of lvs) tiers[skillTier(l)] = (tiers[skillTier(l)] ?? 0) + 1;
  const qualities = Object.keys(sim.storage)
    .map((t) => Number(t.split('_').pop()))
    .filter((n) => Number.isFinite(n));
  const maxQ = qualities.length ? Math.max(...qualities) : 0;
  const bDone = sim.clsTally.B ?? 0;
  const starveRate = bDone ? ((sim.starvedTasks / bDone) * 100).toFixed(0) + '%' : '—';
  const starveSplit = bDone
    ? `(料${((sim.starvedMat / bDone) * 100).toFixed(0)}%/稀${((sim.starvedRare / bDone) * 100).toFixed(0)}%)`
    : '';
  const a = sim.attrs;
  const attrs = `${a.force}/${a.leadership}/${a.intelligent}/${a.politics}`;
  const wage = sim.moneyEarnedWage ?? 0;
  const bounty = sim.moneyEarnedBounty ?? 0;
  const moneyLine = `金钱:${sim.money} 工钱+${wage}/赏金+${bounty}`;
  console.log(
    `${String(d).padStart(4)} | ${sim.tasksPerDay.toFixed(0).padStart(6)} | ${String(min).padStart(3)}~${String(max).padEnd(3)} | ` +
      `${Object.entries(tiers).map(([t, n]) => `${t}档×${n}`).join(' ').padEnd(24)} | ${String(maxQ).padStart(4)} | ` +
      `${String(sim.storageCount).padStart(5)} | ${(sim.clsTally.A ?? 0)}/${bDone}/${sim.clsTally.C ?? 0} | ` +
      `${starveRate.padStart(5)}${starveSplit} | ${sim.evalTally.join('/')} | ${attrs.padStart(12)} | ` +
      `${(sim.eventsSettled / d).toFixed(1).padStart(5)} | ${(sim.attrXpTotal / d).toFixed(0).padStart(6)}`,
  );
  console.log(`   ${moneyLine}`);
  lastStarved = sim.starvedBySubCat;
  lastDemand = sim.demandBySubCat;
  if (d === days[days.length - 1]) {
    console.log('   ── E8 缺稀有按 subCat（池内归并）──');
    const byPool: Record<string, string[]> = {};
    for (const [sk, subs] of Object.entries(config.rareSubCatBySkill)) byPool[sk] = subs;
    for (const [sk, subs] of Object.entries(byPool)) {
      const parts = subs
        .map((s) => `${s}=${sim.starvedBySubCat[s] ?? 0}`)
        .join('  ');
      console.log(`     ${sk.padEnd(10)} ${parts}`);
    }
    const prod = (s: string) => sim.raresProduced[s] ?? 0;
    const dem = (s: string) => sim.demandBySubCat[s] ?? 0;
    console.log('   ── C 类稀有产出（按池）──');
    for (const [sk, subs] of Object.entries(byPool)) {
      const parts = subs.map((s) => `${s}+${prod(s)}`).join('  ');
      console.log(`     ${sk.padEnd(10)} ${parts}`);
    }
    console.log('   ── B 类稀有实际需求 demandBySubCat（按池）──');
    for (const [sk, subs] of Object.entries(byPool)) {
      const parts = subs.map((s) => `${s}=${dem(s)}`).join('  ');
      console.log(`     ${sk.padEnd(10)} ${parts}`);
    }
    console.log('   ── 供需比（产/需，<1 即缺口）──');
    for (const [sk, subs] of Object.entries(byPool)) {
      const parts = subs.map((s) => `${s}=${(prod(s) / Math.max(1, dem(s))).toFixed(2)}`).join('  ');
      console.log(`     ${sk.padEnd(10)} ${parts}`);
    }
  }
}

// 写 JSON 供烘焙脚本（Plan C v2 权重 = 按实际 B 需求）读取（落到稳定的 tools/out，不随 bundle 位置飘）
const outDir = resolve(process.cwd(), 'tools', 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'starvedBySubCat.json'), JSON.stringify(lastStarved, null, 2));
writeFileSync(resolve(outDir, 'rareDemand.json'), JSON.stringify(lastDemand, null, 2));
console.log(`\n已写 E8 实测 → tools/out/starvedBySubCat.json（末日 ${days[days.length - 1]}d）`);
console.log(`已写 E8 实测 → tools/out/rareDemand.json（末日 ${days[days.length - 1]}d，Plan C v2 权重源）`);
