/**
 * 控制台自检：直接读 config/ 下的 xlsx（Node 端复用同一套解析与逻辑），
 *  1. 打印生效表 / 字段数量
 *  2. 路网基准值对拍（开发文档 §7.1）
 *  3. 24 小时节奏模拟对拍（开发文档 §7.2）
 *
 * 运行：npm run check（同集最大版本，当前 V3）/ npm run check:v1（钉住 firstShow_V1）
 *       / npm run check <配置集>@<版本>（任意指定，如 firstShow@1）
 */
import { buildGraph, nodeDistance } from '../src/game/graph';
import { offlineSettle, runSelfCheck, simulate } from '../src/game/selfcheck';
import { AMBITION_SKILLS } from '../src/game/taskGen';
import { buildDemand, buildSubCatFacility, cityRatio } from '../src/game/economy';
import { loadConfig } from './pickConfig';

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
  const { config, picked: latest, warnings } = loadConfig(process.argv[2]);
  console.log(`配置集：${latest.setName}  版本：V${latest.version}  文件：${latest.file}`);

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
      `任务槽=${config.values.initTaskListSlot} 出生候选=${config.values.startCityRand.join('/')}` +
      ` 初始金钱=${config.values.initMoney}文`,
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
  console.log(
    `随机事件：结算 ${sim.eventsSettled} 条（${(sim.eventsSettled / Math.max(1, sim.hours / 24)).toFixed(1)} 条/天）` +
      ` ｜ 属性经验累计 ${sim.attrXpTotal}（${(sim.attrXpTotal / 24).toFixed(1)}/天，四维合计）` +
      ` ｜ 容器残留 ${sim.pendingLeft}`,
  );
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
  console.log(
    `金钱：${sim.money} 文（初始 ${config.values.initMoney}）｜累计收入 +${sim.moneyEarned}（工钱 ${sim.moneyEarnedWage} / 赏金 ${sim.moneyEarnedBounty}）／ 支出 -${sim.moneySpent} ｜ 自动补货 ${sim.restockCount} 次`,
  );
  console.log(`空转采样：${sim.idleSamples} / ${sim.samples}（应 0）｜超容未回城：${sim.overloadViolations}（应 0）`);

  // V4 价格体系（无 price 表时整体禁用，这里是唯一的观测口）
  if (config.priceRows.length) {
    const mats = config.priceRows.filter((p) => p.cat === '材料').sort((a, b) => a.tier - b.tier);
    const priced = config.items.filter((i) => i.price > 0);
    const noSell = config.items.filter((i) => !i.sellable);
    console.log(
      `\n── 价格体系 ──\n` +
        `材料骨架：${mats.map((p) => `t${p.tier}=${p.base}`).join(' ')}（工钱/赏金/补货读此档）\n` +
        `物品有价：${priced.length} / ${config.items.length} ｜ 不同价格 ${new Set(priced.map((i) => i.price)).size} 个 ｜ ` +
        `区间 ${Math.min(...priced.map((i) => i.price))}~${Math.max(...priced.map((i) => i.price))} 文 ｜ ` +
        `不可售 ${noSell.length}（${noSell.map((i) => i.name).join('、') || '—'}）\n` +
        `稀有稀缺系数：${Object.values(config.subCatRatio).map((r) => `${r.subCat}=${r.ratio}`).join(' ') || '—'}`,
    );

    // E4 城际供需系数（补货买价的一部分：基准 × 城系数 × 溢价）
    const demand = buildDemand(config);
    const fac = buildSubCatFacility(config);
    const tally: Record<string, number> = {};
    let cells = 0;
    for (const c of config.cities) {
      for (const sub of Object.keys(fac)) {
        const r = cityRatio(demand, c.tag, sub);
        tally[String(r)] = (tally[String(r)] ?? 0) + 1;
        cells++;
      }
    }
    console.log(
      `城际供需：材料 subCat ${Object.keys(fac).length} 个（${Object.entries(fac).map(([s, n]) => `${s}→${n}`).join(' ')}）\n` +
        `系数分布：${Object.entries(tally).sort().map(([r, n]) => `${r}×${n}`).join(' ／ ')}（合计 ${cells} = ${config.cities.length} 城 × ${Object.keys(fac).length}）`,
    );
  } else {
    console.log('\n── 价格体系 ──\n（无 price 表 → 经济系统整体禁用）');
  }

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
