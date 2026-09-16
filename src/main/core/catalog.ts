/**
 * 工具清单(技术手册 §6):catalog/*.json 的加载(zod)、版本发现解析与缓存。
 * M0 实测确立了两种 listKind:
 *   dirIndex    —— 镜像 HTML 目录页(华为/清华/nodejs.org),正则提版本;
 *   adoptiumApi —— Temurin:Adoptium API JSON 做版本发现(境内 GitHub 不可直连,官方源已核实)。
 * 纯函数化设计:fetch/时钟/缓存全部可注入 → vitest 用 fixture 直测。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { CoreError } from './errors';

// ---------------------------------------------------------------- schema

const SourceSchema = z
  .object({
    id: z.string().min(1),
    listUrl: z.string().url().optional(),
    fileUrl: z.string(), // 模板:{ver} {path} {asset} {major} {releaseName} {releaseNameUrlenc}
    sidecarUrl: z.string().optional(),
    scope: z.enum(['all', 'latestOnly']).optional().default('all'),
    proxy: z.object({ kind: z.literal('prefix'), value: z.string().url() }).optional(),
    proxyable: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();

const ChecksumSchema = z
  .object({
    kind: z.enum(['shasumsFile', 'adoptiumApi', 'officialSidecar', 'discoveredSidecar', 'pinnedHash']),
    algo: z.enum(['sha256', 'sha512']),
    urls: z.array(z.string()).optional(),
    lineMatch: z.string().optional(),
    /**
     * ★ F4(2026-09-16):pinned 固定哈希 —— 官方不发布 sidecar 的工具(Git/Python/DBeaver/VS Code),
     * 在清单内嵌「版本 → 哈希」表(发新版时例行更新)。下载仍【永远校验】(§3.5 红线不动摇),
     * 只是校验权威从"镜像 sidecar"换成"发货方人工核对过的固定表"。表里没有的版本 → 拒装 + 可读提示。
     */
    pinned: z
      .record(
        z.string(),
        z.object({
          algo: z.enum(['sha256', 'sha512']),
          hex: z.string().regex(/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i),
        }),
      )
      .optional(),
    note: z.string().optional(),
    alt: z.string().optional(),
  })
  .strict();

/**
 * ★ F1(2026-09-14):接管已有安装的探测规则(清单驱动 —— 新增 Python/Git/MySQL/MinGW 等
 * 只需在 catalog 补一段 adopt,core 零改动)。
 * 判据 = markers 全部存在(这个目录"像"该工具)+ version 探测按序首个成功者胜出。
 * 探测四型:
 *   releaseFile —— 读文本文件再正则(release 文件/JAVA_VERSION="21.0.4")
 *   fileGlob    —— 列目录取首个匹配文件名(lib/maven-core-3.9.9.jar)
 *   dirName     —— 目录名正则(apache-maven-3.9.9 / mysql-8.0.36-winx64)
 *   exec        —— 执行树内可执行文件,stdout+stderr 合并后正则(node.exe -v / python.exe --version)
 * 一律取【第 1 个捕获组】;命中后只做去首尾空白与去掉前导 v(V)—— 版本串仅作标签与登记键,
 * 不参与任何路径推导(接管项的目录从不按版本推导),故不需要 semver 化。
 */
const AdoptProbeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('releaseFile'), file: z.string().min(1), regex: z.string().min(1), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('fileGlob'), dir: z.string().min(1), pattern: z.string().min(1), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('dirName'), regex: z.string().min(1), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('exec'), exe: z.string().min(1), args: z.array(z.string()).optional(), regex: z.string().min(1), note: z.string().optional() }).strict(),
]);

const AdoptSchema = z
  .object({
    /** 相对目录的标记文件,全部存在才认定"这个目录是该工具" */
    markers: z.array(z.string()).min(1),
    /** 版本探测链(按序试,首个成功者胜出) */
    version: z.array(AdoptProbeSchema).min(1),
    /** 该工具的主可执行文件(展示用;可省) */
    exec: z.string().optional(),
    /** 接管后 PATH 需要的子路径(文档/后续版本用:`bin`、`cmd`、`.`;本期固定 3 条 PATH 不含新工具) */
    binDir: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

export type AdoptProbe = z.infer<typeof AdoptProbeSchema>;

/** ★ F4 jsonApi:JSON 版本 API 的形状(点路径取值,JetBrains 键控对象 / 平数组) */
const ListScanSchema = z
  .object({
    shape: z.enum(['flat', 'map']),
    /** map 型:响应里版本数组所在点路径(JetBrains:"IIC") */
    root: z.string().optional(),
    versionPath: z.string().optional(),
    assetPath: z.string().optional(),
    checksumPath: z.string().optional(),
    sizePath: z.string().optional(),
  })
  .strict();

export const CatalogEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string(),
    listKind: z.enum(['dirIndex', 'adoptiumApi', 'jsonApi', 'latestRedirect']),
    majors: z.array(z.number().int().positive()).optional(),
    listApi: z.string().optional(),
    releaseFields: z
      .object({
        releaseName: z.string(),
        semver: z.string(),
        build: z.string(),
        packageLink: z.string(),
        packageChecksum: z.string(),
        packageSize: z.string(),
      })
      .optional(),
    listScan: ListScanSchema.optional(),
    dirRegex: z.string().optional(),
    fileRegex: z.string(),
    versionPolicy: z.object({ preferEvenMajorLts: z.boolean().optional(), excludeRc: z.boolean().optional() }).optional(),
    /** ★ F4:版本串按原文保留(非 semver,如 git tag "2.55.0.windows.5"),排序用自然序 */
    rawVersion: z.boolean().optional(),
    /** ★ F4:发现结果只保留最新 N 个,防几百版本刷商店页(VS Code/JetBrains/Git) */
    maxVersions: z.number().int().min(1).optional(),
    /** ★ F4:模板别名 —— 对 {ver} 做字面量替换生成新模板变量(MinGit 资产名 "2.55.0.5" 由 "2.55.0.windows.5" 去 window 段得到) */
    aliases: z.array(z.object({ name: z.string().regex(/^[A-Za-z_]\w*$/), from: z.string(), to: z.string() })).optional(),
    sources: z.array(SourceSchema).min(1),
    checksum: ChecksumSchema,
    rootDir: z.string(),
    layout: z.enum(['binAtRoot', 'binSubdir']),
    /** binSubdir 布局时的子目录名(MinGit 的 git.exe 在 cmd\ 不在 bin\,默认 bin) */
    binName: z.string().optional(),
    /** ★ F1:接管已有安装的探测规则(见 AdoptSchema);缺省 = 该工具不支持接管 */
    adopt: AdoptSchema.optional(),
    assetNamingNote: z.string().optional(),
    pathPlaceholderNote: z.string().optional(),
    m0: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.listKind === 'dirIndex' && !e.dirRegex) ctx.addIssue({ code: 'custom', message: 'dirIndex 必须给 dirRegex' });
    if (e.listKind === 'dirIndex' && !e.sources.some((s) => s.listUrl)) ctx.addIssue({ code: 'custom', message: 'dirIndex 需至少一个带 listUrl 的源' });
    if (e.listKind === 'adoptiumApi' && (!e.listApi || !e.releaseFields || !e.majors)) ctx.addIssue({ code: 'custom', message: 'adoptiumApi 需 listApi/releaseFields/majors' });
    if (e.listKind === 'jsonApi' && (!e.listApi || !e.listScan)) ctx.addIssue({ code: 'custom', message: 'jsonApi 需 listApi/listScan' });
    if (e.listKind === 'latestRedirect' && !e.sources.some((s) => s.listUrl)) ctx.addIssue({ code: 'custom', message: 'latestRedirect 需 source.listUrl(=重定向地址)' });
  });

export type CatalogSource = z.infer<typeof SourceSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export function loadCatalogDir(dir: string): CatalogEntry[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const r = CatalogEntrySchema.safeParse(raw);
      if (!r.success) throw new CoreError('catalog-invalid', `清单 ${f} 不合法:${r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`);
      return r.data;
    });
}

// ---------------------------------------------------------------- 模板渲染

export interface TemplateVars {
  ver?: string;
  path?: string;
  asset?: string;
  major?: number | string;
  releaseName?: string;
  [k: string]: string | number | undefined;
}

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{(\w+)\}/g, (_all, key: string) => {
    if (key === 'releaseNameUrlenc') return encodeURIComponent(String(vars.releaseName ?? ''));
    const v = vars[key];
    if (v === undefined) throw new CoreError('template-missing-var', `模板占位符 {${key}} 无值:${tpl}`);
    return String(v);
  });
}

/** 目标文件 URL(含代理前缀拼接;§7.4 换源 = 换 sourceId 重算) */
export function fileUrlFor(entry: CatalogEntry, sourceId: string, vars: TemplateVars): string {
  const src = sourceOf(entry, sourceId);
  const url = renderTemplate(src.fileUrl, { ...vars, ver: vars.ver ?? (vars as { ver?: string }).ver });
  return src.proxy?.kind === 'prefix' ? src.proxy.value + url : url;
}

export function sourceOf(entry: CatalogEntry, id: string): CatalogSource {
  const s = entry.sources.find((x) => x.id === id);
  if (!s) throw new CoreError('unknown-source', `清单 ${entry.id} 无源 ${id}(可选:${entry.sources.map((x) => x.id).join('/')})`);
  return s;
}

/** 校验和取回 URL(kind 分流;adoptiumApi 无需 URL——发现时已带) */
export function checksumUrlsFor(entry: CatalogEntry, vars: TemplateVars): string[] {
  const c = entry.checksum;
  if (c.kind === 'adoptiumApi') return [];
  if (c.kind === 'officialSidecar') return (c.urls ?? []).map((u) => renderTemplate(u, vars));
  // shasumsFile:urls 模板逐个渲染
  return (c.urls ?? []).map((u) => renderTemplate(u, vars));
}

// ---------------------------------------------------------------- 设置覆盖(§4.6,M3)

export interface CatalogPrefs {
  /** 源 id 优先级(商店页拖排结果):列出的按序排前,未列出的保持原有相对次序在后 */
  priority?: string[];
  /** 源 id → 代理前缀覆盖(风险登记 §12:ghfast.top 可换):''=显式去代理直连,未提键=不变 */
  proxyPrefixes?: Record<string, string>;
}

/**
 * 把用户设置作用到清单条目上 —— 返回【新对象】:catalogs() map 是跨请求共享单例,原地改会造成偏好串台。
 * 这是"JDK/Maven catalog 接真"的设置半边(另半边 = install.ts 经 fileUrlFor 真正拼上 proxy 前缀)。
 */
export function applyCatalogPrefs(entry: CatalogEntry, prefs: CatalogPrefs): CatalogEntry {
  const order = prefs.priority ?? [];
  const prefixes = prefs.proxyPrefixes ?? {};
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const sorted = entry.sources
    .map((s, i) => ({ s, key: rank.has(s.id) ? (rank.get(s.id) as number) : order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ s }) => s);
  const sources = sorted.map((s) => {
    const p = prefixes[s.id];
    if (p === undefined) return s;
    if (p === '') {
      const copy = { ...s };
      delete copy.proxy;
      return copy;
    }
    return { ...s, proxy: { kind: 'prefix' as const, value: p } };
  });
  return { ...entry, sources };
}

/**
 * 优先级生效后重选首选源:按序取第一个【能覆盖该版本】的源。
 * latestOnly 源(USTC 实测只留各 major 最新构建)的覆盖判定借用发现阶段的信号:
 * adoptiumApi 发现把"恰为最新构建"的版本 preferredSourceId 指到该源(M1 逻辑),否则跳过它。
 */
export function preferByPriority(v: DiscoveredVersion, sources: CatalogSource[]): string {
  for (const s of sources) {
    if (s.scope === 'latestOnly' && v.preferredSourceId !== s.id) continue;
    return s.id;
  }
  return v.preferredSourceId;
}

// ---------------------------------------------------------------- 版本发现

export interface DiscoveredVersion {
  tool: string;
  /** 规整 semver(不含 build 元数据);Temurin 附加 build/releaseName;rawVersion 工具为原文 */
  version: string;
  build?: number;
  releaseName?: string;
  /** 相对目录条目,如 v22.20.0/3.9.16 */
  dir?: string;
  /** 资产文件名(node/maven 由模板推,temurin 取 API) */
  asset: string;
  size?: number;
  checksum?: { algo: 'sha256' | 'sha512'; hex: string };
  /** ★ F4:发现阶段携带的 sidecar 校验和 URL(JetBrains:API 的 checksumLink) */
  checksumUrl?: string;
  /** ★ F4:dirRegex 其余命名组(base 等)与原目录字符串,供资产名/URL 模板渲染 */
  extra?: Record<string, string>;
  /** 首选下载源(listVersions 时按源优先级+覆盖范围初选) */
  preferredSourceId: string;
}

/** ★ F4:点路径取值({a.b.c})—— jsonApi 解析用 */
function dotGet(o: unknown, p: string): unknown {
  if (!p) return o;
  return p.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], o);
}

/** ★ F4:原始版本的自然序(数字段按数值、其他按字典):"2.55.0.windows.10" > "2.55.0.windows.2" */
export function naturalCompare(a: string, b: string): number {
  const ta = a.split(/(\d+)/);
  const tb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i] ?? '';
    const y = tb[i] ?? '';
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 版本归一:rawVersion 工具保留原文(去前导 v),其余沿用 semver coerce(与旧行为一致) */
function normalVersion(raw: string, rawVersion?: boolean): string {
  const s = raw.trim();
  if (rawVersion) return s.replace(/^[vV](?=\d)/, '');
  return semver.coerce(s)?.version ?? s;
}

/** ★ F4:模板别名 —— 对 {ver} 做 from→to 字面量替换,产出命名模板变量(pure,数据驱动) */
function aliasedVars(ver: string, aliases: NonNullable<CatalogEntry['aliases']>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of aliases) out[a.name] = ver.split(a.from).join(a.to);
  return out;
}

export interface ListContext {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * 目录页解析:listUrl → dirRegex → 版本降序;资产名 = 首选源 fileUrl 末段模板渲染。
 * ★ F4:支持 (a) dirRegex 多余命名组(node{v}/maven{v}/git{ver}+{href});(b) rawVersion 原始版本文本(Git tag);
 * (c) aliases 模板别名(MinGit 资产名数字段);(d) maxVersions 截取最新 N 个。
 */
function parseDirIndex(entry: CatalogEntry, listUrl: string, html: string): DiscoveredVersion[] {
  const re = new RegExp(entry.dirRegex!);
  const names: { version: string; dir: string; href: string; extra: Record<string, string> }[] = [];
  for (const h of hrefsOf(html)) {
    const m = re.exec(h);
    if (!m?.groups?.ver) continue;
    const raw = m.groups.ver;
    const version = normalVersion(raw, entry.rawVersion);
    if (!version) continue;
    if (entry.versionPolicy?.excludeRc && /rc|pre|beta|alpha/i.test(raw)) continue;
    const extra: Record<string, string> = { ...(m.groups ?? {}) } as Record<string, string>;
    names.push({ version, dir: raw, href: h.replace(/\/+$/, ''), extra });
  }
  names.sort((a, b) => (entry.rawVersion ? naturalCompare(b.version, a.version) : semver.rcompare(a.version, b.version)));
  const assetTpl = entry.sources[0]!.fileUrl.slice(entry.sources[0]!.fileUrl.lastIndexOf('/') + 1);
  const capped = entry.maxVersions ? names.slice(0, entry.maxVersions) : names;
  return capped.map((n) => ({
    tool: entry.id,
    version: n.version,
    dir: n.dir,
    asset: renderTemplate(assetTpl, { ...n.extra, ...aliasedVars(n.version, entry.aliases ?? []), ver: n.version, path: n.href + '/' }),
    extra: { ...n.extra, href: n.href },
    preferredSourceId: entry.sources[0]!.id,
  }));
}

/**
 * ★ F4:JSON 版本 API 解析(listKind jsonApi)。
 * - flat:响应是版本串平数组(VS Code /api/releases/stable 形态,资产由 fileUrl 模板推);
 * - map:响应是键控对象(listScan.root 指向数组,各字段走点路径)—— JetBrains 形态,
 *   资产与校验和 URL 直接来自 API(downloads.windowsZip.link/.checksumLink),template 只留 asset 占位。
 */
function parseJsonApi(entry: CatalogEntry, json: unknown): DiscoveredVersion[] {
  const scan = entry.listScan!;
  const out: DiscoveredVersion[] = [];
  if (scan.shape === 'flat') {
    const arr = Array.isArray(json) ? json : [];
    for (const item of arr) {
      if (typeof item !== 'string' || !/^\d[\w.]*$/.test(item)) continue; // 只认"数字开头"的版本串
      const version = normalVersion(item, true);
      if (!version) continue;
      out.push({ tool: entry.id, version, dir: version, asset: '', preferredSourceId: entry.sources[0]!.id });
    }
  } else {
    const rootList = Array.isArray(dotGet(json, scan.root ?? '')) ? (dotGet(json, scan.root ?? '') as unknown[]) : [];
    for (const item of rootList) {
      const version = normalVersion(String(dotGet(item, scan.versionPath ?? '') ?? ''), entry.rawVersion ?? true);
      const link = String(dotGet(item, scan.assetPath ?? '') ?? '');
      if (!version || !link) continue; // 无资产的发行版条目跳过(源码包/仅 win exe 等)
      const sizeRaw = Number(dotGet(item, scan.sizePath ?? ''));
      out.push({
        tool: entry.id,
        version,
        dir: version,
        asset: link,
        size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : undefined,
        checksumUrl: scan.checksumPath ? String(dotGet(item, scan.checksumPath) ?? '') || undefined : undefined,
        preferredSourceId: entry.sources[0]!.id,
      });
    }
  }
  out.sort((a, b) => naturalCompare(b.version, a.version));
  return entry.maxVersions ? out.slice(0, entry.maxVersions) : out;
}

/**
 * ★ F4:无索引、"只给最新"的官方重定向(标准:VS Code 的 latest 下载点)。
 * 跟转发到终URL,从终URL文件名(含版本)提取版本 —— 单版本发现。
 */
async function parseLatestRedirect(entry: CatalogEntry, ctx: ListContext): Promise<DiscoveredVersion[]> {
  const f = ctx.fetchImpl ?? fetch;
  const src = entry.sources.find((s) => s.listUrl);
  if (!src?.listUrl) throw new CoreError('catalog-fetch', `latestRedirect 缺 listUrl:${entry.id}`);
  const res = await f(src.listUrl, { headers: { 'User-Agent': 'DevKit-M1/0.1' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new CoreError('catalog-fetch', `HTTP ${res.status} ${src.listUrl}`);
  const finalName = res.url.slice(res.url.lastIndexOf('/') + 1);
  const m = new RegExp(entry.fileRegex).exec(finalName);
  if (!m?.groups?.ver) throw new CoreError('catalog-unreachable', `重定向终URL无法识别版本:${finalName}`);
  const version = normalVersion(m.groups.ver, entry.rawVersion);
  return [
    {
      tool: entry.id,
      version,
      dir: version,
      asset: finalName,
      preferredSourceId: src.id,
    },
  ];
}

/** adoptiumApi 解析:每个 major 拉列表,releaseFields 取字段 */
function parseAdoptiumApi(entry: CatalogEntry, json: unknown[]): DiscoveredVersion[] {
  const f = entry.releaseFields!;
  const out: DiscoveredVersion[] = [];
  for (const item of json) {
    const get = (p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], item);
    const releaseName = String(get(f.releaseName) ?? '');
    const semverRaw = String(get(f.semver) ?? '');
    const build = Number(get(f.build));
    const link = String(get(f.packageLink) ?? '');
    const checksum = String(get(f.packageChecksum) ?? '');
    const size = Number(get(f.packageSize));
    if (!releaseName.startsWith('jdk-') || !link || !/^[0-9a-f]{64}$/i.test(checksum)) continue;
    const clean = semver.coerce(semverRaw)?.version;
    if (!clean) continue;
    out.push({
      tool: entry.id,
      version: clean,
      build: Number.isFinite(build) ? build : undefined,
      releaseName,
      asset: link.slice(link.lastIndexOf('/') + 1),
      size: Number.isFinite(size) ? size : undefined,
      checksum: { algo: 'sha256', hex: checksum.toLowerCase() },
      preferredSourceId: '', // 由 listVersions 按"是否恰为该 major 最新"决定
    });
  }
  return out;
}

/**
 * 版本发现主入口。
 * dirIndex:用第一可达源做目录解析;adoptiumApi:逐 major 拉 API。
 * Temurin 的 preferredSourceId:USTC LatestRelease 目录命中 → ustc-latest,否则 ghproxy。
 */
export async function listVersions(entry: CatalogEntry, ctx: ListContext = {}): Promise<DiscoveredVersion[]> {
  const f = ctx.fetchImpl ?? fetch;
  const getText = async (url: string): Promise<string> => {
    const res = await f(url, { headers: { 'User-Agent': 'DevKit-M1/0.1' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new CoreError('catalog-fetch', `HTTP ${res.status} ${url}`);
    return res.text();
  };
  let versions: DiscoveredVersion[];
  if (entry.listKind === 'latestRedirect') {
    return parseLatestRedirect(entry, ctx);
  }
  if (entry.listKind === 'jsonApi') {
    const arr = (await f(renderTemplate(entry.listApi ?? '', {}), { headers: { 'User-Agent': 'DevKit-M1/0.1' }, signal: AbortSignal.timeout(30_000) })).json();
    return parseJsonApi(entry, await arr);
  }
  if (entry.listKind === 'dirIndex') {
    const withList = entry.sources.find((s) => s.listUrl);
    let lastErr: unknown;
    let okSource = withList!;
    let html = '';
    for (const s of entry.sources) {
      if (!s.listUrl) continue;
      try {
        html = await getText(s.listUrl);
        okSource = s;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!html) throw new CoreError('catalog-unreachable', `所有目录源失败:${String((lastErr as Error)?.message ?? '')}`);
    versions = parseDirIndex(entry, okSource.listUrl!, html);
    // 若首选源失败但次源成功,preferredSourceId 仍取该版本实际可得的最优源:M1 简化为全局首选可达源
  } else {
    const all: DiscoveredVersion[] = [];
    for (const major of entry.majors!) {
      const arr = (await (await f(renderTemplate(entry.listApi!, { major }), { headers: { 'User-Agent': 'DevKit-M1/0.1' }, signal: AbortSignal.timeout(30_000) })).json()) as unknown[];
      all.push(...parseAdoptiumApi(entry, Array.isArray(arr) ? arr : []));
    }
    all.sort((a, b) => semver.rcompare(a.version, b.version));
    // USTC 只保留各 major 的最新构建(实测)→ 命中的首选 ustc-latest,其余 ghproxy
    const latestByMajor = new Map<string, { version: string; build: number }>();
    for (const v of all) {
      const majorKey = v.version.split('.')[0]!;
      const cur = latestByMajor.get(majorKey);
      if (!cur || semver.gt(v.version, cur.version) || (semver.eq(v.version, cur.version) && (v.build ?? 0) > cur.build)) {
        latestByMajor.set(majorKey, { version: v.version, build: v.build ?? 0 });
      }
    }
    for (const v of all) {
      const top = latestByMajor.get(v.version.split('.')[0]!);
      v.preferredSourceId = top && top.version === v.version && top.build === (v.build ?? 0) ? 'ustc-latest' : 'ghproxy';
    }
    return all;
  }
  void versions;
  return versions;
}

// ---------------------------------------------------------------- 缓存(TTL 24h,UI 强刷绕过;§6)

export interface CachePort {
  read(): Record<string, { fetchedAt: string; versions: DiscoveredVersion[] }>;
  write(d: Record<string, { fetchedAt: string; versions: DiscoveredVersion[] }>): void;
}

export const TTL_MS = 24 * 3600 * 1000;

export class FileCachePort implements CachePort {
  constructor(private readonly file: string) {}
  read(): Record<string, { fetchedAt: string; versions: DiscoveredVersion[] }> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, { fetchedAt: string; versions: DiscoveredVersion[] }>;
    } catch {
      return {};
    }
  }
  write(d: Record<string, { fetchedAt: string; versions: DiscoveredVersion[] }>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

export async function getVersions(entry: CatalogEntry, opts: { force?: boolean; cache?: CachePort; now?: () => Date } & ListContext): Promise<DiscoveredVersion[]> {
  const now = opts.now?.() ?? new Date();
  const cache = opts.cache;
  if (cache && !opts.force) {
    const hit = cache.read()[entry.id];
    if (hit && now.getTime() - new Date(hit.fetchedAt).getTime() < TTL_MS) return hit.versions;
  }
  const fresh = await listVersions(entry, { fetchImpl: opts.fetchImpl, now: opts.now });
  if (cache) {
    const d = cache.read();
    d[entry.id] = { fetchedAt: now.toISOString(), versions: fresh };
    cache.write(d);
  }
  return fresh;
}
