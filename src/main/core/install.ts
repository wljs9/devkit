/**
 * 解压、登记、卸载(技术手册 §7.5 / §7.3 卸载红线 / 产品文档 §4.1~4.3)。
 * 链路:下载(含校验)→ extract-zip 到 cache 临时区 → 按 rootDir 归一化 → rename 原子进 tools →
 *       登记(installs)→ 该工具首个版本自动建链 current → history 记账。
 * 失败清理临时目录,登记表不写入(§7.5)。
 */
import { execFile as cpExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CoreError } from './errors';
import { Downloader, type DownloadProgress, type HashAlgo } from './download';
import { assertDeletableRealDir, ensureJunction, inspectLink, removeJunction, switchJunction } from './junction';
import { cacheDir, currentLinkPath, extractTempDir, toolVersionDir, versionDir } from './paths';
import { fileUrlFor, renderTemplate, sourceOf, type CatalogEntry, type DiscoveredVersion } from './catalog';
import type { HistoryLog } from './history';
import type { InstallRecord, JsonRepository } from './store';

export interface InstallContext {
  devRoot: string;
  downloader: Downloader;
  store: JsonRepository;
  history: HistoryLog;
  fetchText?: (url: string) => Promise<string>;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return ''; // 相对/坏 URL:无法判主机 → 不参与域分离排序的"同主机组"
  }
}

/**
 * ★ S1(2026-09-09 安全审查):校验源与下载源跨域优先 —— 与包体不同 host 的 sidecar 排前,
 * 同 host 的降为兜底(组内保持 catalog 原序)。单镜像沦陷时"zip+SHASUMS 自洽投毒"不再免费:
 * 除非所有跨域源都取不到,才会退回同源背书(catalog 侧仍把官方域放首位,双保险)。
 */
export function orderChecksumUrls(urls: string[], downloadUrl: string): string[] {
  const dlHost = hostOf(downloadUrl);
  const cross: string[] = [];
  const same: string[] = [];
  for (const u of urls) (dlHost && hostOf(u) === dlHost ? same : cross).push(u);
  return [...cross, ...same];
}

/** 取回期望哈希(shasumsFile/officialSidecar 走网络;adoptiumApi 随发现结果携带) */
async function resolveExpectedChecksum(
  entry: CatalogEntry,
  ver: DiscoveredVersion,
  ctx: InstallContext,
  sourceId: string,
  downloadUrl: string,
): Promise<{ algo: HashAlgo; hex: string } | undefined> {
  const c = entry.checksum;
  if (c.kind === 'adoptiumApi') {
    if (!ver.checksum) throw new CoreError('checksum-missing', 'Temurin 版本条目缺 API checksum(发现逻辑异常)');
    return { algo: 'sha256', hex: ver.checksum.hex };
  }
  // ★ F4:pinned 固定哈希 —— 官方无 sidecar 的工具,权威 = 清单内置表(发版时人工核对更新)。表里没有 → 拒装(宁可不装,§3.5)
  if (c.kind === 'pinnedHash') {
    const p = c.pinned?.[String(ver.version)];
    if (!p) {
      throw new CoreError(
        'checksum-unpinned',
        `${entry.displayName} ${ver.version} 的校验和未收录在清单内置表(仅维护最新版本),请选商店里较新的版本,或等清单更新`,
        { urls: [] },
      );
    }
    return { algo: p.algo, hex: p.hex.toLowerCase() };
  }
  // ★ F4:discoveredSidecar —— 校验 URL 随发现结果携带(JetBrains API 的 checksumLink),内容为裸哈希
  if (c.kind === 'discoveredSidecar') {
    if (!ver.checksumUrl) throw new CoreError('checksum-missing', `${entry.id} ${ver.version} 缺 sidecar URL(发现逻辑异常)`);
    const fetchText = ctx.fetchText ?? defaultFetchText;
    let txt: string;
    try {
      txt = await fetchText(ver.checksumUrl);
    } catch (e) {
      throw new CoreError('checksum-unreachable', `取不到 ${entry.id} ${ver.version} 的校验和(sidecar:${ver.checksumUrl})`, { cause: String(e) });
    }
    const m = txt.trim().match(new RegExp(`^[0-9a-f]{${c.algo === 'sha512' ? 128 : 64}}`, 'i'));
    if (!m) throw new CoreError('checksum-unreachable', `sidecar 内容不是裸哈希:${ver.checksumUrl}`);
    return { algo: c.algo, hex: m[0].toLowerCase() };
  }
  const fetchText = ctx.fetchText ?? defaultFetchText;
  const vars = varsOf(entry, ver, sourceId);
  const urls = orderChecksumUrls((c.urls ?? []).map((u) => renderTemplate(u, vars)), downloadUrl);
  const lineRe = c.lineMatch ? buildShasumsLineRe(c.lineMatch, String(vars.ver), c.algo) : null;
  for (const url of urls) {
    let txt: string;
    try {
      txt = await fetchText(url);
    } catch {
      continue; // 试下一个校验源
    }
    if (lineRe) {
      const m = txt.match(lineRe);
      if (m) return { algo: c.algo, hex: m[1]! };
    } else {
      const m = txt.trim().match(new RegExp(`^[0-9a-f]{${c.algo === 'sha512' ? 128 : 64}}`, 'i'));
      if (m) return { algo: c.algo, hex: m[0].toLowerCase() };
    }
  }
  throw new CoreError('checksum-unreachable', `取不到 ${entry.id} ${ver.version} 的校验和`, { urls });
}

function defaultFetchText(url: string): Promise<string> {
  return fetch(url, { headers: { 'User-Agent': 'DevKit-M1/0.1' }, signal: AbortSignal.timeout(30_000) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
}

/** PowerShell 单引号转义(§7.1 内涵:参数不走裸拼接,防注入;DevRoot 可能含空格/引号) */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * ★ F4(2026-09-16):解压改用 PowerShell Expand-Archive —— extract-zip/yauzl 的 inflate 读流
 * 对部分真实 zip 静默截断(python.org embed 的 python.exe 条目只出 95,994/106,208 字节后
 * 无 end/error 卡死,Expand-Archive 解同一文件 106,208 字节完整)。§7.6 本就约定"解压一律走
 * Expand-Archive"(fetch-electron 已用它);改后安装链路与脚本口径一致。产物先复制为
 * bundle.zip(Expand-Archive 只认 .zip 扩展名)再展开进临时目录,删 Bundle 后按 rootDir 归一化。
 */
async function expandZip(tempDir: string, partPath: string): Promise<void> {
  const bundle = path.join(tempDir, 'bundle.zip');
  fs.copyFileSync(partPath, bundle);
  try {
    await promisify(cpExecFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(bundle)} -DestinationPath ${psQuote(tempDir)} -Force`],
      { windowsHide: true, timeout: 900_000, maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    throw new CoreError('extract-failed', `解压失败(Expand-Archive):${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  } finally {
    fs.rmSync(bundle, { force: true });
  }
}

function varsOf(entry: CatalogEntry, ver: DiscoveredVersion, sourceId: string): Record<string, string | number> {
  void sourceId;
  const v: Record<string, string | number> = {
    ver: ver.dir ?? ver.version, // dirIndex:目录原文(v22.20.0);API:version
    path: ver.dir ? `${ver.dir}/` : ver.version,
    asset: ver.asset,
    major: ver.version.split('.')[0]!,
    releaseName: ver.releaseName ?? '',
    ...(ver.extra ?? {}), // F4:dirRegex 其余命名组 + href(原目录串),MinGit 盘位资产名靠它
    dir: ver.extra?.href ?? ver.dir ?? ver.version,
  };
  for (const a of entry.aliases ?? []) v[a.name] = String(v.ver).split(a.from).join(a.to); // F4 模板别名
  return v;
}

/**
 * 完整安装链:下载→校验→解压→归一化→搬移→登记→(首版)建链。
 * 幂等:同 tool+version 已登记 → already-installed(切换请走 setCurrent)。
 */
export async function install(
  entry: CatalogEntry,
  ver: DiscoveredVersion,
  opts: { sourceId?: string; onProgress?: (p: DownloadProgress) => void },
  ctx: InstallContext,
): Promise<InstallRecord> {
  const t0 = Date.now();
  const src = sourceOf(entry, opts.sourceId ?? ver.preferredSourceId ?? entry.sources[0]!.id);
  const vars = varsOf(entry, ver, src.id);
  // ★ 必须走 fileUrlFor 而非 renderTemplate(src.fileUrl):proxy 前缀(ghproxy 等)在 fileUrlFor 内拼接,
  //   M2 及以前绕过它 → 带前缀源(JDK 历史版本)会直连不可达。M3 "JDK 接真"的接线点。
  const url = fileUrlFor(entry, src.id, vars);
  const target = toolVersionDir(ctx.devRoot, entry.id, ver.version);
  const done = (ok: boolean, extra: Record<string, unknown>): void => {
    ctx.history.append({ kind: 'install', ok, durationMs: Date.now() - t0, detail: { tool: entry.id, version: ver.version, sourceId: src.id, ...extra } });
  };
  const existing = ctx.store.load().installs.find((i) => i.tool === entry.id && i.version === ver.version);
  if (existing) throw new CoreError('already-installed', `${entry.id} ${ver.version} 已安装于 ${existing.path}`);

  let tempDir: string | null = null;
  try {
    // ① 下载 + 哈希校验(§7.4,校验失败清 part 并拒绝——§3.5 红线)
    const expected = await resolveExpectedChecksum(entry, ver, ctx, src.id, url);
    const fileName = url.slice(url.lastIndexOf('/') + 1);
    const out = await ctx.downloader.start({ id: `${entry.id}-${ver.version}`, url, fileName, expected }, opts.onProgress);

    // ② 解压到 cache 下临时区(与 tools 同盘,保证 ③ rename 原子)—— PowerShell Expand-Archive(★F4)
    tempDir = extractTempDir(ctx.devRoot, randomUUID().slice(0, 8));
    fs.mkdirSync(tempDir, { recursive: true });
    await expandZip(tempDir, out.partPath);

    // ③ 按 rootDir 归一化:空 rootDir=文件直接铺在 zip 根(Python embed);期望顶层目录存在则用之;
    //    否则唯一顶层拍平(§7.5,镜像/打包差异容错,JetBrains zip 单顶层目录依赖此路径)
    const wantRoot = renderTemplate(entry.rootDir, { ...vars, ver: ver.version });
    const entries = fs.readdirSync(tempDir);
    let srcRoot: string;
    if (!wantRoot) {
      srcRoot = tempDir; // ★ F4:Python embed 等"flat 铺根"发行物
    } else if (entries.includes(wantRoot) && fs.statSync(path.join(tempDir, wantRoot)).isDirectory()) {
      srcRoot = path.join(tempDir, wantRoot);
    } else if (entries.length === 1 && fs.statSync(path.join(tempDir, entries[0]!)).isDirectory()) {
      srcRoot = path.join(tempDir, entries[0]!); // 唯一顶层拍平
    } else {
      throw new CoreError('layout-unexpected', `包内顶层结构非预期(期望 ${wantRoot}/,实得 [${entries.join(', ')}])`);
    }

    // ④ 布局验收:binSubdir 必须有 binName 子目录(默认 bin\,MinGit 是 cmd\);binAtRoot(node.exe 在根)只要求非空(内容真伪由校验和背书)
    if (entry.layout === 'binSubdir') {
      const bin = entry.binName ?? 'bin';
      if (!fs.existsSync(path.join(srcRoot, bin))) throw new CoreError('layout-missing-bin', `缺 ${bin}\\ 目录:${entry.id}`);
    } else if (fs.readdirSync(srcRoot).length === 0) {
      throw new CoreError('layout-empty', '解压结果为空目录');
    }

    // ⑤ 原子搬移进 tools(目标已存在残留 → 拒绝,防误覆盖)
    if (fs.existsSync(target)) throw new CoreError('path-exists', `目标已存在,拒绝覆盖:${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(srcRoot, target);
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    fs.rmSync(out.partPath, { force: true }); // 安装成功,消费断点产物

    // ⑥ 登记;该工具无 current 时自动建链(首装即可用)
    const rec: InstallRecord = {
      id: `${entry.id}-${versionDir(ver.version)}`,
      tool: entry.id,
      version: ver.version,
      path: target,
      sourceId: src.id,
      sourceUrl: url,
      sha256: out.sha256,
      size: out.bytes,
      installedAt: new Date().toISOString(),
      isCurrent: false,
    };
    const isFirstForTool = !ctx.store.load().installs.some((i) => i.tool === entry.id);
    if (isFirstForTool) rec.isCurrent = true;
    ctx.store.update((d) => ({ ...d, installs: [...d.installs, rec] }));
    if (rec.isCurrent) ensureJunction(currentLinkPath(ctx.devRoot, entry.id), target);

    done(true, { path: target, bytes: out.bytes, autoCurrent: rec.isCurrent });
    return rec;
  } catch (e) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); // §7.5:失败清理临时目录
    done(false, { error: e instanceof Error ? `${e.name}:${e.message}` : String(e) });
    throw e;
  }
}

// ---------------------------------------------------------------- ★ F1 接管已有安装(adopt,2026-09-14)

/** 探测用执行器(注入点:测试无需真跑 exe) */
export type AdoptRunFn = (exe: string, args: string[]) => Promise<string>;

export interface AdoptDeps {
  run?: AdoptRunFn;
}

export interface AdoptHit {
  /** 归一化版本串(去首尾空白 + 去前导 v/V) */
  version: string;
  /** 命中的探测方式 */
  via: 'releaseFile' | 'fileGlob' | 'dirName' | 'exec';
}

/** 执行探测的默认实现:.cmd/.bat 经 cmd.exe /c 转一手(java -version 走 stderr,故合并两流) */
const defaultAdoptRun: AdoptRunFn = async (exe, args) => {
  const isScript = /\.(cmd|bat)$/i.test(exe);
  const cmd = isScript ? 'cmd.exe' : exe;
  const argv = isScript ? ['/d', '/c', exe, ...args] : args;
  const r = await promisify(cpExecFile)(cmd, argv, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  return `${r.stdout}\n${r.stderr}`;
};

function insideOf(p: string, root: string): boolean {
  return path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep);
}

/** 取第 1 个捕获组(大小写不敏感 + 多行) */
function group1(regex: string, text: string): string | null {
  const m = new RegExp(regex, 'mi').exec(text);
  return m?.[1] ?? null;
}

/**
 * 接管前置校验(纯检查,不写任何东西)。逐条拒绝的理由都要能直接展示给用户:
 * ①清单未声明 adopt;②空/相对/UNC 路径;③不存在或非目录;④是链接(要真实目录,防链套链);
 * ⑤落在 DevRoot 内(那是本工具自管区,不该"接管");⑥缺标记文件(选错工具/目录)。
 */
export function assertAdoptableDir(entry: CatalogEntry, dir: string, devRoot?: string): void {
  const a = entry.adopt;
  if (!a) throw new CoreError('adopt-unsupported', `目录清单未声明 ${entry.id} 的接管规则(adopt),暂不支持添加已有安装`);
  if (typeof dir !== 'string' || dir.trim().length === 0) throw new CoreError('adopt-bad-path', '目录不能为空');
  if (!path.isAbsolute(dir)) throw new CoreError('adopt-bad-path', `必须是绝对路径:${dir}`);
  if (/^\\\\/.test(dir)) throw new CoreError('adopt-unc', `不接受 UNC 网络路径(链接目标必须是本机目录):${dir}`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new CoreError('adopt-not-dir', `目录不存在:${dir}`);
  }
  if (st.isSymbolicLink()) throw new CoreError('adopt-is-link', `该路径本身是链接/junction,请选择真实目录:${dir}`);
  if (!st.isDirectory()) throw new CoreError('adopt-not-dir', `不是目录:${dir}`);
  if (devRoot && insideOf(dir, devRoot)) throw new CoreError('adopt-inside-devroot', `该目录在 DevRoot 内(本工具自管区),无需接管:${dir}`);
  const missing = a.markers.filter((m) => !fs.existsSync(path.join(dir, m)));
  if (missing.length > 0) {
    throw new CoreError('adopt-not-tool', `目录里找不到 ${entry.displayName} 的标记文件(${missing.join('、')})——可能选错了工具或目录:${dir}`);
  }
}

async function runProbe(dir: string, p: NonNullable<CatalogEntry['adopt']>['version'][number], deps: AdoptDeps): Promise<string | null> {
  if (p.kind === 'releaseFile') {
    let txt: string;
    try {
      txt = fs.readFileSync(path.join(dir, p.file), 'utf8');
    } catch {
      return null;
    }
    return group1(p.regex, txt);
  }
  if (p.kind === 'fileGlob') {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, p.dir));
    } catch {
      return null;
    }
    const re = new RegExp(p.pattern);
    for (const n of [...names].sort()) {
      const m = re.exec(n);
      if (m?.[1]) return m[1];
    }
    return null;
  }
  if (p.kind === 'dirName') return group1(p.regex, path.basename(path.resolve(dir)));
  const exe = path.join(dir, p.exe);
  if (!fs.existsSync(exe)) return null;
  return group1(p.regex, await (deps.run ?? defaultAdoptRun)(exe, p.args ?? []));
}

/** 版本探测链:按序首个命中者胜出;全败 → adopt-unknown-version(附每条探测的失败原因) */
export async function probeAdoptVersion(entry: CatalogEntry, dir: string, deps: AdoptDeps = {}): Promise<AdoptHit> {
  const chain = entry.adopt?.version ?? [];
  const tried: string[] = [];
  for (const p of chain) {
    try {
      const hit = await runProbe(dir, p, deps);
      if (hit !== null) return { version: hit.trim().replace(/^[vV](?=\d)/, ''), via: p.kind };
      tried.push(`${p.kind}:未命中`);
    } catch (e) {
      tried.push(`${p.kind}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new CoreError('adopt-unknown-version', `无法从该目录识别 ${entry.displayName} 版本(${tried.join(';')})`, { dir });
}

/**
 * 接管登记:校验 → 探测版本 → 查重 → 登记(origin='adopt')→ 该工具首个版本自动建链。
 * **不复制、不移动、不删除任何文件** —— 只记一条指向既有目录的登记 + 一条 current junction。
 */
export async function adoptInstall(entry: CatalogEntry, dir: string, ctx: InstallContext, deps: AdoptDeps = {}): Promise<InstallRecord> {
  const t0 = Date.now();
  let target = path.resolve(dir);
  const done = (ok: boolean, extra: Record<string, unknown>): void => {
    ctx.history.append({ kind: 'adopt', ok, durationMs: Date.now() - t0, detail: { tool: entry.id, dir: target, ...extra } });
  };
  try {
    assertAdoptableDir(entry, dir, ctx.devRoot);
    // 落 realpath:junction 层存的就是 realpath(ensureJunction),两边同源「移出登记」才断得干净
    target = fs.realpathSync(dir);
    const hit = await probeAdoptVersion(entry, dir, deps);
    const installs = ctx.store.load().installs;
    const dupV = installs.find((i) => i.tool === entry.id && i.version === hit.version);
    if (dupV) throw new CoreError('already-installed', `${entry.id} ${hit.version} 已在登记表中(${dupV.path})`);
    if (installs.some((i) => i.tool === entry.id && pathEq(i.path, target))) {
      throw new CoreError('adopt-path-taken', `该目录已登记为 ${entry.id},无需重复添加:${target}`);
    }
    const rec: InstallRecord = {
      id: `${entry.id}-${versionDir(hit.version)}`,
      tool: entry.id,
      version: hit.version,
      path: target,
      sourceId: 'local', // 非下载:来源即本机目录
      sourceUrl: target,
      sha256: '', // 无校验和可言(不删文件,故也不承担校验背书职责)
      size: 0, // 不递归统计既有安装体积(可能极大),UI 显示 "—"
      installedAt: new Date().toISOString(),
      isCurrent: false,
      origin: 'adopt',
    };
    const isFirstForTool = !installs.some((i) => i.tool === entry.id);
    if (isFirstForTool) rec.isCurrent = true;
    ctx.store.update((d) => ({ ...d, installs: [...d.installs, rec] }));
    if (rec.isCurrent) ensureJunction(currentLinkPath(ctx.devRoot, entry.id), target);
    done(true, { version: hit.version, via: hit.via, autoCurrent: rec.isCurrent });
    return rec;
  } catch (e) {
    done(false, { error: e instanceof Error ? `${e.name}:${e.message}` : String(e) });
    throw e;
  }
}

/**
 * 移出登记(接管项专用):只删登记行 + 断 current 链,**绝不触目标目录里的任何文件**(§7.3 红线的自然延伸)。
 * 若移出的恰是当前生效版本:current 链一并断开(环境页按决策 A 标成 ⚠失效),由用户决定后续。
 */
export async function forgetInstall(entry: CatalogEntry, version: string, ctx: InstallContext): Promise<void> {
  const t0 = Date.now();
  const rec = ctx.store.load().installs.find((i) => i.tool === entry.id && i.version === version);
  if (!rec) throw new CoreError('not-installed', `${entry.id} ${version} 未登记`);
  if (rec.origin !== 'adopt') throw new CoreError('not-adopted', `${entry.id} ${version} 是本工具下载安装的,请用「卸载」`);
  ctx.store.update((d) => ({ ...d, installs: d.installs.filter((i) => !(i.tool === entry.id && i.version === version)) }));
  const link = currentLinkPath(ctx.devRoot, entry.id);
  const insp = inspectLink(link);
  if (insp.isLink && insp.realTarget && pathEq(insp.realTarget, rec.path)) removeJunction(link); // 只断链
  ctx.history.append({ kind: 'forget', ok: true, durationMs: Date.now() - t0, detail: { tool: entry.id, version, path: rec.path } });
}

/** 切换当前版本 = 重建一个 junction,PATH 零改动(产品文档 §6) */
export async function setCurrent(entry: CatalogEntry, version: string, ctx: InstallContext): Promise<void> {
  const t0 = Date.now();
  const rec = ctx.store.load().installs.find((i) => i.tool === entry.id && i.version === version);
  if (!rec) throw new CoreError('not-installed', `${entry.id} ${version} 未安装`);
  if (!fs.existsSync(rec.path)) throw new CoreError('path-missing', `安装目录已丢失:${rec.path}`);
  switchJunction(currentLinkPath(ctx.devRoot, entry.id), rec.path);
  ctx.store.update((d) => ({
    ...d,
    installs: d.installs.map((i) => (i.tool === entry.id ? { ...i, isCurrent: i.version === version } : i)),
  }));
  ctx.history.append({ kind: 'switch', ok: true, durationMs: Date.now() - t0, detail: { tool: entry.id, version } });
}

/**
 * 卸载(§7.3 红线的落点):函数第一行即 lstat 判链守卫,
 * 真实删除只允许作用于 tools\<tool>\<ver> 且该路径必须是【非链接】目录。
 */
export async function uninstall(entry: CatalogEntry, version: string, ctx: InstallContext): Promise<void> {
  const t0 = Date.now();
  const dir = toolVersionDir(ctx.devRoot, entry.id, version);
  assertDeletableRealDir(dir); // ← 第一道闸:凡链接一律抛 junction-expected,递归删除永不接触链接路径
  const rec = ctx.store.load().installs.find((i) => i.tool === entry.id && i.version === version);
  // ★ F1:接管项（origin='adopt'）的目录不归本工具所有 → 一律不给删除入口,只许「移出登记」
  if (rec?.origin === 'adopt') {
    throw new CoreError('adopt-unregister-only', `该版本是接管的既有安装,不删除文件,请用「移出登记」:${rec.path}`);
  }
  if (rec?.isCurrent) throw new CoreError('uninstall-current', `不能卸载当前生效版本(${entry.id} ${version}),请先切换到其他版本`);
  if (rec && path.normalize(rec.path).toLowerCase() !== path.normalize(dir).toLowerCase()) {
    throw new CoreError('path-mismatch', `登记路径(${rec.path})与布局推导(${dir})不一致,拒绝删除`);
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  ctx.store.update((d) => {
    const link = inspectLink(currentLinkPath(ctx.devRoot, entry.id));
    // 若 current 链恰好悬空指向被删目标(理论不可达,防御之):断链
    if (link.isLink && !link.realTarget && rec && pathEq(link.linkTarget ?? '', rec.path)) removeJunction(currentLinkPath(ctx.devRoot, entry.id));
    return { ...d, installs: d.installs.filter((i) => !(i.tool === entry.id && i.version === version)) };
  });
  ctx.history.append({ kind: 'uninstall', ok: true, durationMs: Date.now() - t0, detail: { tool: entry.id, version } });
}

function pathEq(a: string, b: string): boolean {
  return a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * SHASUMS 行匹配:哈希 + 空白 + 文件名(行尾锚定;{ver} 先代入,再转义字面量)。
 * ★ M2 走查实测修正:v2 之前把 lineMatch 的前导空格也塞进 \s+ 之后,
 *   等于要求"哈希 + ≥1 空白 + 恰好两空格 + 文件名"(≥3 空白)——而 nodejs 官方
 *   SHASUMS256.txt 真实行是 `<hash>␣␣filename`(仅两空格)→ 永不匹配,
 *   所有 node 版本报"取不到校验和"。lineMatch 里的前导空格只是清单书写提示,
 *   哈希↔文件名的间距一律交给 \s+ 吸收(trimStart)。
 */
function buildShasumsLineRe(lineMatch: string, ver: string, algo: HashAlgo): RegExp {
  const named = lineMatch.replace('{ver}', ver);
  const literal = named.replace(/\$$/, '').trimStart(); // 尾部 $=行锚;前导空白间距由 \s+ 负责
  const hex = algo === 'sha512' ? 128 : 64;
  return new RegExp(`([0-9a-f]{${hex}})\\s+${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mi');
}

/**
 * ★ S2(2026-09-09 安全审查):shell:open-path 收口 —— 渲染层只持有 installId,目录路径由主进程
 * 查登记表解析,三道闸后才交给 shell.openPath(= ShellExecute,任意字符串可直达 exe/UNC 是漏洞面):
 * ①id 必须命中 installs;②解析后必须落在 DevRoot 之内;③必须是真实目录。
 * ★ F1(2026-09-14):接管项(origin='adopt')的目录【按定义】在 DevRoot 之外,②对它们改为
 *   "本机绝对路径 + 非 UNC"——路径仍全部出自主进程登记表,S2 的收口语义(渲染层不持有任何路径)不变。
 */
export function resolveOpenableInstallDir(devRoot: string, installs: InstallRecord[], installId: string): string {
  const rec = installs.find((i) => i.id === installId);
  if (!rec) throw new CoreError('unknown-install', `登记表中无安装记录:${installId}`);
  const base = path.resolve(devRoot) + path.sep;
  const target = path.resolve(rec.path);
  if (rec.origin === 'adopt') {
    // 接管项:绝对路径 + 非 UNC(链接/ShellExecute 都不接受网络路径)
    if (!path.isAbsolute(rec.path) || /^\\\\/.test(rec.path)) {
      throw new CoreError('open-path-unc', `接管项的登记路径不是本机绝对路径,拒绝打开:${rec.path}`);
    }
  } else if (!target.toLowerCase().startsWith(base.toLowerCase())) {
    throw new CoreError('open-path-outside', `安装目录不在 DevRoot 内,拒绝打开:${target}`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    throw new CoreError('path-missing', `安装目录已丢失:${target}`);
  }
  if (!st.isDirectory()) throw new CoreError('open-path-not-dir', `目标不是目录,拒绝打开:${target}`);
  return target;
}

/** DevRoot 就绪性:cache/current/tools 三目录 + 校验(§5) */
export function ensureDevRoot(devRoot: string): void {
  for (const d of [cacheDir(devRoot), path.join(devRoot, 'tools'), path.join(devRoot, 'current')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
