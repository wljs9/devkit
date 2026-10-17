/**
 * ★ F8-impl e2e(2026-10-17):真网验证两个新工具(Groovy / Flutter)的 catalog。
 * 与 f4/f6-e2e 同模式:
 *   --discover          —— 在线跑两工具的版本发现,打印结果概览(重点验 Flutter 的 map 增强路径);
 *   --install <tool>    —— 完整 install()(下载→校验→解压→登记→建链)+ adopt 探测演练 + --version 实测;
 *   --url <tool> [ver]  —— 打印首选源 fileUrl + 校验 URL/内嵌哈希(供人工抽查 Range 206 / PK 魔数)。
 * ★ 运行方式(2026-10-17 实测):本机**没有 esbuild**(devDependencies 里没有,`pnpm exec esbuild` 报 not found),
 *   改用仓库已有的 **jiti** 直跑 TS(能解析无扩展名 import):
 *     node_modules/.bin/jiti scripts/f8-e2e.mts --discover
 *     node_modules/.bin/jiti scripts/f8-e2e.mts --install groovy
 *   (f4/f6-e2e 文档里写的 esbuild 路径在本机已不可用,新会话勿再照抄。)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile as cpExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCatalogDir, fileUrlFor, checksumUrlsFor, type CatalogEntry, type DiscoveredVersion } from '../src/main/core/catalog';
import { Downloader } from '../src/main/core/download';
import { ensureDevRoot, install, probeAdoptVersion } from '../src/main/core/install';
import { HistoryLog } from '../src/main/core/history';
import { JsonRepository } from '../src/main/core/store';

const ROOT = path.resolve(process.cwd());
const DEV = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-f8-e2e-'));
const entries = new Map(loadCatalogDir(path.join(ROOT, 'catalog')).map((e) => [e.id, e]));
const TOOLS = ['groovy', 'flutter'];

async function discover(e: CatalogEntry) {
  const cacheFile = path.join(os.tmpdir(), 'f8-cache.json');
  return (await import('../src/main/core/catalog')).getVersions(e, {
    force: true,
    cache: {
      read: () => (fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}),
      write: (d) => fs.writeFileSync(cacheFile, JSON.stringify(d)),
    },
  });
}

function fmt(v: DiscoveredVersion) {
  const cs = v.checksum ? `${v.checksum.algo}:${v.checksum.hex.slice(0, 8)}…` : '—';
  return `${v.version}${v.size ? `(${(v.size / 1048576).toFixed(0)}MB)` : ''} cs=${cs}`;
}

function varsOf(e: CatalogEntry, v: DiscoveredVersion) {
  const vars: Record<string, string> = { ver: v.version, asset: v.asset, ...(v.extra ?? {}), dir: v.extra?.href ?? v.version };
  for (const a of e.aliases ?? []) vars[a.name] = String(vars.ver).split(a.from).join(a.to);
  return vars;
}

async function fullInstall(e: CatalogEntry, v: DiscoveredVersion) {
  const store = new JsonRepository(path.join(DEV, 'devkit.json'));
  const history = new HistoryLog(path.join(DEV, 'history.jsonl'));
  const dl = new Downloader({ devRoot: DEV });
  ensureDevRoot(DEV);
  const rec = await install(e, v, {}, { devRoot: DEV, downloader: dl, store, history });
  console.log(`   ✓ 已装 ${e.id} ${rec.version} → ${rec.path} (current=${rec.isCurrent})`);
  if (e.adopt) {
    try {
      const hit = await probeAdoptVersion(e, rec.path);
      console.log(`   ✓ adopt 探测命中: via=${hit.via} version=${hit.version}`);
    } catch (err) {
      console.log(`   ⚠ adopt 探测失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`   顶层内容: ${fs.readdirSync(rec.path).slice(0, 10).join(', ')}`);
  const exe = e.adopt?.exec ? path.join(rec.path, e.adopt.exec) : null;
  if (exe && fs.existsSync(exe)) {
    try {
      const r = await promisify(cpExecFile)(exe, ['--version'], { windowsHide: true, timeout: 30_000 });
      console.log(`   ${e.id} --version → ${(r.stdout + r.stderr).trim().slice(0, 140)}`);
    } catch (err) {
      console.log(`   ${e.id} --version → 执行失败:${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const job = args[0] ?? '--discover';
  console.log(`DevRoot: ${DEV}\n`);
  for (const id of TOOLS) {
    if ((job === '--install' || job === '--url') && args[1] && args[1] !== id) continue;
    const e = entries.get(id)!;
    console.log(`== ${e.displayName} (${id}) ==`);
    try {
      const vs = await discover(e);
      console.log(`   发现 ${vs.length} 个版本: ${vs.slice(0, 5).map(fmt).join(' | ')}`);
      if (!vs.length) continue;
      const v = args[2] ? vs.find((x) => x.version === args[2])! : vs[0]!;
      const vars = varsOf(e, v);
      console.log(`   样例 URL: ${fileUrlFor(e, v.preferredSourceId ?? e.sources[0]!.id, vars)}`);
      console.log(`   校验: ${e.checksum.kind} → ${checksumUrlsFor(e, vars).join(' , ') || `内嵌 ${v.checksum?.algo}:${v.checksum?.hex}`}`);
      if (job === '--install') await fullInstall(e, v);
    } catch (err) {
      console.log(`   ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('\nDevRoot 保留在: ' + DEV);
}

void main();