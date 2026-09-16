import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyCatalogPrefs,
  CatalogEntrySchema,
  FileCachePort,
  checksumUrlsFor,
  fileUrlFor,
  getVersions,
  listVersions,
  loadCatalogDir,
  naturalCompare,
  preferByPriority,
  renderTemplate,
  TTL_MS,
} from '../src/main/core/catalog';
import { startFileServer, stubResponses } from './helpers/server';

// ---- 真实仓库 catalog:加载即门禁(M1 测试不许绕过实测定稿文件) ----
describe('catalog/ 定稿文件(§6)', () => {
  it('九份清单(jdk/node/maven + F4 六个)全部通过 zod 校验', () => {
    const dir = url.fileURLToPath(new URL('../catalog', import.meta.url)); // tests/ 上一级即仓库根
    const entries = loadCatalogDir(dir);
    expect(entries.map((e) => e.id).sort()).toEqual(['dbeaver', 'git', 'idea', 'jdk', 'maven', 'node', 'pycharm', 'python', 'vscode']);
  });
  it('S1 定稿门禁:Node 校验源首位必须是官方 nodejs.org(与默认下载源跨域,镜像 sidecar 只兜底)', () => {
    const dir = url.fileURLToPath(new URL('../catalog', import.meta.url));
    const node = loadCatalogDir(dir).find((e) => e.id === 'node')!;
    const first = new URL(node.checksum.urls![0]!);
    expect(first.hostname).toBe('nodejs.org');
    // 其余条目允许镜像,但不得再出现"官方与镜像序位颠倒"的回退
    expect(node.checksum.urls!.map((u) => new URL(u).hostname)).toEqual([
      'nodejs.org',
      'mirrors.huaweicloud.com',
      'mirrors.tuna.tsinghua.edu.cn',
    ]);
  });
  it('★ F4 定稿门禁:pinnedHash 校验的工具,pinned 表非空且哈希为 64hex(F4 六工具真测哈希已回填)', () => {
    const dir = url.fileURLToPath(new URL('../catalog', import.meta.url));
    const pinnedTools = loadCatalogDir(dir).filter((e) => e.checksum.kind === 'pinnedHash');
    expect(pinnedTools.map((e) => e.id).sort()).toEqual(['dbeaver', 'git', 'python', 'vscode']);
    for (const e of pinnedTools) {
      expect(Object.keys(e.checksum.pinned ?? {}).length, `${e.id} 的 pinned 表为空(需先跑 scripts/f4-e2e.mts --pin 回填真哈希)`).toBeGreaterThan(0);
      for (const [ver, p] of Object.entries(e.checksum.pinned ?? {})) {
        expect(p.hex, `${e.id} ${ver} 哈希应为 64 位 hex`).toMatch(/^[0-9a-f]{64}$/);
        expect(ver.length, `${e.id} 版本键异常:${ver}`).toBeGreaterThan(0);
      }
    }
  });
  it('★ F1 定稿门禁:三份清单都声明了 adopt(接管已有安装),且探测链非空、标记非空', () => {
    const dir = url.fileURLToPath(new URL('../catalog', import.meta.url));
    for (const e of loadCatalogDir(dir)) {
      expect(e.adopt, `${e.id} 缺 adopt 段(添加已有安装会不可用)`).toBeDefined();
      expect(e.adopt!.markers.length, `${e.id} 的 markers 为空`).toBeGreaterThan(0);
      expect(e.adopt!.version.length, `${e.id} 的 version 探测链为空`).toBeGreaterThan(0);
    }
    // 各工具的"身份标记"必须能对上真实发行版布局(jdk=bin\java.exe / node=node.exe / maven=bin\mvn.cmd)
    const byId = new Map(loadCatalogDir(dir).map((e) => [e.id, e]));
    expect(byId.get('jdk')!.adopt!.markers).toContain('bin\\java.exe');
    expect(byId.get('node')!.adopt!.markers).toContain('node.exe');
    expect(byId.get('maven')!.adopt!.markers).toContain('bin\\mvn.cmd');
    // 每种探测型都至少被用上一次(releaseFile/fileGlob/dirName/exec 四型都得有消费者)
    const kinds = new Set(loadCatalogDir(dir).flatMap((e) => e.adopt!.version.map((v) => v.kind)));
    expect([...kinds].sort()).toEqual(['dirName', 'exec', 'fileGlob', 'releaseFile']);
  });
  it('★ F1:schema 对 adopt 段的守门(未知探测型/空链 → 拒)', () => {
    expect(CatalogEntrySchema.safeParse({ ...nodeCatalog(), adopt: { markers: ['node.exe'], version: [{ kind: 'nope', regex: 'x' }] } }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...nodeCatalog(), adopt: { markers: [], version: [{ kind: 'dirName', regex: 'x' }] } }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...nodeCatalog(), adopt: { markers: ['node.exe'], version: [] } }).success).toBe(false);
    // 正路:合法 adopt 段被接受
    expect(CatalogEntrySchema.safeParse({ ...nodeCatalog(), adopt: { markers: ['node.exe'], version: [{ kind: 'dirName', regex: 'node-v([0-9.]+)' }] } }).success).toBe(true);
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
  it('versionPolicy.exclude:显式排除占位版(python 3.15 被 α 占用场景)', async () => {
    const { fn } = await stubResponses({ 'https://mirrors.invalid/nodejs/': NODE_HTML });
    const e = nodeCatalog({ versionPolicy: { exclude: ['24.1.0'] } });
    const vs = await listVersions(e, { fetchImpl: fn });
    expect(vs.map((v) => v.version)).toEqual(['22.20.0', '9.6.0']);
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

describe('applyCatalogPrefs / preferByPriority(§4.6 设置覆盖,M3)', () => {
  // jdk 式三源:latestOnly(USTC)+ 两全量源(其一带代理前缀)
  function jdkishCatalog() {
    const raw: unknown = {
      id: 'jdk', displayName: 'JDK', listKind: 'adoptiumApi', majors: [21],
      listApi: 'https://api.adoptium.invalid/x/{major}',
      releaseFields: { releaseName: 'r', semver: 's', build: 'b', packageLink: 'p', packageChecksum: 'c', packageSize: 'z' },
      fileRegex: '^x\\.zip$',
      sources: [
        { id: 'ustc-latest', scope: 'latestOnly', fileUrl: 'https://ustc.invalid/{asset}' },
        { id: 'ghproxy', scope: 'all', fileUrl: 'https://github.invalid/{asset}', proxy: { kind: 'prefix', value: 'https://ghfast.top/' } },
        { id: 'github-direct', scope: 'all', fileUrl: 'https://github.invalid/{asset}' },
      ],
      checksum: { kind: 'adoptiumApi', algo: 'sha256' },
      rootDir: '{releaseName}', layout: 'binSubdir',
    };
    const r = CatalogEntrySchema.safeParse(raw);
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  }

  it('优先级:列出的按序排前,未列出的保持原相对次序', () => {
    const out = applyCatalogPrefs(jdkishCatalog(), { priority: ['github-direct'] });
    expect(out.sources.map((s) => s.id)).toEqual(['github-direct', 'ustc-latest', 'ghproxy']);
    expect(applyCatalogPrefs(jdkishCatalog(), {}).sources.map((s) => s.id)).toEqual(['ustc-latest', 'ghproxy', 'github-direct']);
    expect(applyCatalogPrefs(jdkishCatalog(), { priority: ['nope', 'ghproxy'] }).sources.map((s) => s.id)).toEqual(['ghproxy', 'ustc-latest', 'github-direct']); // 未知 id 忽略
  });
  it('代理前缀覆盖:换前缀 / 空串去代理直连;不改原对象(单例共享)', () => {
    const e = jdkishCatalog();
    const out = applyCatalogPrefs(e, { proxyPrefixes: { ghproxy: 'https://my.proxy/' } });
    expect(out.sources.find((s) => s.id === 'ghproxy')!.proxy?.value).toBe('https://my.proxy/');
    const off = applyCatalogPrefs(e, { proxyPrefixes: { ghproxy: '' } });
    expect(off.sources.find((s) => s.id === 'ghproxy')!.proxy).toBeUndefined();
    expect(e.sources.find((s) => s.id === 'ghproxy')!.proxy!.value).toBe('https://ghfast.top/'); // 原件未动
    // 覆盖真生效:fileUrlFor 用新前缀拼 URL
    expect(fileUrlFor(out, 'ghproxy', { asset: 'a.zip' })).toBe('https://my.proxy/https://github.invalid/a.zip');
  });
  it('preferByPriority:按序取首个覆盖源;latestOnly 只管"该 major 最新"', () => {
    const srcs = jdkishCatalog().sources;
    const top = { tool: 'jdk', version: '21.0.9', asset: 'a.zip', preferredSourceId: 'ustc-latest' };
    const old = { tool: 'jdk', version: '21.0.4', asset: 'b.zip', preferredSourceId: 'ghproxy' };
    expect(preferByPriority(top, srcs)).toBe('ustc-latest');
    expect(preferByPriority(old, srcs)).toBe('ghproxy'); // 非最新 → 跳过 latestOnly
    // 用户把 ghproxy 提到最前:两版都首选 ghproxy
    expect(preferByPriority(top, [srcs[1]!, srcs[0]!, srcs[2]!])).toBe('ghproxy');
    // 全 latestOnly 且非最新 → 兜底回原 preferredSourceId
    expect(preferByPriority(old, [srcs[0]!])).toBe('ghproxy');
  });
});

/** ★ F4(2026-09-16):naturalCompare / rawVersion / aliases / maxVersions / jsonApi / latestRedirect / pinned 闸 */
describe('F4 泛化:自然序 / rawVersion / aliases / maxVersions', () => {
  it('naturalCompare:数字段按数值比较(非字典序),字母段按字典', () => {
    expect(naturalCompare('2.55.0.windows.2', '2.55.0.windows.10')).toBeLessThan(0);
    expect(naturalCompare('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(naturalCompare('2025.3', '2025.2.6.3')).toBeGreaterThan(0);
    expect(naturalCompare('a2', 'a1')).toBeGreaterThan(0);
    expect(naturalCompare('2.55.0.windows.5', '2.55.0.windows.5')).toBe(0);
  });

  const GIT_HTML = [
    '<a href="../">up</a>',
    '<a href="Git%20for%20Windows%20v2.55.0.windows.5/">v2.55.0.windows.5</a>',
    '<a href="Git%20for%20Windows%20v2.47.0.windows.1/">v2.47.0.windows.1</a>',
    '<a href="Git%20for%20Windows%20v2.39.2.windows.11/">v2.39.2.windows.11</a>',
    '<a href="other/">other</a>',
  ].join('\n');

  function gitCatalog() {
    const r = CatalogEntrySchema.safeParse({
      id: 'git', displayName: 'Git', listKind: 'dirIndex', rawVersion: true, maxVersions: 2,
      dirRegex: '^Git(?:%20| )for(?:%20| )Windows(?:%20| )v(?<ver>\\d+\\.\\d+\\.\\d+\\.windows\\.\\d+)/$',
      fileRegex: '^MinGit-(?<ver>[\\d.]+)-64-bit\\.zip$',
      aliases: [{ name: 'gitver', from: '.windows.', to: '.' }],
      sources: [{ id: 'ustc', listUrl: 'https://ustc.git.invalid/', fileUrl: 'https://ustc.git.invalid/{href}/MinGit-{gitver}-64-bit.zip' }],
      checksum: { kind: 'pinnedHash', algo: 'sha256', pinned: {} },
      rootDir: 'mingit-{gitver}-64-bit', layout: 'binSubdir', binName: 'cmd',
    });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  }

  it('rawVersion 原文保留 + 自然降序(windows.11 > windows.2)+ maxVersions 截断 + href/别名进资产名', async () => {
    const { fn } = await stubResponses({ 'https://ustc.git.invalid/': GIT_HTML });
    const vs = await listVersions(gitCatalog(), { fetchImpl: fn });
    expect(vs.map((v) => v.version)).toEqual(['2.55.0.windows.5', '2.47.0.windows.1']); // 只留最新 2 个,原文非 semver
    expect(vs[0]!.asset).toBe('MinGit-2.55.0.5-64-bit.zip'); // 别名 .windows. → .
    expect(vs[0]!.extra?.href).toBe('Git%20for%20Windows%20v2.55.0.windows.5');
  });
});

describe('F4 jsonApi / latestRedirect', () => {
  function jetbrainsCatalog(code: string) {
    const r = CatalogEntrySchema.safeParse({
      id: 'idea', displayName: 'IntelliJ IDEA', listKind: 'jsonApi', listApi: `https://api.jb.invalid/releases?code=${code}`,
      listScan: {
        shape: 'map', root: 'IIC', versionPath: 'version',
        assetPath: 'downloads.windowsZip.link', checksumPath: 'downloads.windowsZip.checksumLink', sizePath: 'downloads.windowsZip.size',
      },
      rawVersion: true, maxVersions: 5,
      fileRegex: '^ideaIC-(?<ver>[\\w.]+)\\.win\\.zip$',
      sources: [{ id: 'official', fileUrl: '{asset}' }],
      checksum: { kind: 'discoveredSidecar', algo: 'sha256' },
      rootDir: 'idea-{ver}', layout: 'binSubdir',
    });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  }

  it('jsonApi map(JetBrains):点路径取版本/资产/校验/体积;无 windowsZip 跳过;raw 自然降序', async () => {
    const body = JSON.stringify({
      IIC: [
        { version: '2025.2.6.3', build: '252', downloads: { windowsZip: { link: 'https://dl.jb.invalid/ideaIC-2025.2.6.3.win.zip', checksumLink: 'https://dl.jb.invalid/ideaIC-2025.2.6.3.win.zip.sha256', size: 123 } } },
        { version: '2025.3', build: '253', downloads: { windowsZip: { link: 'https://dl.jb.invalid/ideaIC-2025.3.win.zip', checksumLink: 'https://dl.jb.invalid/ideaIC-2025.3.win.zip.sha256', size: 456 } } },
        { version: '2024.1', downloads: { windows: { link: 'https://dl.jb.invalid/x.exe' } } }, // 无 windowsZip → 跳过
      ],
    });
    const { fn } = await stubResponses({ 'https://api.jb.invalid/releases?code=IIC': body });
    const vs = await listVersions(jetbrainsCatalog('IIC'), { fetchImpl: fn });
    expect(vs.map((v) => v.version)).toEqual(['2025.3', '2025.2.6.3']);
    expect(vs[0]!.asset).toBe('https://dl.jb.invalid/ideaIC-2025.3.win.zip');
    expect(vs[0]!.checksumUrl).toBe('https://dl.jb.invalid/ideaIC-2025.3.win.zip.sha256');
    expect(vs[0]!.size).toBe(456);
  });

  it('jsonApi flat:平数组版本串,自然降序', async () => {
    const r = CatalogEntrySchema.safeParse({
      id: 'vsx', displayName: 'VS', listKind: 'jsonApi', listApi: 'https://api.flat.invalid/vs', listScan: { shape: 'flat' },
      fileRegex: '^code-stable-x64-(?<ver>[\\d.]+)\\.zip$',
      sources: [{ id: 'official', fileUrl: 'https://cdn.invalid/{asset}' }],
      checksum: { kind: 'pinnedHash', algo: 'sha256', pinned: {} },
      rootDir: 'VSCode-win32-x64', layout: 'binAtRoot',
    });
    if (!r.success) throw new Error(r.error.message);
    const { fn } = await stubResponses({ 'https://api.flat.invalid/vs': JSON.stringify(['1.96.2', '9.5.3', 'abc']) });
    const vs = await listVersions(r.data, { fetchImpl: fn });
    expect(vs.map((v) => v.version)).toEqual(['9.5.3', '1.96.2']);
  });

  it('latestRedirect:跟转发,从终URL文件名提取版本;源不可达 → catalog-fetch', async () => {
    const r = CatalogEntrySchema.safeParse({
      id: 'vscode', displayName: 'VS Code', listKind: 'latestRedirect',
      fileRegex: '^VSCode-win32-x64-(?<ver>\\d+\\.\\d+\\.\\d+)\\.zip$',
      sources: [{ id: 'official', listUrl: 'https://update.vscode.invalid/latest/stable', fileUrl: 'https://update.vscode.invalid/latest/stable' }],
      checksum: { kind: 'pinnedHash', algo: 'sha256', pinned: {} },
      rootDir: 'VSCode-win32-x64', layout: 'binAtRoot',
    });
    if (!r.success) throw new Error(r.error.message);
    const fn = (async () => {
      const res: Response = { ok: true, status: 200, url: 'https://cdn.vscode.invalid/download/stable/abc123/VSCode-win32-x64-1.138.0.zip' } as unknown as Response;
      return res;
    }) as unknown as typeof fetch;
    const vs = await listVersions(r.data, { fetchImpl: fn });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.version).toBe('1.138.0');
    expect(vs[0]!.asset).toBe('VSCode-win32-x64-1.138.0.zip');
    // 终URL不是目标文件名 → 无法识别版本
    const badFn = (async () => ({ ok: true, status: 200, url: 'https://cdn.vscode.invalid/error-page' })) as unknown as typeof fetch;
    await expect(listVersions(r.data, { fetchImpl: badFn })).rejects.toThrowError(/无法识别版本/);
  });
});

describe('F4 schema 守门', () => {
  it('jsonApi 缺 listScan / latestRedirect 缺 listUrl / pinned 哈希非法 / listScan 形状未知 → 拒绝;合法组合通过', () => {
    const e = nodeCatalog();
    expect(CatalogEntrySchema.safeParse({ ...e, listKind: 'jsonApi', listApi: 'https://x/y', listScan: undefined, dirRegex: undefined }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...e, listKind: 'latestRedirect', dirRegex: undefined, sources: [{ id: 'o', fileUrl: 'x' }] }).success).toBe(false); // listUrl 缺失
    expect(CatalogEntrySchema.safeParse({ ...e, listScan: { shape: 'nope' } }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...e, checksum: { kind: 'pinnedHash', algo: 'sha256', pinned: { '1.0.0': { algo: 'sha256', hex: 'zzz' } } } }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...e, checksum: { kind: 'pinnedHash', algo: 'sha256', pinned: { '1.0.0': { algo: 'sha256', hex: 'a'.repeat(64) } } } }).success).toBe(true);
    expect(CatalogEntrySchema.safeParse({ ...e, layout: 'binSubdir', binName: 'cmd' }).success).toBe(true);
  });
});

// 服务器夹具在 stub 下未用(保留导入以复用 startFileServer 做真实链路)
void startFileServer;
