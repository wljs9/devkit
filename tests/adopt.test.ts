/**
 * ★ F1 接管已有安装(2026-09-14)门禁:
 * 清单驱动探测(releaseFile/fileGlob/dirName/exec)+ 前置校验逐条拒 + 登记建链 + 移出登记(绝不删文件)
 * + 卸载闸(接管项只许移出登记)+ open-path 对接管项的路径收口。
 * 全部在临时目录夹具上跑,不碰真实系统;exec 探测走注入执行器,不真跑 exe。
 * 夹具里的正则刻意用 [0-9]/[.] 代替 \d/\.(等价且免转义),目录标记用 / 分隔(Windows 同样可判存在)。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogEntrySchema, type CatalogEntry } from '../src/main/core/catalog';
import { Downloader } from '../src/main/core/download';
import { HistoryLog } from '../src/main/core/history';
import {
  adoptInstall, assertAdoptableDir, forgetInstall, probeAdoptVersion, resolveOpenableInstallDir, uninstall,
} from '../src/main/core/install';
import { inspectLink } from '../src/main/core/junction';
import { currentLinkPath } from '../src/main/core/paths';
import { JsonRepository, type InstallRecord } from '../src/main/core/store';

// ---------------------------------------------------------------- 夹具

/** JDK 形:release 文件权威 → dirName → exec 兜底 */
function jdkEntry(): CatalogEntry {
  const r = CatalogEntrySchema.safeParse({
    id: 'jdk', displayName: 'Fixture JDK', listKind: 'dirIndex',
    dirRegex: '^jdk-(?<ver>[0-9]+)/$', fileRegex: '^jdk-[0-9].*[.]zip$',
    sources: [{ id: 'local', listUrl: 'https://x.invalid/', fileUrl: 'https://x.invalid/jdk-{ver}.zip' }],
    checksum: { kind: 'officialSidecar', algo: 'sha512', urls: ['https://x.invalid/s'] },
    rootDir: 'jdk-{ver}', layout: 'binSubdir',
    adopt: {
      markers: ['bin/java.exe'], exec: 'bin/java.exe', binDir: 'bin',
      version: [
        { kind: 'releaseFile', file: 'release', regex: 'JAVA_VERSION="([^"]+)"' },
        { kind: 'dirName', regex: 'jdk-?([0-9]+(?:[.][0-9]+)*)' },
        { kind: 'exec', exe: 'bin/java.exe', args: ['-version'], regex: 'version "([^"]+)"' },
      ],
    },
  });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

/** Node 形:exec(-v)在前,目录名兜底 */
function nodeEntry(): CatalogEntry {
  const r = CatalogEntrySchema.safeParse({
    id: 'node', displayName: 'Fixture Node', listKind: 'dirIndex',
    dirRegex: '^v(?<ver>[0-9]+)/$', fileRegex: '^node-[0-9].*[.]zip$',
    sources: [{ id: 'local', listUrl: 'https://x.invalid/', fileUrl: 'https://x.invalid/node-{ver}.zip' }],
    checksum: { kind: 'shasumsFile', algo: 'sha256', urls: ['https://x.invalid/SHASUMS256.txt'] },
    rootDir: 'node-v{ver}-win-x64', layout: 'binAtRoot',
    adopt: {
      markers: ['node.exe'], exec: 'node.exe',
      version: [
        { kind: 'exec', exe: 'node.exe', args: ['-v'], regex: 'v([0-9]+[.][0-9]+[.][0-9]+)' },
        { kind: 'dirName', regex: 'node-v([0-9]+[.][0-9]+[.][0-9]+)-win-x64' },
      ],
    },
  });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

/** Maven 形:fileGlob(lib/maven-core-x.y.z.jar)→ dirName 兜底 */
function mavenEntry(): CatalogEntry {
  const r = CatalogEntrySchema.safeParse({
    id: 'maven', displayName: 'Fixture Maven', listKind: 'dirIndex',
    dirRegex: '^([0-9]+[.][0-9]+[.][0-9]+)/$', fileRegex: '^apache-maven-[0-9].*[.]zip$',
    sources: [{ id: 'local', listUrl: 'https://x.invalid/', fileUrl: 'https://x.invalid/maven-{ver}.zip' }],
    checksum: { kind: 'officialSidecar', algo: 'sha512', urls: ['https://x.invalid/s'] },
    rootDir: 'apache-maven-{ver}', layout: 'binSubdir',
    adopt: {
      markers: ['bin/mvn.cmd'], exec: 'bin/mvn.cmd', binDir: 'bin',
      version: [
        { kind: 'fileGlob', dir: 'lib', pattern: '^maven-core-([0-9]+[.][0-9]+[.][0-9]+)[.]jar$' },
        { kind: 'dirName', regex: '^apache-maven-([0-9]+[.][0-9]+[.][0-9]+)' },
      ],
    },
  });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

/** 建外部目录 + 按需写文件(返回目录绝对路径) */
function mkExt(prefix: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devkit-ext-${prefix}-`));
  extDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

/** 在指定父目录下建一个【名字可控】的子目录(目录名探测要按名匹配) */
function mkNamed(parent: string, name: string, files: Record<string, string> = {}): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

const jdkInstall = (version: string): Record<string, string> => ({
  'bin/java.exe': '',
  release: `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${version}"\n`,
});

let devRoot: string;
let store: JsonRepository;
let history: HistoryLog;
let extDirs: string[];

const ctx = () => ({ devRoot, downloader: new Downloader({ devRoot }), store, history });
/** 注入执行器:不真跑 exe,按脚本回串 */
const runStub = (out: string) => () => Promise.resolve(out);

beforeEach(() => {
  devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-adopt-'));
  fs.mkdirSync(path.join(devRoot, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(devRoot, 'current'), { recursive: true });
  store = new JsonRepository(path.join(devRoot, 'devkit.json'));
  history = new HistoryLog(path.join(devRoot, 'history.jsonl'));
  extDirs = [];
});
afterEach(() => {
  for (const d of extDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(devRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 探测

describe('★ F1 版本探测链(清单驱动四型)', () => {
  it('releaseFile 命中即止(权威,零执行)', async () => {
    const dir = mkExt('jdk', jdkInstall('21.0.4'));
    const hit = await probeAdoptVersion(jdkEntry(), dir, { run: runStub('') });
    expect(hit).toEqual({ version: '21.0.4', via: 'releaseFile' });
  });

  it('无 release 文件 → dirName 兜底(jdk-21.0.4 / jdk-21)', async () => {
    const dir = mkNamed(mkExt('jdk-dirname'), 'jdk-21.0.4', { 'bin/java.exe': '' });
    expect(await probeAdoptVersion(jdkEntry(), dir, { run: runStub('') })).toEqual({ version: '21.0.4', via: 'dirName' });
    const short = mkNamed(mkExt('jdk-short'), 'jdk-21', { 'bin/java.exe': '' });
    expect((await probeAdoptVersion(jdkEntry(), short, { run: runStub('') })).version).toBe('21');
  });

  it('exec 型:node -v 的 v 前缀被归一化为裸版本号', async () => {
    const dir = mkExt('node', { 'node.exe': '' });
    const hit = await probeAdoptVersion(nodeEntry(), dir, { run: runStub('v22.17.1\n') });
    expect(hit).toEqual({ version: '22.17.1', via: 'exec' });
  });

  it('exec 抛错(超时/无权限)→ 落到下一型,不整体失败', async () => {
    const dir = mkNamed(mkExt('node-fallback'), 'node-v22.17.1-win-x64', { 'node.exe': '' });
    const hit = await probeAdoptVersion(nodeEntry(), dir, { run: () => Promise.reject(new Error('timeout')) });
    expect(hit).toEqual({ version: '22.17.1', via: 'dirName' });
  });

  it('fileGlob 型:lib/maven-core-3.9.9.jar → 3.9.9', async () => {
    const dir = mkExt('maven', { 'bin/mvn.cmd': '', 'lib/maven-core-3.9.9.jar': '', 'lib/maven-model-3.9.9.jar': '' });
    expect(await probeAdoptVersion(mavenEntry(), dir)).toEqual({ version: '3.9.9', via: 'fileGlob' });
  });

  it('全链失败 → adopt-unknown-version(附每型失败原因)', async () => {
    const dir = mkExt('nothing', { 'bin/java.exe': '' });
    await expect(probeAdoptVersion(jdkEntry(), dir, { run: runStub('no version here') })).rejects.toThrowError(/无法从该目录识别/);
  });
});

// ---------------------------------------------------------------- 前置校验

describe('★ F1 接管前置校验(逐条拒,理由可展示)', () => {
  const entry = () => jdkEntry();

  it('清单未声明 adopt → adopt-unsupported', () => {
    const bare = { ...entry(), adopt: undefined } as CatalogEntry;
    expect(() => assertAdoptableDir(bare, mkExt('bare', jdkInstall('21')))).toThrowError(/未声明/);
  });

  it('空 / 相对路径 → adopt-bad-path', () => {
    expect(() => assertAdoptableDir(entry(), '  ')).toThrowError(/不能为空/);
    expect(() => assertAdoptableDir(entry(), 'relative\\jdk')).toThrowError(/必须是绝对路径/);
  });

  it('UNC 网络路径 → adopt-unc(链接/ShellExecute 都不接受)', () => {
    expect(() => assertAdoptableDir(entry(), '\\\\server\\share\\jdk')).toThrowError(/不接受 UNC/);
  });

  it('不存在 / 不是目录 → adopt-not-dir', () => {
    expect(() => assertAdoptableDir(entry(), path.join(os.tmpdir(), 'devkit-ghost-x'))).toThrowError(/目录不存在/);
    const file = path.join(mkExt('file'), 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(() => assertAdoptableDir(entry(), file)).toThrowError(/不是目录/);
  });

  it('本身是链接/junction → adopt-is-link(防链套链)', () => {
    const real = mkExt('link-target', jdkInstall('21'));
    const link = path.join(mkExt('link-holder'), 'jdk-link');
    fs.symlinkSync(real, link, 'junction');
    expect(() => assertAdoptableDir(entry(), link)).toThrowError(/是链接/);
  });

  it('落在 DevRoot 内 → adopt-inside-devroot(自管区无需接管)', () => {
    const inside = path.join(devRoot, 'tools', 'jdk', '21.0.4');
    fs.mkdirSync(path.join(inside, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(inside, 'bin', 'java.exe'), '');
    fs.writeFileSync(path.join(inside, 'release'), 'JAVA_VERSION="21.0.4"\n');
    expect(() => assertAdoptableDir(entry(), inside, devRoot)).toThrowError(/在 DevRoot 内/);
  });

  it('缺标记文件 → adopt-not-tool(选错工具/目录)', () => {
    const dir = mkExt('not-jdk', { 'readme.txt': 'hi' });
    expect(() => assertAdoptableDir(entry(), dir)).toThrowError(/找不到 Fixture JDK 的标记文件/);
  });
});

// ---------------------------------------------------------------- 登记 / 建链 / 移出

describe('★ F1 接管登记与移出登记(不动文件)', () => {
  it('首版接管:登记 origin=adopt、自动 current(链指向外部目录)、历史记账', async () => {
    const dir = mkExt('jdk-first', jdkInstall('21.0.4'));
    const rec = await adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') });
    expect(rec.origin).toBe('adopt');
    expect(rec.sourceId).toBe('local');
    expect(rec.version).toBe('21.0.4');
    expect(rec.isCurrent).toBe(true);
    const link = inspectLink(currentLinkPath(devRoot, 'jdk'));
    expect(link.isLink).toBe(true);
    expect(link.realTarget?.toLowerCase()).toBe(fs.realpathSync(dir).toLowerCase());
    expect(store.load().installs).toHaveLength(1);
    expect(history.list()[0]!.kind).toBe('adopt');
    expect(fs.existsSync(path.join(dir, 'release'))).toBe(true); // 只登记,不动文件
  });

  it('已有其他版本时接管 → isCurrent=false,current 链不被改写', async () => {
    const older = mkExt('jdk-old', jdkInstall('17.0.9'));
    await adoptInstall(jdkEntry(), older, ctx(), { run: runStub('') });
    const newer = mkExt('jdk-new', jdkInstall('21.0.4'));
    const rec = await adoptInstall(jdkEntry(), newer, ctx(), { run: runStub('') });
    expect(rec.isCurrent).toBe(false);
    const link = inspectLink(currentLinkPath(devRoot, 'jdk'));
    expect(link.realTarget?.toLowerCase()).toBe(fs.realpathSync(older).toLowerCase());
  });

  it('同工具同版本重复接管 → already-installed;同路径已登记 → adopt-path-taken', async () => {
    const dir = mkExt('jdk-dup', jdkInstall('21.0.4'));
    await adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') });
    await expect(adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') })).rejects.toThrowError(/已在登记表中/);

    // 同路径换一个版本标签(投毒登记表:路径撞车但版本不同)→ adopt-path-taken
    const rec: InstallRecord = {
      id: 'jdk-x', tool: 'jdk', version: '9.9.9', path: fs.realpathSync(dir), sourceId: 'local',
      sourceUrl: dir, sha256: '', size: 0, installedAt: new Date().toISOString(), isCurrent: false, origin: 'adopt',
    };
    store.update((d) => ({ ...d, installs: [rec] }));
    await expect(adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') })).rejects.toThrowError(/已登记为 jdk/);
  });

  it('卸载闸:接管项不给删除入口 → adopt-unregister-only,且外部目录毫发无损', async () => {
    const dir = mkExt('jdk-noinst', jdkInstall('21.0.4'));
    await adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') });
    await expect(uninstall(jdkEntry(), '21.0.4', ctx())).rejects.toThrowError(/请用「移出登记」/);
    expect(fs.existsSync(path.join(dir, 'release'))).toBe(true);
    expect(store.load().installs).toHaveLength(1); // 登记仍在
  });

  it('移出登记:删记录 + 断 current 链 + 目录文件原样;下载装的版本拒走此口', async () => {
    const dir = mkExt('jdk-forget', jdkInstall('21.0.4'));
    await adoptInstall(jdkEntry(), dir, ctx(), { run: runStub('') });
    await forgetInstall(jdkEntry(), '21.0.4', ctx());
    expect(store.load().installs).toHaveLength(0);
    expect(inspectLink(currentLinkPath(devRoot, 'jdk')).exists).toBe(false); // 链已断
    expect(fs.readFileSync(path.join(dir, 'release'), 'utf8')).toContain('21.0.4'); // 文件仍在

    const downloaded: InstallRecord = {
      id: 'jdk-3.9.9', tool: 'jdk', version: '3.9.9', path: path.join(devRoot, 'tools', 'jdk', '3.9.9'),
      sourceId: 'local', sourceUrl: 'u', sha256: 'h', size: 1, installedAt: new Date().toISOString(), isCurrent: false,
    };
    store.update((d) => ({ ...d, installs: [downloaded] }));
    await expect(forgetInstall(jdkEntry(), '3.9.9', ctx())).rejects.toThrowError(/请用「卸载」/);
  });

  it('历史把失败也记下来(ok:false),便于排查选错目录', async () => {
    await expect(adoptInstall(jdkEntry(), mkExt('bad', { 'readme.txt': 'x' }), ctx(), { run: runStub('') })).rejects.toThrow();
    const h = history.list()[0]!;
    expect(h.kind).toBe('adopt');
    expect(h.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- open-path 收口(F1 扩展)

describe('★ F1 open-path 对接管项的路径收口(S2 语义不变)', () => {
  const recOf = (id: string, p: string, origin?: 'adopt'): InstallRecord => ({
    id, tool: 'jdk', version: '1', path: p, sourceId: 'local', sourceUrl: p, sha256: '', size: 0,
    installedAt: 't', isCurrent: false, ...(origin ? { origin } : {}),
  });

  it('接管项在 DevRoot 之外 → 放行(路径仍出自主进程登记表)', () => {
    const dir = mkExt('open-adopt', jdkInstall('21'));
    expect(resolveOpenableInstallDir(devRoot, [recOf('a', dir, 'adopt')], 'a')).toBe(fs.realpathSync(dir));
  });

  it('接管项的登记路径若为 UNC → 拒绝(防 ShellExecute 触 SMB)', () => {
    expect(() => resolveOpenableInstallDir(devRoot, [recOf('u', '\\\\server\\share', 'adopt')], 'u')).toThrowError(/不是本机绝对路径/);
  });

  it('下载安装的登记项仍守 DevRoot 前缀闸(origin 缺省 = download)', () => {
    const outside = mkExt('open-download', jdkInstall('21'));
    expect(() => resolveOpenableInstallDir(devRoot, [recOf('d', outside)], 'd')).toThrowError(/不在 DevRoot 内/);
  });
});