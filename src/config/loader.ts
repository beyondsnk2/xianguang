import { readXlsx } from './xlsxSource';
import { parseWorkbook } from './parse';
import type { GameConfig } from '../game/types';

export interface ConfigFileInfo {
  name: string;
  setName: string;
  version: number;
  url: string;
  bytes: number;
}

export interface ConfigManifest {
  dir: string;
  latest: ConfigFileInfo | null;
  files: ConfigFileInfo[];
}

export interface LoadedConfig {
  config: GameConfig;
  warnings: string[];
  manifest: ConfigManifest;
}

/**
 * 浏览器运行时读取 config/ 下的 xlsx：
 *   1. 拉 manifest.json（由 vite 插件按版本规则扫描生成）
 *   2. 拉 manifest.latest 指向的那个 xlsx（同集默认最大版本；构建时可用
 *      环境变量 `SANWALK_CONFIG=firstShow@1` 钉住旧版本回跑）
 *   3. SheetJS 解析 → parse.ts 应用 $ / 表头 / 空行规则
 */
export async function loadGameConfig(base = ''): Promise<LoadedConfig> {
  const manifestUrl = `${base}config/manifest.json`;
  const manifestRes = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!manifestRes.ok) throw new Error(`无法读取 ${manifestUrl}（${manifestRes.status}）`);
  const manifest = (await manifestRes.json()) as ConfigManifest;
  const target = manifest.latest;
  if (!target) throw new Error('config/ 下没有符合 {配置集}_V{版本号}.xlsx 的文件');

  const res = await fetch(`${base}${target.url}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`无法读取 ${target.url}（${res.status}）`);
  const buf = await res.arrayBuffer();
  const sheets = readXlsx(new Uint8Array(buf));

  const { config, warnings } = parseWorkbook(sheets, {
    file: target.name,
    setName: target.setName,
    version: target.version,
    loadedAt: new Date().toISOString(),
  });
  return { config, warnings, manifest };
}
