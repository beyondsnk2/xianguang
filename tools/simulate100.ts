/**
 * 批量模拟导出：N 个角色各挂机 X 小时，产出 xlsx。
 *
 *   sheet1「角色汇总」：角色序号 / 最终四维 / 最终九技能等级 / 统计列
 *   sheet2「任务明细」：角色序号 / 任务tag / 路上用时 / 任务用时 / 评价 / 物品奖励 / 经验奖励
 *
 * 用法：npm run sim [角色数[,小时数]] [输出文件名]
 *   npm run sim              → 100 个角色 × 24 小时
 *   npm run sim 20,72        → 20 个角色 × 72 小时
 * 口径与 `selfcheck.simulate` 一致（30 秒步长、离散事件推进），每个角色换一个初始种子。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from '../src/config/xlsxSource';
import { parseWorkbook } from '../src/config/parse';
import { buildGraph } from '../src/game/graph';
import { buildTaskIndex } from '../src/game/taskGen';
import { createInitialState } from '../src/game/state';
import { tick, type TickCtx } from '../src/game/tick';
import { TaskRecorder, type TaskRecord } from '../src/game/taskLog';
import XLSX from 'xlsx';

const CONFIG_FILE = 'firstShow_V3.xlsx';
const CHUNK_SEC = 30;
const BASE_SEED = 20261000;

interface Args {
  count: number;
  hours: number;
  out: string;
}

/** sheet2 的固定列顺序（物品最多同时给 3 种：C 类可能出「稀有 + 名品」） */
const DETAIL_COLUMNS = [
  '角色序号',
  '完成顺序',
  '任务tag',
  '任务名',
  '类别',
  '品质',
  '路上用时(秒)',
  '任务用时(秒)',
  '评价',
  '评价档位',
  '评价乘率',
  '物品1',
  '物品1数量',
  '物品2',
  '物品2数量',
  '物品3',
  '物品3数量',
  '物品合计',
  '武力经验',
  '统帅经验',
  '智力经验',
  '政治经验',
  '技能',
  '技能经验',
];

function parseArgs(): Args {
  const a = process.argv[2] ?? '';
  const parts = a.split(',').map((s) => Number(s.trim()));
  const count = Number.isFinite(parts[0]) && parts[0] > 0 ? Math.floor(parts[0]) : 100;
  const hours = Number.isFinite(parts[1]) && parts[1] > 0 ? Number(parts[1]) : 24;
  const out = process.argv[3] || path.join('out', `sim_${count}char_${hours}h.xlsx`);
  return { count, hours, out };
}

function main(): void {
  const { count, hours, out } = parseArgs();
  const buf = fs.readFileSync(path.join(process.cwd(), 'config', CONFIG_FILE));
  const sheets = readXlsx(new Uint8Array(buf));
  const { config } = parseWorkbook(sheets, {
    file: CONFIG_FILE,
    setName: 'firstShow',
    version: 3,
    loadedAt: new Date().toISOString(),
  });
  const graph = buildGraph(config);
  const taskIndex = buildTaskIndex(config);

  const skillDefs = config.skillDefs;
  const now = Date.now();
  const summaryRows: Record<string, string | number>[] = [];
  const detailRows: Record<string, string | number>[] = [];
  const maxRewardCols = 3;

  console.log(`模拟 ${count} 个角色 × ${hours} 小时（步长 ${CHUNK_SEC}s）…`);

  for (let i = 1; i <= count; i++) {
    const seed = BASE_SEED + i;
    const recorder = new TaskRecorder(i);
    const state = createInitialState(config, now, seed);
    const ctx: TickCtx = { cfg: config, graph, taskIndex, recorder };

    tick(state, 1e-9, ctx); // 触发 syncPhase：接取队首
    const steps = Math.floor((hours * 3600) / CHUNK_SEC);
    for (let s = 0; s < steps; s++) tick(state, CHUNK_SEC, ctx);

    const row: Record<string, string | number> = {
      角色序号: i,
      武力: state.attrs.force,
      统帅: state.attrs.leadership,
      智力: state.attrs.intelligent,
      政治: state.attrs.politics,
    };
    for (const s of skillDefs) row[`技能·${s.name}`] = state.skills[s.tag]?.lv ?? 0;
    row.完成任务 = state.stats.tasksDone;
    row.回城次数 = state.stats.returnTrips;
    row.累计走格 = state.stats.cellsWalked;
    row.好感 = state.favor;
    row.图纸数 = state.blueprints.length;
    row.缺料停产 = state.stats.starvedTasks;
    row['评价·拙'] = state.stats.evalTally[0];
    row['评价·平'] = state.stats.evalTally[1];
    row['评价·佳'] = state.stats.evalTally[2];
    row['评价·绝'] = state.stats.evalTally[3];
    summaryRows.push(row);

    for (const r of recorder.records) detailRows.push(detailRow(r, maxRewardCols));
    if (i % 10 === 0 || i === count) console.log(`  ${i}/${count} → ${recorder.records.length} 条明细（累计 ${detailRows.length}）`);
  }

  // ── 汇总（含均值/极值） ──
  const numCols = Object.keys(summaryRows[0] ?? {}).filter((k) => k !== '角色序号');
  const statsRow: Record<string, string | number> = { 角色序号: '均值' };
  const maxRow: Record<string, string | number> = { 角色序号: '最大值' };
  const minRow: Record<string, string | number> = { 角色序号: '最小值' };
  for (const k of numCols) {
    const vals = summaryRows.map((r) => Number(r[k]));
    statsRow[k] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
    maxRow[k] = Math.max(...vals);
    minRow[k] = Math.min(...vals);
  }
  const finalSummary = [...summaryRows, statsRow, maxRow, minRow];

  const wsSummary = XLSX.utils.json_to_sheet(finalSummary);
  // 显式指定 header：某列在全样本里都为空时表头也不丢，列顺序固定
  const wsDetail = XLSX.utils.json_to_sheet(detailRows, { header: DETAIL_COLUMNS });
  wsSummary['!cols'] = Object.keys(finalSummary[0] ?? {}).map((k) => ({ wch: Math.max(10, k.length * 2 + 4) }));
  wsDetail['!cols'] = DETAIL_COLUMNS.map((k) => ({ wch: Math.max(10, k.length * 2 + 2) }));
  wsDetail['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, '角色汇总');
  XLSX.utils.book_append_sheet(wb, wsDetail, '任务明细');

  const outAbs = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  XLSX.writeFile(wb, outAbs, { compression: true });
  console.log(`\n✅ 已导出：${outAbs}`);
  console.log(`   sheet1 角色汇总：${summaryRows.length} 行（+均值/最大/最小 3 行）`);
  console.log(`   sheet2 任务明细：${detailRows.length} 行`);
}

/** 一条明细 → 扁平化一行（物品/经验各自多列） */
function detailRow(r: TaskRecord, maxRewardCols: number): Record<string, string | number> {
  const row: Record<string, string | number> = {
    角色序号: r.charId,
    完成顺序: r.seq,
    任务tag: r.taskTag,
    任务名: r.taskName,
    类别: r.cls,
    品质: r.quality,
    '路上用时(秒)': Number(r.travelSec.toFixed(1)),
    '任务用时(秒)': r.workSec,
    评价: r.evalName,
    评价档位: r.evalTier,
    评价乘率: Number(r.evalMult.toFixed(2)),
  };
  for (let i = 0; i < maxRewardCols; i++) {
    const it = r.rewards[i];
    if (!it) continue; // 空缺的产出位留空单元格（不写空串），显著减小文件体积
    row[`物品${i + 1}`] = it.tag;
    row[`物品${i + 1}数量`] = it.n;
  }
  row.物品合计 = r.rewards.reduce((a, b) => a + b.n, 0);
  row.武力经验 = r.attrXp.force ?? 0;
  row.统帅经验 = r.attrXp.leadership ?? 0;
  row.智力经验 = r.attrXp.intelligent ?? 0;
  row.政治经验 = r.attrXp.politics ?? 0;
  row.技能 = r.skill;
  row.技能经验 = r.skillXp;
  return row;
}

main();
