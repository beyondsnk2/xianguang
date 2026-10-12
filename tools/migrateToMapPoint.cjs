/**
 * 一键迁移 firstShow_V5.xlsx：city → mapPoint（新增 type 列，值 city），cityLink → mapPointLink。
 * 拐点（waypoint）最初为空，后续用编辑器新增。
 * 写回前自动备份为 firstShow_V5.preMapPoint.bak.xlsx（已存在则跳过，避免重复备份）。
 *
 * 运行（绕过本机精简 Git Bash 的 npm 坑）：
 *   node node_modules/esbuild/bin/esbuild tools/migrateToMapPoint.cjs ...   ← 不需要，直接 node 跑即可
 *   node tools/migrateToMapPoint.cjs
 */
const XLSX = require('E:/xianguang/node_modules/xlsx');
const fs = require('fs');
const path = 'E:/xianguang/config/firstShow_V5.xlsx';
const bak = 'E:/xianguang/config/firstShow_V5.preMapPoint.bak.xlsx';

if (fs.existsSync(bak)) {
  console.log('备份已存在，跳过迁移（如需重做请先删除备份）。');
  process.exit(0);
}
fs.copyFileSync(path, bak);
console.log('已备份原文件 →', bak);

const wb = XLSX.readFile(path);

// city → mapPoint（追加 type=列）
if (wb.SheetNames.includes('city')) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['city'], { defval: null });
  rows.forEach((r) => {
    if (!('type' in r)) r.type = 'city';
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  delete wb.Sheets['city'];
  wb.Sheets['mapPoint'] = ws;
  const i = wb.SheetNames.indexOf('city');
  if (i >= 0) wb.SheetNames[i] = 'mapPoint';
  console.log('city → mapPoint：', rows.length, '行');
}

// cityLink → mapPointLink（仅改名）
if (wb.SheetNames.includes('cityLink')) {
  const cl = wb.Sheets['cityLink'];
  delete wb.Sheets['cityLink'];
  wb.Sheets['mapPointLink'] = cl;
  const j = wb.SheetNames.indexOf('cityLink');
  if (j >= 0) wb.SheetNames[j] = 'mapPointLink';
  console.log('cityLink → mapPointLink');
}

XLSX.writeFile(wb, path);

// 校验
const wb2 = XLSX.readFile(path);
const mp = XLSX.utils.sheet_to_json(wb2.Sheets['mapPoint'] || {}, { defval: null });
const ml = XLSX.utils.sheet_to_json(wb2.Sheets['mapPointLink'] || {}, { defval: null });
console.log('迁移后表：', wb2.SheetNames.join(', '));
console.log('mapPoint 行数：', mp.length, '样例：', JSON.stringify(mp[0]));
console.log('mapPointLink 行数：', ml.length, '样例：', JSON.stringify(ml[0]));
console.log('完成。游戏 parse 已兼容新旧表名，可立即用新 xlsx 启动。');
