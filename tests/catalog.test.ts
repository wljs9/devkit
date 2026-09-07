import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CatalogEntrySchema,
  FileCachePort,
  checksumUrlsFor,
  fileUrlFor,
  getVersions,
  listVersions,
  loadCatalogDir,
  renderTemplate,
  TTL_MS,
} from '../src/main/core/catalog';
import { startFileServer, stubResponses } from './helpers/server';

// ---- 真实仓库 catalog:加载即门禁(M1 测试不许绕过实测定稿文件) ----
describe('catalog/ 定稿文件(§6)', () => {
  it('三份清单全部通过 zod 校验', () => {
    const dir = url.fileURLToPath(new URL('../catalog', import.meta.url)); // tests/ 上一级即仓库根
    const entries = loadCatalogDir(dir);
    expect(entries.map((e) => e.id).sort()).toEqual(['jdk', 'maven', 'node']);
  });
});

const NODE_HTML = [
  '<a href="../">P</a>',
  '<a href="v22.20.0/">22</a>',
  '<a href="v9.6.0/">9</a>',
  '<a href="v24.1.0/">24</a>',
  '<a href="latest/">latest</a>',
  '<a href="v10.0.0-rc1/">rc</a>',
].join('\n');

function nodeCatalog(overrides = {}) {
  const raw: unknown = {
    id: 'node',
    displayName: 'Node.js',
    listKind: 'dirIndex',
    dirRegex: '^v(?<ver>\\d+\\.\\d+\\.\\d+)/$',
    fileRegex: '^node-v(?<ver>\\d+\\.\\d+\\.\\d+)-win-x64\\.zip$',
    sources: [
      { id: 'huawei', listUrl: 'https://mirrors.invalid/nodejs/', fileUrl: 'https://mirrors.invalid/nodejs/v{ver}/node-v{ver}-win-x64.zip' },
      { id: 'official', listUrl: 'https://nodejs.invalid/dist/', fileUrl: 'https://nodejs.invalid/dist/v{ver}/node-v{ver}-win-x64.zip', proxyable: true },
    ],
    checksum: { kind: 'shasumsFile', algo: 'sha256', urls: ['https://mirrors.invalid/nodejs/v{ver}/SHASUMS256.txt'], lineMatch: '  node-v{ver}-win-x64.zip$' },
    rootDir: 'node-v{ver}-win-x64',
    layout: 'binAtRoot',
    ...overrides,
  };
  const r = CatalogEntrySchema.safeParse(raw);
  if (!r.success) throw new Error('test fixture invalid: ' + r.error.message);
  return r.data;
}

describe('dirIndex 解析', () => {
  it('提版本、滤非目录、semver 降序、资产名模板渲染', async () => {
    const { fn } = await stubResponses({ 'https://mirrors.invalid/nodejs/': NODE_HTML });
    const vs = await listVersions(nodeCatalog(), { fetchImpl: fn });
    expect(vs.map((v) => v.version)).toEqual(['24.1.0', '22.20.0', '9.6.0']); // latest/ ../ v10.0.0-rc1/ 均被滤
    expect(vs[1]!.dir).toBe('22.20.0');
    expect(vs[1]!.asset).toBe('node-v22.20.0-win-x64.zip');
    expect(vs[1]!.preferredSourceId).toBe('huawei');
  });
  it('首选源不可达 → 自动换下一个带 listUrl 的源', async () => {
    const { fn } = await stubResponses({ 'https://nodejs.invalid/dist/': NODE_HTML }); // huawei 故意缺席(418)
    const vs = await listVersions(nodeCatalog(), { fetchImpl: fn });
    expect(vs.length).toBe(3);
  });
  it('全部目录源失败 → catalog-unreachable', async () => {
    const { fn } = await stubResponses({});
    await expect(listVersions(nodeCatalog(), { fetchImpl: fn })).rejects.toThrowError(/目录源失败/);
  });
});

describe('adoptiumApi 解析(Temurin)', () => {
  const apiRelease = (sem: string, build: number, asset: string, link: string) => ({
    release_name: `jdk-${sem.split('+')[0]}+${build}`,
    version_data: { semver: sem, build },
    binaries: [{ package: { link, checksum: 'a'.repeat(64), size: 123 } }],
  });
  const jdkCatalog = () => {
    const r = CatalogEntrySchema.safeParse({
      id: 'jdk', displayName: 'JDK', listKind: 'adoptiumApi', majors: [21],
      listApi: 'https://api.invalid/feature_releases/{major}/ga',
      releaseFields: { releaseName: 'release_name', semver: 'version_data.semver', build: 'version_data.build', packageLink: 'binaries.0.package.link', packageChecksum: 'binaries.0.package.checksum', packageSize: 'binaries.0.package.size' },
      fileRegex: '^OpenJDK\\d+U-jdk_x64_windows_hotspot_[\\w.]+\\.zip$',
      sources: [
        { id: 'ustc-latest', listUrl: 'https://ustc.invalid/LatestRelease/', fileUrl: 'https://ustc.invalid/LatestRelease/{asset}', scope: 'latestOnly' },
        { id: 'ghproxy', fileUrl: 'https://github.invalid/dl/{releaseNameUrlenc}/{asset}', proxy: { kind: 'prefix', value: 'https://ghfast.top/' } },
      ],
      checksum: { kind: 'adoptiumApi', algo: 'sha256' },
      rootDir: '{releaseName}', layout: 'binSubdir',
    });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  };

  it('字段抽取 + 各 major 最新指 ustc、历史指 ghproxy', async () => {
    const body = JSON.stringify([
      apiRelease('21.0.12+101.0.LTS', 101, 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_101.zip', 'https://github.com/x/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_101.zip'),
      apiRelease('21.0.9+10.0.LTS', 10, 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip', 'https://github.com/x/OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip'),
    ]);
    const { fn } = await stubResponses({ 'https://api.invalid/feature_releases/21/ga': body });
    const vs = await listVersions(jdkCatalog(), { fetchImpl: fn });
    expect(vs.map((v) => `${v.version}#${v.build}@${v.preferredSourceId}`)).toEqual([
      '21.0.12#101@ustc-latest',
      '21.0.9#10@ghproxy',
    ]);
    expect(vs[1]!.checksum).toEqual({ algo: 'sha256', hex: 'a'.repeat(64) });
    expect(vs[1]!.releaseName).toBe('jdk-21.0.9+10');
    expect(vs[1]!.size).toBe(123);
  });

  it('fileUrlFor:ghproxy 拼代理前缀且 releaseName 转义 + 号', () => {
    const e = jdkCatalog();
    const url = fileUrlFor(e, 'ghproxy', { asset: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip', releaseName: 'jdk-21.0.9+10' });
    expect(url).toBe('https://ghfast.top/https://github.invalid/dl/jdk-21.0.9%2B10/OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip');
  });
});

describe('模板与校验和 URL', () => {
  it('缺占位符即抛(不静默产出坏 URL)', () => {
    expect(() => renderTemplate('a/{ver}/b', {})).toThrowError(/template|无值/);
    expect(renderTemplate('v{ver}/{asset}', { ver: '1.2.3', asset: 'x.zip' })).toBe('v1.2.3/x.zip');
  });
  it('officialSidecar/shasumsFile 渲染;adoptiumApi 无 URL', () => {
    const e = nodeCatalog();
    expect(checksumUrlsFor(e, { ver: '22.20.0' })).toEqual(['https://mirrors.invalid/nodejs/v22.20.0/SHASUMS256.txt']);
  });
});

describe('缓存(TTL 24h,强刷绕过,§6)', () => {
  it('新鲜命中不发请求;过期拉新;force 绕过', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-cat-'));
    const port = new FileCachePort(path.join(dir, 'catalog_cache.json'));
    const e = nodeCatalog();
    let n = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      n++;
      return new Response(NODE_HTML, { status: 200 });
    }) as unknown as typeof fetch;
    const base = Date.UTC(2026, 8, 7, 12);
    const mk = (t: number) => () => new Date(t);

    await getVersions(e, { fetchImpl, cache: port, now: mk(base) });
    expect(n).toBe(1);
    await getVersions(e, { fetchImpl, cache: port, now: mk(base + TTL_MS - 1000) }); // 23h59m:命中缓存
    expect(n).toBe(1);
    await getVersions(e, { fetchImpl, cache: port, now: mk(base + TTL_MS + 1000) }); // 25h:过期
    expect(n).toBe(2);
    await getVersions(e, { fetchImpl, cache: port, now: mk(base + TTL_MS + 2000), force: true }); // 强刷
    expect(n).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('schema 守门', () => {
  it('缺 fileRegex / dirIndex 无 dirRegex / adoptiumApi 缺字段 → 拒绝', () => {
    expect(CatalogEntrySchema.safeParse({ id: 'x' }).success).toBe(false);
    const e = nodeCatalog();
    expect(CatalogEntrySchema.safeParse({ ...e, dirRegex: undefined }).success).toBe(false);
    const jdkish = { ...e, listKind: 'adoptiumApi', id: 'jdk2', dirRegex: undefined };
    expect(CatalogEntrySchema.safeParse(jdkish).success).toBe(false); // 无 majors/listApi/releaseFields
    expect(CatalogEntrySchema.safeParse({ ...e, listKind: 'dirIndex', unknownField: 1 }).success).toBe(false); // 禁野字段
  });
});

// 服务器夹具在 stub 下未用(保留导入以复用 startFileServer 做真实链路)
void startFileServer;
