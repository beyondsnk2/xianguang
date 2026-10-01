/**
 * 控制台自检：直接读 config/ 下的 xlsx（Node 端复用同一套解析与逻辑），
 *  1. 打印生效表 / 字段数量
 *  2. 路网基准值对拍（开发文档 §7.1）
 *  3. 24 小时节奏模拟对拍（开发文档 §7.2）
 *
 * 运行：npm run check
 */
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from '../src/config/xlsxSource';
import { parseWorkbook } from '../src/config/parse';
import { buildGraph } from '../src/game/graph';
import { offlineSettle, runSelfCheck, simulate } from '../src/game/selfcheck';

const ROOT = process.cwd();
const CONFIG_DIR = path.join(ROOT, 'config');

function pickLatest(): { file: string; setName: string; version: number } {
  const all: { file: string; setName: string; version: number }[] = [];
  for (const name of fs.readdirSync(CONFIG_DIR)) {
    if (name.startsWith('~$') || !/\.xlsx$/i.test(name)) continue;
    const m = /^(.+)_V(\d+)\.xlsx$/i.exec(name);
    if (m) all.push({ file: name, setName: m[1], version: Number(m[2]) });
  }
  const bySet = new Map<string, { file: string; setName: string; version: number }>();
  for (const f of all) {
    const cur = bySet.get(f.setName);
    if (!cur || f.version > cur.version) bySet.set(f.setName, f);
  }
  const latest = [...bySet.values()][0];
  if (!latest) throw new Error('config/ 下没有符合版本规则的 xlsx');
  return latest;
}

function main(): void {
  const latest = pickLatest();
  console.log(`配置集：${latest.setName}  版本：V${latest.version}  文件：${latest.file}`);

  const buf = fs.readFileSync(path.join(CONFIG_DIR, latest.file));
  const sheets = readXlsx(new Uint8Array(buf));
  const { config, warnings } = parseWorkbook(sheets, {
    file: latest.file,
    setName: latest.setName,
    version: latest.version,
    loadedAt: new Date().toISOString(),
  });

  console.log(`生效表：${config.meta.sheets.join(', ')}`);
  console.log(
    `字段数：task=${config.tasks.length} city=${config.cities.length} mapNode=${config.nodes.length} ` +
      `mapRoad=${config.roads.length} attrLv=${config.attrLv.length} config=${Object.keys(config.values).length}`,
  );
  console.log(
    `数值：speed=${config.values.speed}s/格 背包=${config.values.backPackSlotNum}格×${config.values.itemStacking} ` +
      `任务槽=${config.values.initTaskListSlot} 出生候选=${config.values.startCityRand.join('/')}`,
  );
  if (warnings.length) {
    console.log('⚠ 校验告警：');
    for (const w of warnings) console.log('   - ' + w);
  } else {
    console.log('✅ 配置校验无告警');
  }

  const graph = buildGraph(config);
  const check = runSelfCheck(config, graph);
  console.log('\n── 路网对拍 ──');
  for (const it of check.items) {
    console.log(`${it.ok ? '✅' : '❌'} ${it.label}：期望 ${it.expect} / 实际 ${it.actual}`);
  }
  const s = check.stats;
  console.log(
    `\n图规模：${s.nodeCount} 点 ${s.edgeCount} 边（格 ${s.cellCount}），连通分量 ${s.components}`,
  );
  console.log(
    `全部节点对 ${s.facilityPairs} 对：平均 ${s.avgAll.toFixed(2)} 格（文档 30.75），最大 ${s.maxDist}（文档 55）\n` +
      `　同城 ${s.avgSameCity.toFixed(2)}（文档 4.42）｜跨州 ${s.avgCrossCity.toFixed(2)}（文档 37.33）\n` +
      `　仅设施：同城 ${s.avgSameFacility.toFixed(2)}｜跨州 ${s.avgCrossFacility.toFixed(2)}`,
  );

  console.log('\n── 24 小时节奏模拟 ──');
  const sim = simulate(config, graph, 24);
  console.log(`完成任务：${sim.tasksDone} 个（约 ${sim.tasksPerDay.toFixed(1)} 个/天）`);
  console.log(`单任务周期：${(sim.avgTaskCycleSec / 60).toFixed(1)} 分钟（${sim.avgTaskCycleSec.toFixed(0)} 秒）`);
  console.log(`回城次数：${sim.returnTrips} 次/天`);
  console.log(`稳态空槽：${sim.avgEmptySlots.toFixed(2)} 个`);
  console.log(`累计走格：${sim.cellsWalked}`);
  console.log(`仓库：${JSON.stringify(sim.storage)}`);
  console.log(`四维属性：${JSON.stringify(sim.attrs)}`);
  console.log(`空转采样：${sim.idleSamples} / ${sim.samples}（应 0）｜超容未回城：${sim.overloadViolations}（应 0）`);

  console.log('\n── 离线结算 ──');
  for (const h of [1, 8, 24]) {
    const r = offlineSettle(config, graph, h);
    console.log(
      `离开 ${h} 小时 → 结算 ${r.settledHours.toFixed(1)} 小时，完成 ${r.tasksDone} 个任务，` +
        `回城 ${r.returnTrips} 次，耗时 ${r.costMs} ms`,
    );
  }

  const ok = check.ok;
  console.log(`\n${ok ? '✅ 路网基准全部命中' : '❌ 路网基准存在偏差'}`);
  if (!ok) process.exitCode = 1;
}

main();
