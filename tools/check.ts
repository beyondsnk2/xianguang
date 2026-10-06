/**
 * 控制台自检：直接读 config/ 下的 xlsx（Node 端复用同一套解析与逻辑），
 *  1. 打印生效表 / 字段数量
 *  2. 路网基准值对拍（开发文档 §7.1）
 *  3. 24 小时节奏模拟对拍（开发文档 §7.2）
 *
 * 运行：npm run check（同集最大版本，当前 V3）/ npm run check:v1（钉住 firstShow_V1）
 *       / npm run check <配置集>@<版本>（任意指定，如 firstShow@1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from '../src/config/xlsxSource';
import { parseWorkbook } from '../src/config/parse';
import { buildGraph, nodeDistance } from '../src/game/graph';
import { offlineSettle, runSelfCheck, simulate } from '../src/game/selfcheck';
import { AMBITION_SKILLS } from '../src/game/taskGen';

const ROOT = process.cwd();
const CONFIG_DIR = path.join(ROOT, 'config');

/** 未显式指定配置集时用它 */
const DEFAULT_SET = 'firstShow';

/**
 * 选配置 + 选版本。命名规则 `{配置集名}_V{版本号}.xlsx`，**同名默认取版本号最大的**
 * （所以 firstShow_V1 会自动被 firstShow_V3 顶掉；要回跑旧版必须显式钉版本）。
 * @param want 命令行第 1 个参数，三种写法：
 *   - 省略            → 默认配置集的最大版本（当前即 V3）
 *   - `firstShow`     → 该配置集的最大版本
 *   - `firstShow@1` / `@1` → 精确钉住某版本（回跑旧配置用；@ 前留空则用默认集）
 */
function pickLatest(want?: string): { file: string; setName: string; version: number } {
  const all: { file: string; setName: string; version: number }[] = [];
  for (const name of fs.readdirSync(CONFIG_DIR)) {
    if (name.startsWith('~$') || !/\.xlsx$/i.test(name)) continue;
    const m = /^(.+)_V(\d+)\.xlsx$/i.exec(name);
    if (m) all.push({ file: name, setName: m[1], version: Number(m[2]) });
  }
  if (!all.length) throw new Error('config/ 下没有符合 {配置集名}_V{版本号}.xlsx 规则的 xlsx');

  // 拆「配置集@版本」：@ 前的配置集可省略（留空 → 默认集）
  const at = want?.indexOf('@') ?? -1;
  const setName = (at >= 0 ? want!.slice(0, at).trim() : want?.trim()) || DEFAULT_SET;
  const verText = at >= 0 ? want!.slice(at + 1).trim() : '';
  if (at >= 0 && !/^\d+$/.test(verText)) {
    throw new Error(`版本号必须是数字，收到「${verText}」。用法：firstShow@1`);
  }

  const same = all.filter((f) => f.setName === setName);
  const vs = same.map((f) => `V${f.version}`).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  if (at >= 0) {
    const hit = same.find((f) => f.version === Number(verText));
    if (!hit) {
      throw new Error(`找不到 ${setName}_V${verText}.xlsx。该配置集现有版本：${vs.length ? vs.join(' / ') : '（无）'}`);
    }
    return hit;
  }
  if (!same.length) {
    const sets = [...new Set(all.map((f) => f.setName))].sort();
    throw new Error(`找不到配置集「${setName}」。可用：${sets.join(' / ')}`);
  }

  const picked = same.reduce((a, b) => (b.version > a.version ? b : a));
  const sets = [...new Set(all.map((f) => f.setName))].sort();
  if (sets.length > 1) {
    console.log(`(可用配置集：${sets.join(' / ')}；想回跑旧版本加参数，如 firstShow@1)`);
  } else if (vs.length > 1) {
    console.log(`(${setName} 现有版本：${vs.join(' / ')}；默认跑最新的 V${picked.version}，回跑旧版用 ${setName}@1)`);
  }
  return picked;
}

/**
 * 各版本已在设计文档里定档的距离指标，仅用作控制台对照显示（不影响判定）。
 * 按 `配置集_V版本` 精确登记；未登记的版本不打印「（文档 …）」后缀，
 * 避免拿别的版本的数来对拍。
 */
const DOC_STATS: Record<string, { all: number; max: number; same: number; cross: number }> = {
  // V1：36×30 小图 4 城（见 doc/V1 开发文档 §7.1）
  firstShow_V1: { all: 30.75, max: 55, same: 4.42, cross: 37.33 },
  // V2：60×45 大图 42 城（见 §十一 配置落地）
  firstShow_V2: { all: 22.41, max: 57, same: 1.18, cross: 22.72 },
  // V3：66 连通修正版（删 晋阳-上党、邺-河内；增 河内-上党）。节点对均值几乎不变——
  // 删掉的直连边本有等长替代路径，变化的是「直连感」而非全局距离。
  // 2026-10-06 道路双线裁剪（删 21 格冗余平行走廊）后均值微升到 22.66。
  firstShow_V3: { all: 22.66, max: 57, same: 1.18, cross: 22.73 },
};
/** DOC_STATS 查表顺序：先精确版次，再退回配置集 */
function docKey(setName: string, version: number): string {
  return `${setName}_V${version}`;
}

function main(): void {
  const latest = pickLatest(process.argv[2]);
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
    `V2 表：skill=${config.skillDefs.length} item=${config.items.length} recipe=${config.recipes.length} ` +
      `blueprint=${config.blueprints.length}`,
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

  // ── 抱负映射自检（设计 §8.6）：四抱负并集须覆盖全部技能 tag ──
  {
    const allSkills = new Set(config.skillDefs.map((s) => s.tag));
    const covered = new Set<string>();
    for (const k of ['wen', 'wu', 'zong', 'fang'] as const) {
      for (const s of AMBITION_SKILLS[k]) covered.add(s);
    }
    const missing = [...allSkills].filter((s) => !covered.has(s));
    const unknown = [...covered].filter((s) => !allSkills.has(s));
    if (missing.length) {
      console.log(`❌ 抱负映射未覆盖技能：${missing.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('✅ 抱负映射覆盖全部技能');
    }
    if (unknown.length) {
      console.log(`❌ 抱负映射含未知技能 tag：${unknown.join(', ')}`);
      process.exitCode = 1;
    }
  }

  const graph = buildGraph(config);
  const check = runSelfCheck(config, graph);
  console.log('\n── 路网对拍 ──');
  for (const it of check.items) {
    console.log(`${it.ok ? '✅' : '❌'} ${it.label}：期望 ${it.expect} / 实际 ${it.actual}`);
  }

  // ── cityLink 一致性（V3 起）：连通表 = 唯一事实源，必须与路网实测对齐 ──
  if (config.links.length) {
    console.log(`\n── cityLink 一致性（${config.links.length} 条） ──`);
    let linkBad = 0;
    for (const l of config.links) {
      const a = config.nodes.find((n) => n.name === 'city' && n.belong === l.tagA);
      const b = config.nodes.find((n) => n.name === 'city' && n.belong === l.tagB);
      if (!a || !b) {
        console.log(`❌ ${l.tagA}-${l.tagB}：城节点缺失`);
        linkBad++;
        continue;
      }
      const d = nodeDistance(graph, a.tag, b.tag);
      if (d === null) {
        console.log(`❌ ${l.tagA}-${l.tagB}：路网不可达（配置声称连通）`);
        linkBad++;
      } else if (d !== l.dist) {
        console.log(`❌ ${l.tagA}-${l.tagB}：dist 漂移，配置 ${l.dist} / 实测 ${d}`);
        linkBad++;
      }
    }
    if (linkBad) {
      console.log(`❌ cityLink 有 ${linkBad} 条与路网不一致（重跑 tools/gen_map_v2.py 可同步）`);
      process.exitCode = 1;
    } else {
      console.log('✅ 全部 link 可达且 dist 与路网实测一致');
    }
  }

  const s = check.stats;
  console.log(
    `\n图规模：${s.nodeCount} 点 ${s.edgeCount} 边（格 ${s.cellCount}），连通分量 ${s.components}，` +
      `地图占地 ${graph.bounds.w}×${graph.bounds.h} 格`,
  );
  const doc = DOC_STATS[docKey(latest.setName, latest.version)] ?? DOC_STATS[latest.setName];
  const tag = (v: number | undefined) => (doc ? `（文档 ${v}）` : '');
  console.log(
    `全部节点对 ${s.facilityPairs} 对：平均 ${s.avgAll.toFixed(2)} 格${tag(doc?.all)}，最大 ${s.maxDist}${tag(doc?.max)}\n` +
      `　同城 ${s.avgSameCity.toFixed(2)}${tag(doc?.same)}｜跨城 ${s.avgCrossCity.toFixed(2)}${tag(doc?.cross)}\n` +
      `　仅设施：同城 ${s.avgSameFacility.toFixed(2)}｜跨城 ${s.avgCrossFacility.toFixed(2)}`,
  );

  console.log('\n── 24 小时节奏模拟 ──');
  const sim = simulate(config, graph, 24);
  console.log(`完成任务：${sim.tasksDone} 个（约 ${sim.tasksPerDay.toFixed(1)} 个/天）`);
  console.log(`单任务周期：${(sim.avgTaskCycleSec / 60).toFixed(1)} 分钟（${sim.avgTaskCycleSec.toFixed(0)} 秒）`);
  console.log(`回城次数：${sim.returnTrips} 次/天`);
  console.log(`稳态空槽：${sim.avgEmptySlots.toFixed(2)} 个`);
  console.log(`累计走格：${sim.cellsWalked}`);
  console.log(`仓库：${sim.storageCount} 件 ${JSON.stringify(sim.storage)}`);
  console.log(`四维属性：${JSON.stringify(sim.attrs)}`);
  if (Object.keys(sim.skills).length) {
    const names = Object.entries(sim.skills)
      .map(([tag, p]) => `${config.skillByTag[tag]?.name ?? tag}Lv${p.lv}`)
      .join(' ');
    console.log(`九技能：${names}`);
  }
  console.log(
    `评价四档：拙${sim.evalTally[0]} / 平${sim.evalTally[1]} / 佳${sim.evalTally[2]} / 绝${sim.evalTally[3]}` +
      ` ｜ A/B/C 完成=${sim.clsTally.A ?? 0}/${sim.clsTally.B ?? 0}/${sim.clsTally.C ?? 0}` +
      ` ｜ 好感=${sim.favor} 图纸=${sim.blueprints.join('、') || '—'} 缺料停产=${sim.starvedTasks}`,
  );
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
