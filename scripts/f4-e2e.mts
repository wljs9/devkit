/**
 * ★ F4 e2e(2026-09-16):真网验证六个新工具的 catalog。
 * 用途:
 *   1. `--discover`  —— 在线全量跑六工具的版本发现(清单/jsonApi/redirect + rawVersion/别名/截断),打印结果;
 *   2. `--pin <tool>` —— 对 pinned 校验工具:真下载(不校验)并打印 sha256,供回填 catalog 的 pinned 表;
 *   3. `--install <tool>` —— 对已回填 pinned 的工具:完整 install() 走"下载→校验→解压→登记→建链",验证布局/登记/接管探测。
 * 运行:先用 esbuild 打包一次性执行:
 *   pnpm exec esbuild scripts/f4-e2e.mts --bundle --platform=node --format=cjs --external:electron --outfile=scripts/.f4-e2e.cjs
 *   node scripts/.f4-e2e.cjs --discover
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile as cpExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCatalogDir, type CatalogEntry } from '../src/main/core/catalog';
import { Downloader } from '../src/main/core/download';
import { ensureDevRoot, install, adoptInstall, probeAdoptVersion, setCurrent } from '../src/main/core/install';
import { HistoryLog } from '../src/main/core/history';
import { JsonRepository } from '../src/main/core/store';
import type { DiscoveredVersion } from '../src/main/core/catalog';

const ROOT = path.resolve(process.cwd()); // 从仓库根运行
const DEV = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-f4-e2e-'));

const entries = new Map(loadCatalogDir(path.join(ROOT, 'catalog')).map((e) => [e.id, e]));
const TOOLS = [...entries.keys()].filter((id) => ['git', 'vscode', 'python', 'idea', 'pycharm', 'dbeaver'].includes(id));

async function discover(e: CatalogEntry) {
  const cache = { file: path.join(os.tmpdir(), 'f4-cache.json') };
  const now = () => new Date();
  const vs = await import('../src/main/core/catalog').then((m) => m.getVersions(e, {
    force: true,
    cache: {
      read: () => (fs.existsSync(cache.file) ? JSON.parse(fs.readFileSync(cache.file, 'utf8')) : {}),
      write: (d) => fs.writeFileSync(cache.file, JSON.stringify(d)),
    },
    now,
  }));
  return vs;
}

const fmt = (v: DiscoveredVersion) => `${v.version}${v.size ? ` (${(v.size / 1048576).toFixed(0)}MB)` : ''}${v.checksumUrl ? ' [sidecar]' : ''}`;

async function pinHash(e: CatalogEntry, v: DiscoveredVersion): Promise<string> {
  const rear = new Downloader({ devRoot: DEV });
  // 与 install.ts varsOf 同构:extra + 模板别名 + dir(别名是 fileUrl 必需的,如 MinGit 的 {gitver})
  const vars: Record<string, string> = {
    ver: v.version, asset: v.asset, ...(v.extra ?? {}), dir: v.extra?.href ?? v.version,
  };
  for (const a of e.aliases ?? []) vars[a.name] = String(vars.ver).split(a.from).join(a.to);
  const url = (await import('../src/main/core/catalog')).fileUrlFor(e, v.preferredSourceId ?? e.sources[0]!.id, vars);
  const out = await rear.start({ id: `${e.id}-${v.version}`, url, fileName: `${e.id}-${v.version}.zip` });
  console.log(`   ${e.id} ${v.version}: ${(out.bytes / 1048576).toFixed(1)}MB sha256=${out.sha256}`);
  return out.sha256;
}

async function fullInstall(e: CatalogEntry, v: DiscoveredVersion) {
  const store = new JsonRepository(path.join(DEV, 'devkit.json'));
  const history = new HistoryLog(path.join(DEV, 'history.jsonl'));
  const dl = new Downloader({ devRoot: DEV });
  ensureDevRoot(DEV);
  const ctx = { devRoot: DEV, downloader: dl, store, history };
  process.stderr.write(`  [install] ${e.id} ${v.version} 开始 url=...\n`);
  const rec = await install(e, v, {}, ctx).catch((err) => {
    process.stderr.write(`  [install] 抛错: ${err?.name}: ${err?.message}\n`);
    throw err;
  });
  process.stderr.write(`  [install] 完成 rec=${rec.id}\n`);
  console.log(`   ✓ 已装 ${e.id} ${rec.version} → ${rec.path} (current=${rec.isCurrent})`);
  // 接管探测演练:对刚装的目录跑 adopt 探测链,确认 markers/exec 对真实布局有效
  if (e.adopt) {
    try {
      const hit = await probeAdoptVersion(e, rec.path);
      console.log(`   ✓ adopt 探测命中: via=${hit.via} version=${hit.version}`);
    } catch (err) {
      console.log(`   ⚠ adopt 探测失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`   顶层内容: ${fs.readdirSync(rec.path).slice(0, 12).join(', ')}`);
}

async function runVersionExec(e: CatalogEntry, recPath: string) {
  const exe = e.adopt?.exec ? path.join(recPath, e.adopt.exec) : null;
  if (!exe || !fs.existsSync(exe)) return;
  try {
    const r = await promisify(cpExecFile)(exe, ['--version'], { windowsHide: true, timeout: 8000 });
    console.log(`   ${e.id} --version → ${(r.stdout + r.stderr).trim().slice(0, 120)}`);
  } catch (err) {
    console.log(`   ${e.id} --version → 执行失败:${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const job = args[0] ?? '--discover';
  console.log(`DevRoot: ${DEV}\n`);
  for (const id of TOOLS) {
    const e = entries.get(id)!;
    if ((job === '--install' || job === '--pin') && args[1] && args[1] !== id) continue;
    console.log(`== ${e.displayName} (${id}) ==`);
    try {
      const vs = await discover(e);
      console.log(`   发现 ${vs.length} 个版本: ${vs.slice(0, 5).map(fmt).join(' | ')}`);
      if (!vs.length) continue;
      if (job === '--pin') {
        if (e.checksum.kind !== 'pinnedHash') { console.log('   非 pinned 校验,跳过'); continue; }
        for (const v of vs) await pinHash(e, v); // 商店列出的每个版本都取哈希
      } else if (job === '--install') {
        await fullInstall(e, vs[0]!);
        await runVersionExec(e, path.join(DEV, 'tools', id, vs[0]!.version));
      }
    } catch (err) {
      console.log(`   ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('\nDevRoot 保留在: ' + DEV);
}

main().catch((e) => { console.error(e); process.exit(1); });