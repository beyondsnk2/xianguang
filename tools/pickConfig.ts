/**
 * 命令行工具的公共入口：选配置 + 载入（check / calib / simulate 共用一套规则）。
 *
 * 抽出来的原因：`calib.ts` 曾把文件名硬编码成 `firstShow_V3.xlsx`，
 * 升到 V4 后它仍在跑 V3 —— 校准与自检对不上。现在一律走 `pickLatest()`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from '../src/config/xlsxSource';
import { parseWorkbook } from '../src/config/parse';
import type { GameConfig } from '../src/game/types';

export const CONFIG_DIR = path.join(process.cwd(), 'config');
/** 未显式指定配置集时用它 */
const DEFAULT_SET = 'firstShow';

export interface PickedConfigFile {
  file: string;
  setName: string;
  version: number;
}

/**
 * 选配置 + 选版本。命名规则 `{配置集名}_V{版本号}.xlsx`，**同名默认取版本号最大的**
 * （所以 firstShow_V1 会自动被更大的版本顶掉；要回跑旧版必须显式钉版本）。
 * @param want 三种写法：
 *   - 省略            → 默认配置集的最大版本
 *   - `firstShow`     → 该配置集的最大版本
 *   - `firstShow@1` / `@1` → 精确钉住某版本（@ 前留空则用默认集）
 */
export function pickLatest(want?: string): PickedConfigFile {
  const all: PickedConfigFile[] = [];
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

export interface LoadedConfig {
  config: GameConfig;
  picked: PickedConfigFile;
  warnings: string[];
}

/** 按「最大版本」规则载入配置（不打印任何信息，打印交给调用方） */
export function loadConfig(want?: string): LoadedConfig {
  const picked = pickLatest(want);
  const buf = fs.readFileSync(path.join(CONFIG_DIR, picked.file));
  const sheets = readXlsx(new Uint8Array(buf));
  const { config, warnings } = parseWorkbook(sheets, {
    file: picked.file,
    setName: picked.setName,
    version: picked.version,
    loadedAt: new Date().toISOString(),
  });
  return { config, picked, warnings };
}
