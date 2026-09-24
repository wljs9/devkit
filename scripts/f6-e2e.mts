/**
 * ★ F6-impl e2e(2026-09-24):真网验证四个新工具的 catalog。
 * 与 f4-e2e.mts 同模式;本轮四工具均非 pinned(官方 sidecar / API 内嵌),故只做:
 *   --discover  —— 在线全量跑四工具的版本发现,打印结果概览;
 *   --url <tool> <ver> —— 打印某版本的首选源 fileUrl + 校验 URL(供人工抽查 Range 206 / PK 魔数)。
 * 运行(先 esbuild 打包):
 *   pnpm exec esbuild scripts/f6-e2e.mts --bundle --platform=node --format=cjs --external:electron --outfile=scripts/.f6-e2e.cjs
 *   node scripts/.f6-e2e.cjs --discover
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCatalogDir, fileUrlFor, checksumUrlsFor, type CatalogEntry, type DiscoveredVersion } from '../src/main/core/catalog';

const ROOT = path.resolve(process.cwd());
const cacheFile = path.join(os.tmpdir(), 'f6-cache.json');

const entries = new Map(loadCatalogDir(path.join(ROOT, 'catalog')).map((e) => [e.id, e]));
const TOOLS = ['jmeter', 'ant', 'tomcat', 'dotnet'];

async function discover(e: CatalogEntry) {
  const { getVersions } = await import('../src/main/core/catalog');
  return getVersions(e, {
    force: true,
    cache: {
      read: () => (fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}),
      write: (d) => fs.writeFileSync(cacheFile, JSON.stringify(d)),
    },
  });
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === '--discover') {
    for (const id of TOOLS) {
      const e = entries.get(id)!;
      try {
        const vs: DiscoveredVersion[] = await discover(e);
        console.log(`\n[${id}] ${e.displayName}: ${vs.length} 版可列`);
        for (const v of vs.slice(0, 4)) {
          const vars = { ver: v.version, asset: v.asset, ...(v.extra ?? {}) };
          console.log(`  ${v.version}  asset=${v.asset}${v.size ? ` (${(v.size / 1048576).toFixed(0)}MB)` : ''}${v.checksum ? ` cs=${v.checksum.algo}:${v.checksum.hex.slice(0, 8)}…` : ''}  src=${v.preferredSourceId || '?'}`);
        }
        const jv = vs.find((x) => /^\d/.test(x.version));
        if (jv) {
          const src = e.sources[0]!.id;
          const vars = { ver: jv.version, asset: jv.asset, ...(jv.extra ?? {}) };
          console.log(`  样例 URL: ${fileUrlFor(e, src, vars)}`);
          console.log(`  校验 URL: ${checksumUrlsFor(e, { ver: jv.version }).join(' , ')}`);
        }
      } catch (err) {
        console.log(`\n[${id}] FAIL: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
  } else if (cmd === '--url' && process.argv[3] && process.argv[4]) {
    const e = entries.get(process.argv[3])!;
    const ver = process.argv[4];
    const vs: DiscoveredVersion[] = await discover(e);
    const v = vs.find((x) => x.version === ver)!;
    const vars = { ver: v.version, asset: v.asset, ...(v.extra ?? {}) };
    console.log(`URL: ${fileUrlFor(e, e.sources[0]!.id, vars)}`);
    console.log(`校验: ${checksumUrlsFor(e, { ver: v.version }).join(' , ')}`);
  }
}

void main();