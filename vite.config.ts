import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(ROOT, 'config');

interface ConfigFileInfo {
  /** 文件名，如 firstShow_V1.xlsx */
  name: string;
  /** 配置集名，如 firstShow */
  setName: string;
  /** 版本号（数值比较） */
  version: number;
  /** 浏览器可访问的 URL */
  url: string;
  bytes: number;
}

/**
 * 扫描 config/ 目录，应用《配置读取规范.md》：
 *  - 跳过 Excel 临时锁文件（~$ 开头）
 *  - 只认 `{配置集}_V{版本号}.xlsx`
 *  - 生效文件默认取版本号最大的那个（数值比较，V10 > V9）
 *
 * **可用环境变量 `SANWALK_CONFIG` 钉住具体版本**（回跑旧配置时用）：
 *   `firstShow@1` / `@1` → firstShow_V1.xlsx；`firstShow` → 该集最大版本；不设 → 首个配置集的最大版本
 * 被顶掉的旧版本仍然会出现在 manifest.files 里（可被直接请求），只是不作为默认生效表。
 */
function scanConfigFiles(): { latest: ConfigFileInfo | null; files: ConfigFileInfo[] } {
  if (!fs.existsSync(CONFIG_DIR)) return { latest: null, files: [] };

  const all: ConfigFileInfo[] = [];
  for (const name of fs.readdirSync(CONFIG_DIR)) {
    if (name.startsWith('~$')) continue; // Excel 锁文件
    if (!/\.xlsx$/i.test(name)) continue;
    const m = /^(.+)_V(\d+)\.xlsx$/i.exec(name);
    if (!m) {
      console.warn(`[config] 忽略不符合版本规则的文件：${name}（应为 {配置集}_V{版本号}.xlsx）`);
      continue;
    }
    const stat = fs.statSync(path.join(CONFIG_DIR, name));
    all.push({
      name,
      setName: m[1],
      version: Number(m[2]),
      url: `config/${name}`,
      bytes: stat.size,
    });
  }
  const files = all.sort((a, b) => a.setName.localeCompare(b.setName) || a.version - b.version);

  // 默认生效：第一个配置集里版本号最大的
  const firstSet = files[0]?.setName;
  const maxOf = (setName: string) =>
    files.filter((f) => f.setName === setName).reduce<ConfigFileInfo | null>((a, b) => (!a || b.version > a.version ? b : a), null);
  let latest = firstSet ? maxOf(firstSet) : null;

  // 环境变量钉版本
  const pin = (process.env.SANWALK_CONFIG ?? '').trim();
  if (pin) {
    const at = pin.indexOf('@');
    const setName = (at >= 0 ? pin.slice(0, at).trim() : pin) || firstSet || '';
    const verText = at >= 0 ? pin.slice(at + 1).trim() : '';
    const hit = verText
      ? files.find((f) => f.setName === setName && f.version === Number(verText))
      : maxOf(setName);
    if (!hit) {
      const vs = files.filter((f) => f.setName === setName).map((f) => `V${f.version}`).join(' / ');
      throw new Error(
        `[config] SANWALK_CONFIG="${pin}" 匹配不到文件。${setName} 现有版本：${vs || '（无）'}`,
      );
    }
    latest = hit;
    console.log(`[config] SANWALK_CONFIG="${pin}" → 生效配置 ${hit.name}`);
  }
  return { latest, files };
}

/**
 * 把 config/ 下选中的 xlsx 与 manifest.json 暴露给前端：
 *  - dev：中间件直接读盘，改完 Excel 刷新即生效
 *  - build：作为静态资源产出到 dist/config/
 */
function configPlugin(): Plugin {
  const send = (res: import('node:http').ServerResponse, code: number, body: string | Buffer, type: string) => {
    res.statusCode = code;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  };

  return {
    name: 'sanwalk-config',
    configureServer(server) {
      server.middlewares.use('/config', (req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const { latest, files } = scanConfigFiles();
        if (url === '/manifest.json' || url === '/' || url === '') {
          send(res, 200, JSON.stringify({ dir: 'config', latest, files }), 'application/json; charset=utf-8');
          return;
        }
        const name = path.basename(url);
        const hit = files.find((f) => f.name === name);
        if (!hit) {
          send(res, 404, JSON.stringify({ error: `config/${name} 不可用` }), 'application/json; charset=utf-8');
          return;
        }
        send(
          res,
          200,
          fs.readFileSync(path.join(CONFIG_DIR, hit.name)),
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      });
    },
    // 仅构建期产出静态资源（dev 由上面的中间件直读磁盘）
    generateBundle() {
      const { latest, files } = scanConfigFiles();
      if (!files.length) {
        console.warn('[config] config/ 下没有可用的 xlsx');
      }
      for (const f of files) {
        this.emitFile({
          type: 'asset',
          fileName: `config/${f.name}`,
          source: fs.readFileSync(path.join(CONFIG_DIR, f.name)),
        });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'config/manifest.json',
        source: JSON.stringify({ dir: 'config', latest, files }),
      });
    },
  };
}

export default defineConfig({
  plugins: [configPlugin()],
  server: { port: 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
