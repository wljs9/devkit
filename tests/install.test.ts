/**
 * 安装链路端到端(§11 第 3 行):"下载→校验→解压→建链→读回"全绿才算 M1 完成。
 * DevRoot fixture 建在系统临时目录;假包(合法 store-only zip)挂本地 http server。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogEntrySchema, type CatalogEntry, type DiscoveredVersion } from '../src/main/core/catalog';
import { Downloader } from '../src/main/core/download';
import { HistoryLog } from '../src/main/core/history';
import { removeJunction } from '../src/main/core/junction';
import { ensureDevRoot, install, orderChecksumUrls, setCurrent, uninstall } from '../src/main/core/install';
import { currentLinkPath, toolVersionDir } from '../src/main/core/paths';
import { JsonRepository } from '../src/main/core/store';
import { makeZip } from './helpers/mkzip';
import { startFileServer, type TestServer } from './helpers/server';

const PKG = 'node';
const V1 = '3.9.9';
const V2 = '3.9.8';

function zipFor(version: string): Buffer {
  return makeZip([
    { name: `${PKG}-${version}/bin/${PKG}.exe`, data: Buffer.from(`${PKG} v${version}\n`) },
    { name: `${PKG}-${version}/marker.txt`, data: Buffer.from(`content-${version}`) },
  ]);
}

function mkEntry(base: string): CatalogEntry {
  const r = CatalogEntrySchema.safeParse({
    id: PKG, displayName: 'Fixture ' + PKG, listKind: 'dirIndex',
    dirRegex: '^node-(?<ver>\\d+\\.\\d+\\.\\d+)/$', fileRegex: '^pkg-\\d.*\\.zip$',
    sources: [{ id: 'local', listUrl: `${base}/`, fileUrl: `${base}/pkg-{ver}.zip` }],
    checksum: { kind: 'officialSidecar', algo: 'sha512', urls: [`${base}/sha512/{ver}`] },
    rootDir: `${PKG}-{ver}`, layout: 'binAtRoot',
  });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

const verOf = (version: string): DiscoveredVersion => ({
  tool: PKG, version, dir: version, asset: `pkg-${version}.zip`, preferredSourceId: 'local',
});

let devRoot: string;
let store: JsonRepository;
let history: HistoryLog;
let dl: Downloader;
let servers: TestServer[];
/** url → sidecar 内容(fetchText 桩路由) */
let sidecars: Record<string, string>;

const ctx = (entry: CatalogEntry) => ({
  devRoot,
  downloader: dl,
  store,
  history,
  entry,
  fetchText: async (u: string) => {
    const key = Object.keys(sidecars).find((k) => u.endsWith(k));
    if (!key) throw new Error('sidecar 404: ' + u);
    return sidecars[key]!;
  },
});

/**
 * shasumsFile + lineMatch 专用夹具(Node 的真实校验形态;此前 §11 覆盖盲区)。
 * 校验文件行 = `<sha256hex>␣␣pkg-<ver>.zip`(两空格,与 nodejs.org SHASUMS256.txt 一致)。
 */
function mkShasumsEntry(base: string): CatalogEntry {
  const r = CatalogEntrySchema.safeParse({
    id: PKG, displayName: 'Fixture ' + PKG, listKind: 'dirIndex',
    dirRegex: '^node-(?<ver>\\d+\\.\\d+\\.\\d+)/$', fileRegex: '^pkg-\\d.*\\.zip$',
    sources: [{ id: 'local', listUrl: `${base}/`, fileUrl: `${base}/pkg-{ver}.zip` }],
    checksum: { kind: 'shasumsFile', algo: 'sha256', urls: [`${base}/SHASUMS256.txt`], lineMatch: '  pkg-{ver}.zip$' },
    rootDir: `${PKG}-{ver}`, layout: 'binAtRoot',
  });
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

async function addServer(version: string): Promise<CatalogEntry> {
  const buf = zipFor(version);
  const srv = await startFileServer(buf, `pkg-${version}.zip`);
  servers.push(srv);
  sidecars[`${version}`] = createHash('sha512').update(buf).digest('hex');
  return mkEntry(srv.url);
}

beforeEach(async () => {
  devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-inst-'));
  ensureDevRoot(devRoot);
  store = new JsonRepository(path.join(devRoot, 'devkit.json'));
  history = new HistoryLog(path.join(devRoot, 'history.jsonl'));
  dl = new Downloader({ devRoot });
  servers = [];
  sidecars = {};
});
afterEach(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(devRoot, { recursive: true, force: true });
});

const markerViaCurrent = () => fs.readFileSync(path.join(currentLinkPath(devRoot, PKG), 'marker.txt'), 'utf8');

describe('安装全链路:下载→校验→解压→建链→读回(§11)', () => {
  it('首装自动 current,junction 读回真实文件,登记/历史齐,cache 无残留', async () => {
    const entry = await addServer(V1);
    const rec = await install(entry, verOf(V1), {}, ctx(entry));
    const real = toolVersionDir(devRoot, PKG, V1);
    expect(fs.readFileSync(path.join(real, 'bin', `${PKG}.exe`), 'utf8')).toContain(`v${V1}`);
    expect(markerViaCurrent()).toBe(`content-${V1}`); // 穿透 junction 读回
    const st = store.load();
    expect(st.installs).toHaveLength(1);
    expect(st.installs[0]).toMatchObject({ tool: PKG, version: V1, isCurrent: true, sha256: rec.sha256, sourceId: 'local' });
    expect(history.list()[0]).toMatchObject({ kind: 'install', ok: true });
    expect(fs.readdirSync(path.join(devRoot, 'cache'))).toEqual([]); // part/临时区全部消费清理
  });

  it('同版本重复安装 → already-installed,磁盘不动', async () => {
    const entry = await addServer(V1);
    await install(entry, verOf(V1), {}, ctx(entry));
    await expect(install(entry, verOf(V1), {}, ctx(entry))).rejects.toThrowError(/已安装/);
    expect(store.load().installs).toHaveLength(1);
  });

  it('校验和不匹配 → 拒绝安装,登记不写,cache 清理,历史记败(§3.5/§7.5)', async () => {
    const entry = await addServer(V1);
    sidecars[V1] = 'f'.repeat(128); // 篡改期望值
    await expect(install(entry, verOf(V1), {}, ctx(entry))).rejects.toThrowError(/校验和不匹配/);
    expect(store.load().installs).toEqual([]);
    expect(fs.existsSync(toolVersionDir(devRoot, PKG, V1))).toBe(false);
    expect(fs.readdirSync(path.join(devRoot, 'cache'))).toEqual([]);
    expect(history.list()[0]).toMatchObject({ kind: 'install', ok: false });
  });

  it('取不到校验和 → checksum-unreachable(宁可不装,§3.5)', async () => {
    const entry = await addServer(V1);
    sidecars = {};
    await expect(install(entry, verOf(V1), {}, ctx(entry))).rejects.toThrowError(/取不到.*校验和/);
  });

  it('多版本并存与秒级切换:setCurrent 重建 junction,PATH 零参与', async () => {
    const e1 = await addServer(V1);
    await install(e1, verOf(V1), {}, ctx(e1));
    const e2 = await addServer(V2);
    const rec2 = await install(e2, verOf(V2), {}, ctx(e2));
    expect(rec2.isCurrent).toBe(false); // 已有 current,不抢占

    await setCurrent(e2, V2, ctx(e2));
    expect(markerViaCurrent()).toBe(`content-${V2}`);
    const flags = () => Object.fromEntries(store.load().installs.map((i) => [i.version, i.isCurrent]));
    expect(flags()).toEqual({ [V1]: false, [V2]: true });

    await setCurrent(e1, V1, ctx(e1));
    expect(markerViaCurrent()).toBe(`content-${V1}`);
    expect(history.list({ kind: 'switch' })).toHaveLength(2);
    // 旧目标文件毫发无损(两版并存)
    expect(fs.existsSync(toolVersionDir(devRoot, PKG, V2))).toBe(true);
  });

  it('切换不存在的版本 → not-installed;目录丢失 → path-missing', async () => {
    const entry = await addServer(V1);
    await expect(setCurrent(entry, V2, ctx(entry))).rejects.toThrowError(/未安装/);
    await install(entry, verOf(V1), {}, ctx(entry));
    fs.rmSync(toolVersionDir(devRoot, PKG, V1), { recursive: true });
    await expect(setCurrent(entry, V1, ctx(entry))).rejects.toThrowError(/目录已丢失/);
  });

  it('卸载:当前版拒绝;非当前版删文件+登记,current 链无恙', async () => {
    const e1 = await addServer(V1);
    await install(e1, verOf(V1), {}, ctx(e1));
    const e2 = await addServer(V2);
    await install(e2, verOf(V2), {}, ctx(e2));
    await setCurrent(e1, V1, ctx(e1)); // current = 3.9.9

    await expect(uninstall(e1, V1, ctx(e1))).rejects.toThrowError(/不能卸载当前生效版本/);
    await uninstall(e2, V2, ctx(e2));
    expect(fs.existsSync(toolVersionDir(devRoot, PKG, V2))).toBe(false);
    expect(store.load().installs.map((i) => i.version)).toEqual([V1]);
    expect(markerViaCurrent()).toBe(`content-${V1}`);
    expect(history.list({ kind: 'uninstall' })).toHaveLength(1);
  });

  it('Node 式校验(shasumsFile+lineMatch):真实两空格行必须能取到校验和并完成安装(§7.6 M2 回归)', async () => {
    const buf = zipFor(V1);
    const srv = await startFileServer(buf, `pkg-${V1}.zip`);
    servers.push(srv);
    const entry = mkShasumsEntry(srv.url);
    // 真实 nodejs.org SHASUMS256.txt 行格式:64位hex + 恰好两个空格 + 文件名(前后各留噪行)
    sidecars['SHASUMS256.txt'] = [
      'deadbeef'.repeat(8) + '  pkg-0.0.0.tar.gz',
      createHash('sha256').update(buf).digest('hex') + '  pkg-' + V1 + '.zip',
    ].join('\n');
    const rec = await install(entry, verOf(V1), {}, ctx(entry));
    expect(markerViaCurrent()).toBe(`content-${V1}`);
    expect(rec.sha256).toEqual(createHash('sha256').update(buf).digest('hex'));
  });

  it('shasumsFile:两空格行里的期望哈希与包不符 → 校验和不匹配(拒绝安装,红线§3.5)', async () => {
    const buf = zipFor(V1);
    const srv = await startFileServer(buf, `pkg-${V1}.zip`);
    servers.push(srv);
    const entry = mkShasumsEntry(srv.url);
    sidecars['SHASUMS256.txt'] = 'ab'.repeat(32) + '  pkg-' + V1 + '.zip';
    await expect(install(entry, verOf(V1), {}, ctx(entry))).rejects.toThrowError(/校验和不匹配/);
  });

  it('代理前缀源:下载必须真正带前缀请求(M3 JDK ghproxy 接线回归 —— 曾因绕过 fileUrlFor 而直连)', async () => {
    const buf = zipFor(V1);
    const srv = await startFileServer(buf, `pkg-${V1}.zip`);
    servers.push(srv);
    sidecars[V1] = createHash('sha512').update(buf).digest('hex');
    const parsed = CatalogEntrySchema.safeParse({
      id: PKG, displayName: 'fx', listKind: 'dirIndex',
      dirRegex: '^node-(?<ver>\\d+\\.\\d+\\.\\d+)/$', fileRegex: '^pkg-\\d.*\\.zip$',
      sources: [{ id: 'gh', listUrl: `${srv.url}/`, fileUrl: `${srv.url}/pkg-{ver}.zip`, proxy: { kind: 'prefix', value: `${srv.url}/wrap/` } }],
      checksum: { kind: 'officialSidecar', algo: 'sha512', urls: [`${srv.url}/sha512/{ver}`] },
      rootDir: `${PKG}-{ver}`, layout: 'binAtRoot',
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    const entry = parsed.data;
    const rec = await install(entry, { ...verOf(V1), preferredSourceId: 'gh' }, {}, ctx(entry));
    expect(srv.requests.some((r) => r.path.startsWith('/wrap/'))).toBe(true); // 实际 HTTP 请求经过代理前缀
    expect(rec.sourceUrl).toContain('/wrap/'); // 登记的下载 URL = 真请求 URL
    expect(markerViaCurrent()).toBe(`content-${V1}`);
  });

  it('卸载红线:版本路径若被换成 junction,第一道闸必须拦住递归删除(§7.3)', async () => {
    const entry = await addServer(V1);
    await install(entry, verOf(V1), {}, ctx(entry));
    const real = toolVersionDir(devRoot, PKG, V1);
    removeJunction(currentLinkPath(devRoot, PKG)); // 断 current 链
    fs.renameSync(real, `${real}-moved`);
    fs.symlinkSync(`${real}-moved`, real, 'junction'); // 事故现场:版本目录名被 junction 占据
    await expect(uninstall(entry, V1, ctx(entry))).rejects.toThrowError(/是链接而非真实目录|拒绝/);
    expect(fs.existsSync(path.join(`${real}-moved`, 'marker.txt'))).toBe(true); // 数据毫发无损
    expect(store.load().installs).toHaveLength(1); // 未登记删除
  });
});

/** S1(2026-09-09 安全审查):校验源与下载源跨域优先,同主机投毒不能自证清白 */
describe('S1 校验和跨域背书', () => {
  it('orderChecksumUrls:同主机的 sidecar 沉底,组内保序;坏/相对 URL 按跨域处理', () => {
    const urls = ['http://a.invalid/x1', 'http://b.invalid/y', 'http://a.invalid/x2', 'relative/sums.txt'];
    expect(orderChecksumUrls(urls, 'http://a.invalid/pkg.zip')).toEqual([
      'http://b.invalid/y',
      'relative/sums.txt',
      'http://a.invalid/x1',
      'http://a.invalid/x2',
    ]);
  });

  function s1Entry(base: string, urls: string[]): CatalogEntry {
    const r = CatalogEntrySchema.safeParse({
      id: PKG, displayName: 'fx', listKind: 'dirIndex',
      dirRegex: '^node-(?<ver>\\d+\\.\\d+\\.\\d+)/$', fileRegex: '^pkg-\\d.*\\.zip$',
      sources: [{ id: 'local', listUrl: `${base}/`, fileUrl: `${base}/pkg-{ver}.zip` }],
      checksum: { kind: 'shasumsFile', algo: 'sha256', urls, lineMatch: '  pkg-{ver}.zip$' },
      rootDir: `${PKG}-{ver}`, layout: 'binAtRoot',
    });
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  }

  it('下载源与首个校验源同主机:同主机的坏哈希被跳过,跨域命中真值(S2 式投毒失败)', async () => {
    const buf = zipFor(V1);
    const srv = await startFileServer(buf, `pkg-${V1}.zip`); // 真下载源
    servers.push(srv);
    const good = createHash('sha256').update(buf).digest('hex');
    const bad = createHash('sha256').update(Buffer.from('trojan')).digest('hex');
    const entry = s1Entry(srv.url, [`${srv.url}/SHASUMS256.txt`, 'http://cross.invalid/SHASUMS256.txt']);
    const fetched: string[] = [];
    const fetchText = async (u: string): Promise<string> => {
      fetched.push(u);
      const line = (u.includes('cross.invalid') ? good : bad) + `  pkg-${V1}.zip`;
      return line;
    };
    const rec = await install(entry, verOf(V1), {}, { devRoot, downloader: dl, store, history, fetchText });
    expect(rec.sha256).toBe(good);
    // 同主机源排在跨域之后(catalog 首位若被沦陷镜像占着,这里也不会先信它)
    expect(fetched).toEqual(['http://cross.invalid/SHASUMS256.txt']);
    expect(markerViaCurrent()).toBe(`content-${V1}`);
  });

  it('跨域全部取不到 → 仍回落同主机兜底(可用性优先,单源自洽仍被拒绝)', async () => {
    const buf = zipFor(V1);
    const srv = await startFileServer(buf, `pkg-${V1}.zip`);
    servers.push(srv);
    const good = createHash('sha256').update(buf).digest('hex');
    const entry = s1Entry(srv.url, [`${srv.url}/SHASUMS256.txt`, 'http://cross.invalid/SHASUMS256.txt']);
    const fetchText = async (u: string): Promise<string> => {
      if (u.includes('cross.invalid')) throw new Error('cross down'); // 跨域不可达
      return good + `  pkg-${V1}.zip`; // 同主机兜底命中
    };
    const rec = await install(entry, verOf(V1), {}, { devRoot, downloader: dl, store, history, fetchText });
    expect(rec.sha256).toBe(good);
  });
});
