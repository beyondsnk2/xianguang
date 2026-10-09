/**
 * 20 角色挂机模拟：编号 1–20 各自独立建号、连续推进，在 24h / 48h / 96h 三个挂机时长点
 * 抓快照，输出「属性 / 技能 / 人物关系 / 金钱 / 图纸」等角色状态列表。
 *
 * 用法：npm run roster（默认 24,48,96） / npm run roster -- 24,96
 *
 * ⚠ 口径说明（重要）：
 *   这里是**连续向前推进**的前向模拟（与 `npm run calib` 同口径），不是 `offlineSettle`
 *   的离线补算——后者受 OFFLINE_CAP_HOURS=8 上限约束，24/48/96h 全会被截断到 8h 而失去
 *   对比意义。前向模拟等价于「角色持续自动执行（任务自动接取、事件及时点选）」的上界。
 *   事件按 autoResolveEvents 自动点选（玩家每次都及时点击的上界）。
 */
import { loadConfig } from './pickConfig';
import { buildGraph } from '../src/game/graph';
import { buildTaskIndex } from '../src/game/taskGen';
import { createInitialState } from '../src/game/state';
import { tick, type TickCtx } from '../src/game/tick';
import { autoResolveEvents } from '../src/game/selfcheck';
import { relationStage, generalByTag } from '../src/game/generals';
import { skillTier } from '../src/game/skill';
import type { GameConfig, GameState } from '../src/game/types';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';

const { config, picked } = loadConfig(process.argv[3]);
console.log(`配置集：${picked.setName}  V${picked.version}  文件：${picked.file}`);

const CHAR_COUNT = 20;
const CHECKPOINTS = (process.argv[2] || '24,48,96')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

const graph = buildGraph(config as GameConfig);
const taskIndex = buildTaskIndex(config as GameConfig);

interface Snap {
  hours: number;
  tasksDone: number;
  returnTrips: number;
  clsA: number;
  clsB: number;
  clsC: number;
  force: number;
  leadership: number;
  intelligent: number;
  politics: number;
  attrXp: number;
  skills: Record<string, number>;
  favor: number;
  metCount: number;
  relSum: number;
  bestHero: string;
  bestRel: number;
  bestStage: string;
  blueprints: number;
  nodes: Record<string, number>;
  money: number;
  storageCount: number;
  bagCount: number;
  evals: number[];
}

function snapshot(state: GameState, hours: number): Snap {
  const skills: Record<string, number> = {};
  for (const [tag, p] of Object.entries(state.skills)) skills[tag] = p.lv;
  const relEntries = Object.entries(state.relations ?? {});
  const met = relEntries.filter(([, v]) => v > 0);
  let bestTag = '';
  let bestRel = 0;
  for (const [tag, v] of met) {
    if (v > bestRel) {
      bestRel = v;
      bestTag = tag;
    }
  }
  return {
    hours,
    tasksDone: state.stats.tasksDone,
    returnTrips: state.stats.returnTrips,
    clsA: state.stats.clsTally.A ?? 0,
    clsB: state.stats.clsTally.B ?? 0,
    clsC: state.stats.clsTally.C ?? 0,
    force: state.attrs.force,
    leadership: state.attrs.leadership,
    intelligent: state.attrs.intelligent,
    politics: state.attrs.politics,
    attrXp: state.stats.attrXpTotal ?? 0,
    skills,
    favor: state.favor,
    metCount: met.length,
    relSum: met.reduce((a, [, v]) => a + v, 0),
    bestHero: bestTag ? (generalByTag[bestTag]?.name ?? bestTag) : '—',
    bestRel,
    bestStage: bestRel > 0 ? relationStage(bestRel).name : '—',
    blueprints: state.blueprints.length,
    nodes: { ...state.blueprintNode },
    money: state.money ?? 0,
    storageCount: Object.values(state.storage).reduce((a, b) => a + b, 0),
    bagCount: Object.values(state.bag).reduce((a, b) => a + b, 0),
    evals: [...state.stats.evalTally],
  };
}

/** 单角色连续推进，在若干检查点抓快照 */
function runCharacter(id: number, checkpoints: number[]): Snap[] {
  const cfg = config as GameConfig;
  const seed = 1000003 + id * 7919; // 每角色不同种子 → 独立随机轨迹
  const ctx: TickCtx = { cfg, graph, taskIndex, online: true };
  const state = createInitialState(cfg, Date.now(), seed);
  tick(state, 1e-9, ctx); // 触发 syncPhase：接取队首

  const chunk = 30; // 秒
  const maxHours = checkpoints[checkpoints.length - 1];
  const totalSteps = Math.floor((maxHours * 3600) / chunk);
  const snaps: Snap[] = [];
  let nextCp = 0;
  for (let i = 0; i < totalSteps; i++) {
    tick(state, chunk, ctx);
    autoResolveEvents(state, cfg);
    const elapsedH = ((i + 1) * chunk) / 3600;
    while (nextCp < checkpoints.length && elapsedH >= checkpoints[nextCp]) {
      snaps.push(snapshot(state, checkpoints[nextCp]));
      nextCp++;
    }
  }
  return snaps;
}

// ── 技能列（按配置顺序，带中文名）──
const skillDefs = (config as GameConfig).skillDefs.filter((s) => s.tag && s.cls);
console.log(`\n共 ${CHAR_COUNT} 个角色，检查点 ${CHECKPOINTS.join('/')} 小时，逐角色推进中…`);

const results: Snap[][] = [];
for (let id = 1; id <= CHAR_COUNT; id++) {
  const t0 = Date.now();
  results.push(runCharacter(id, CHECKPOINTS));
  process.stdout.write(`\r  角色 ${String(id).padStart(2)}/${CHAR_COUNT} 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)   `);
}
console.log('\n');

// ── 控制台输出（中文短表头）──
const skillShort = skillDefs.map((s) => s.name.slice(0, 2));
for (let ci = 0; ci < CHECKPOINTS.length; ci++) {
  const h = CHECKPOINTS[ci];
  console.log(`\n===== 挂机 ${h} 小时 · 角色状态（${CHAR_COUNT} 人）=====`);
  const head =
    ['编号', ...skillShort, '武', '统', '智', '政', '任务', '结识', '最高', '阶段', '好感', '图纸', '金钱'].join(' | ');
  console.log(head);
  console.log(head.replace(/[^|]/g, '-'));
  for (let id = 1; id <= CHAR_COUNT; id++) {
    const s = results[id - 1][ci];
    const cells = [
      String(id).padStart(2),
      ...skillDefs.map((d) => String(s.skills[d.tag] ?? 1).padStart(skillShort[0].length)),
      String(s.force).padStart(3),
      String(s.leadership).padStart(3),
      String(s.intelligent).padStart(3),
      String(s.politics).padStart(3),
      String(s.tasksDone).padStart(4),
      String(s.metCount).padStart(3),
      String(s.bestRel).padStart(3),
      String(s.bestStage).padStart(4),
      String(s.favor).padStart(5),
      String(s.blueprints).padStart(3),
      String(s.money).padStart(6),
    ];
    console.log(cells.join(' | '));
  }
  const rows = results.map((r) => r[ci]);
  const avgLv = (tag: string) => rows.reduce((a, s) => a + (s.skills[tag] ?? 1), 0) / rows.length;
  console.log(
    `  均值：技能 ${skillDefs.map((d) => `${d.name}${avgLv(d.tag).toFixed(1)}`).join(' ')} | ` +
      `结识 ${(rows.reduce((a, s) => a + s.metCount, 0) / rows.length).toFixed(1)} 人 | ` +
      `关系总和 ${(rows.reduce((a, s) => a + s.relSum, 0) / rows.length).toFixed(0)} | ` +
      `好感 ${(rows.reduce((a, s) => a + s.favor, 0) / rows.length).toFixed(0)} | ` +
      `图纸 ${(rows.reduce((a, s) => a + s.blueprints, 0) / rows.length).toFixed(1)} | ` +
      `金钱 ${(rows.reduce((a, s) => a + s.money, 0) / rows.length).toFixed(0)}`,
  );
}

// ── 明细：结识武将（每个检查点的人均结识名单示例：取 1 号角色）──
console.log('\n===== 1 号角色 · 结识武将明细 =====');
for (let ci = 0; ci < CHECKPOINTS.length; ci++) {
  const s = results[0][ci];
  console.log(
    `  [${CHECKPOINTS[ci]}h] 结识 ${s.metCount} 人 / 关系总和 ${s.relSum} / ` +
      `最高 ${s.bestHero}=${s.bestRel}(${s.bestStage}) / 全局好感 ${s.favor} / 图纸 ${s.blueprints} 张`,
  );
}

// ── 写 xlsx（每个检查点一张表）──
const wb = XLSX.utils.book_new();
for (let ci = 0; ci < CHECKPOINTS.length; ci++) {
  const head = [
    '角色编号',
    ...skillDefs.map((d) => `${d.name}(${d.cls}类)`),
    '技能均级',
    '技能最高档',
    '武力',
    '统率',
    '智力',
    '政治',
    '属性经验',
    '完成任务',
    '回城',
    'A完成',
    'B完成',
    'C完成',
    '评价拙/平/佳/绝',
    '全局好感',
    '结识人数',
    '关系总和',
    '最高好感武将',
    '关系值',
    '关系阶段',
    '图纸数',
    '节点进度',
    '金钱',
    '仓库件数',
    '背包件数',
  ];
  const aoa: (string | number)[][] = [head];
  for (let id = 1; id <= CHAR_COUNT; id++) {
    const s = results[id - 1][ci];
    const lv = Object.values(s.skills);
    aoa.push([
      id,
      ...skillDefs.map((d) => s.skills[d.tag] ?? 1),
      +(lv.reduce((a, b) => a + b, 0) / lv.length).toFixed(1),
      skillTier(Math.max(...lv)),
      s.force,
      s.leadership,
      s.intelligent,
      s.politics,
      s.attrXp,
      s.tasksDone,
      s.returnTrips,
      s.clsA,
      s.clsB,
      s.clsC,
      s.evals.join('/'),
      s.favor,
      s.metCount,
      s.relSum,
      s.bestHero,
      s.bestRel,
      s.bestStage,
      s.blueprints,
      skillDefs
        .filter((d) => d.cls === 'C')
        .map((d) => `${d.name}${(s.nodes[d.tag] ?? 0)}`)
        .join(' '),
      s.money,
      s.storageCount,
      s.bagCount,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = head.map((_, i) => ({ wch: i === 0 ? 8 : 12 }));
  XLSX.utils.book_append_sheet(wb, ws, `挂机${CHECKPOINTS[ci]}h`);
}

const outDir = resolve(process.cwd(), 'tools', 'out');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'roster_20chars.xlsx');
XLSX.writeFile(wb, outPath);
console.log(`\n已写明细 → ${outPath}`);
