/**
 * 解压、登记、卸载(技术手册 §7.5 / §7.3 卸载红线 / 产品文档 §4.1~4.3)。
 * 链路:下载(含校验)→ extract-zip 到 cache 临时区 → 按 rootDir 归一化 → rename 原子进 tools →
 *       登记(installs)→ 该工具首个版本自动建链 current → history 记账。
 * 失败清理临时目录,登记表不写入(§7.5)。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import extractZip from 'extract-zip';
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

function varsOf(entry: CatalogEntry, ver: DiscoveredVersion, sourceId: string): Record<string, string | number> {
  void sourceId;
  return {
    ver: ver.dir ?? ver.version, // dirIndex:目录原文(v22.20.0);API:version
    path: ver.dir ? `${ver.dir}/` : ver.version,
    asset: ver.asset,
    major: ver.version.split('.')[0]!,
    releaseName: ver.releaseName ?? '',
  };
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

    // ② 解压到 cache 下临时区(与 tools 同盘,保证 ③ rename 原子)
    tempDir = extractTempDir(ctx.devRoot, randomUUID().slice(0, 8));
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(out.partPath, { dir: tempDir });

    // ③ 按 rootDir 归一化:期望顶层目录存在则用之;否则唯一顶层拍平(§7.5)
    const wantRoot = renderTemplate(entry.rootDir, { ...vars, ver: ver.version });
    const entries = fs.readdirSync(tempDir);
    let srcRoot: string;
    if (entries.includes(wantRoot) && fs.statSync(path.join(tempDir, wantRoot)).isDirectory()) {
      srcRoot = path.join(tempDir, wantRoot);
    } else if (entries.length === 1 && fs.statSync(path.join(tempDir, entries[0]!)).isDirectory()) {
      srcRoot = path.join(tempDir, entries[0]!); // 唯一顶层拍平(镜像/打包差异容错)
    } else {
      throw new CoreError('layout-unexpected', `包内顶层结构非预期(期望 ${wantRoot}/,实得 [${entries.join(', ')}])`);
    }

    // ④ 布局验收:binSubdir 必须有 bin\;binAtRoot(node.exe 在根)只要求非空(内容真伪由校验和背书)
    if (entry.layout === 'binSubdir') {
      if (!fs.existsSync(path.join(srcRoot, 'bin'))) throw new CoreError('layout-missing-bin', `缺 bin\\ 目录:${entry.id}`);
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

/** DevRoot 就绪性:cache/current/tools 三目录 + 校验(§5) */
export function ensureDevRoot(devRoot: string): void {
  for (const d of [cacheDir(devRoot), path.join(devRoot, 'tools'), path.join(devRoot, 'current')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
