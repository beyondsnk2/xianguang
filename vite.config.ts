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
 *  - 同一配置集只保留版本号最大的那个（数值比较，V10 > V9）
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

  // 同一配置集只取版本号最大的
  const latestBySet = new Map<string, ConfigFileInfo>();
  for (const f of all) {
    const cur = latestBySet.get(f.setName);
    if (!cur || f.version > cur.version) latestBySet.set(f.setName, f);
  }
  const files = [...latestBySet.values()].sort((a, b) => a.setName.localeCompare(b.setName));
  const latest = files[0] ?? null;
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
