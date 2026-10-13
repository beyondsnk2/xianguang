/**
 * 把 bg1 底图参数写入 firstShow_V5.xlsx 的 config 表（幂等，可重复执行）。
 *  - mapBgImg = bg1.png（public/ 下已有该文件）
 *  - bg1OffsetX / bg1OffsetY：底图偏移（坐标空间）
 *  - bg1ScaleW / bg1ScaleH：底图缩放（倍率，1 = 按点位包围盒 cover 铺满）
 *  - bg1Opacity：底图浓度（0~1 小数）
 * 语义与地图编辑器右侧「底图」面板一致：缩放围绕点位包围盒中心，之后整体平移。
 * 写回前自动备份为 firstShow_V5.preBg1.bak.xlsx（已存在则跳过备份）。
 *
 * 运行：node tools/cfgBg1.cjs
 */
const XLSX = require('E:/xianguang/node_modules/xlsx');
const fs = require('fs');
const path = 'E:/xianguang/config/firstShow_V5.xlsx';
const bak = 'E:/xianguang/config/firstShow_V5.preBg1.bak.xlsx';

if (!fs.existsSync(bak)) {
  fs.copyFileSync(path, bak);
  console.log('已备份原文件 →', bak);
} else {
  console.log('备份已存在，跳过备份 →', bak);
}

const wb = XLSX.readFile(path);
if (!wb.SheetNames.includes('config')) {
  console.error('config 表不存在，终止');
  process.exit(1);
}

// 读旧行（保序），按 tag 更新 / 插入
const rows = XLSX.utils.sheet_to_json(wb.Sheets['config'], { defval: null });
const byTag = new Map(rows.map((r) => [String(r['tag'] ?? '').trim(), r]));

const set = (tag, content, note) => {
  const hit = byTag.get(tag);
  if (hit) {
    hit.content = content;
    if (note) hit.note = note;
    return '更新';
  }
  const row = { tag, content, note };
  byTag.set(tag, row);
  rows.push(row);
  return '新增';
};

console.log('mapBgImg   :', set('mapBgImg', 'bg1.png', '地图背景图（public/ 下文件名；留空=程序化占位底图）'));
console.log('bg1OffsetX :', set('bg1OffsetX', 0, 'bg1 底图偏移 X（坐标空间；围绕点位包围盒中心缩放后整体平移）'));
console.log('bg1OffsetY :', set('bg1OffsetY', 0, 'bg1 底图偏移 Y'));
console.log('bg1ScaleW  :', set('bg1ScaleW', 1, 'bg1 底图宽缩放（倍率；1=按点位包围盒 cover 铺满）'));
console.log('bg1ScaleH  :', set('bg1ScaleH', 1, 'bg1 底图高缩放（倍率）'));
console.log('bg1Opacity :', set('bg1Opacity', 0.85, 'bg1 底图浓度（0~1 小数；编辑器同步可调）'));

// 重排：mapBgImg 之后紧跟 5 个 bg1 参数，其余保持原序
const order = ['mapBgImg', 'bg1OffsetX', 'bg1OffsetY', 'bg1ScaleW', 'bg1ScaleH', 'bg1Opacity'];
const head = rows.filter((r) => order.includes(String(r['tag'] ?? '').trim()));
const tail = rows.filter((r) => !order.includes(String(r['tag'] ?? '').trim()));
head.sort((a, b) => order.indexOf(String(a['tag']).trim()) - order.indexOf(String(b['tag']).trim()));
const out = [...head, ...tail];

wb.Sheets['config'] = XLSX.utils.json_to_sheet(out);
XLSX.writeFile(wb, path);

// 校验回读
const wb2 = XLSX.readFile(path);
const cfg2 = XLSX.utils.sheet_to_json(wb2.Sheets['config'], { defval: null });
console.log('--- 回读 config 表 ---');
for (const r of cfg2) console.log(String(r['tag']).padEnd(24), JSON.stringify(r['content']));
console.log('完成。');
