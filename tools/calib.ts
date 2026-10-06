/**
 * 成长校准工具（长期迭代用）：按天推进 V2 存档，观察技能档位→品质窗口→产出的联动节奏。
 *
 * 用法：npm run calib（默认跑到 120 天） / npm run calib <天数,天数,...>（如 7,30,60）
 * 它是 `npm run check`（24h 快照）的补充：只看 24h 看不出「窗口何时上移」「高阶多久断供」。
 */
import path from 'node:path';
import fs from 'node:fs';
import { readXlsx } from '../src/config/xlsxSource';
import { parseWorkbook } from '../src/config/parse';
import { buildGraph } from '../src/game/graph';
import { simulate } from '../src/game/selfcheck';
import { skillTier, qualityWindow, qualityWeights } from '../src/game/skill';

const file = 'firstShow_V3.xlsx';
const buf = fs.readFileSync(path.join(process.cwd(), 'config', file));
const sheets = readXlsx(new Uint8Array(buf));
const { config } = parseWorkbook(sheets, {
  file,
  setName: 'firstShow',
  version: 3,
  loadedAt: new Date().toISOString(),
});
const graph = buildGraph(config);

const arg = process.argv[2];
const days = arg ? arg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) : [1, 2, 3, 7, 14, 30, 60, 90, 120];

console.log('档位 → 开放品质（权重 低/中/高）');
for (let tier = 1; tier <= 10; tier++) {
  const w = qualityWindow(tier);
  const ws = qualityWeights(tier).map((x) => x.toFixed(1)).join('/');
  console.log(`  tier ${String(tier).padStart(2)} → 品质 ${w.min}-${w.max}  权重 ${ws}`);
}

console.log('\n天数 | 任务/天 | 技能等级 | 档位分布 | 最高品质 | 仓库件数 | A/B/C 完成 | B缺料率 | 拙/平/佳/绝 | 好感 | 图纸');
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
  console.log(
    `${String(d).padStart(4)} | ${sim.tasksPerDay.toFixed(0).padStart(6)} | ${String(min).padStart(3)}~${String(max).padEnd(3)} | ` +
      `${Object.entries(tiers).map(([t, n]) => `${t}档×${n}`).join(' ').padEnd(24)} | ${String(maxQ).padStart(4)} | ` +
      `${String(sim.storageCount).padStart(5)} | ${(sim.clsTally.A ?? 0)}/${bDone}/${sim.clsTally.C ?? 0} | ` +
      `${starveRate.padStart(5)} | ${sim.evalTally.join('/')} | ${sim.favor} | ${sim.blueprints.length}`,
  );
}
