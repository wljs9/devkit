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
    kind: z.enum(['shasumsFile', 'adoptiumApi', 'officialSidecar']),
    algo: z.enum(['sha256', 'sha512']),
    urls: z.array(z.string()).optional(),
    lineMatch: z.string().optional(),
    note: z.string().optional(),
    alt: z.string().optional(),
  })
  .strict();

export const CatalogEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string(),
    listKind: z.enum(['dirIndex', 'adoptiumApi']),
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
    dirRegex: z.string().optional(),
    fileRegex: z.string(),
    versionPolicy: z.object({ preferEvenMajorLts: z.boolean().optional(), excludeRc: z.boolean().optional() }).optional(),
    sources: z.array(SourceSchema).min(1),
    checksum: ChecksumSchema,
    rootDir: z.string(),
    layout: z.enum(['binAtRoot', 'binSubdir']),
    assetNamingNote: z.string().optional(),
    pathPlaceholderNote: z.string().optional(),
    m0: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.listKind === 'dirIndex' && !e.dirRegex) ctx.addIssue({ code: 'custom', message: 'dirIndex 必须给 dirRegex' });
    if (e.listKind === 'dirIndex' && !e.sources.some((s) => s.listUrl)) ctx.addIssue({ code: 'custom', message: 'dirIndex 需至少一个带 listUrl 的源' });
    if (e.listKind === 'adoptiumApi' && (!e.listApi || !e.releaseFields || !e.majors)) ctx.addIssue({ code: 'custom', message: 'adoptiumApi 需 listApi/releaseFields/majors' });
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
  /** 规整 semver(不含 build 元数据);Temurin 附加 build/releaseName */
  version: string;
  build?: number;
  releaseName?: string;
  /** 相对目录条目,如 v22.20.0/3.9.16 */
  dir?: string;
  /** 资产文件名(node/maven 由模板推,temurin 取 API) */
  asset: string;
  size?: number;
  checksum?: { algo: 'sha256' | 'sha512'; hex: string };
  /** 首选下载源(listVersions 时按源优先级+覆盖范围初选) */
  preferredSourceId: string;
}

export interface ListContext {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

/** 目录页解析:listUrl → dirRegex → semver 降序;文件名按 fileRegex 模板生成 */
function parseDirIndex(entry: CatalogEntry, listUrl: string, html: string): DiscoveredVersion[] {
  const re = new RegExp(entry.dirRegex!);
  const names: { version: string; dir: string }[] = [];
  for (const h of hrefsOf(html)) {
    const m = re.exec(h);
    if (!m?.groups?.ver) continue;
    const raw = m.groups.ver;
    const coerced = semver.coerce(raw);
    if (!coerced) continue;
    names.push({ version: coerced.version, dir: raw });
  }
  names.sort((a, b) => semver.rcompare(a.version, b.version));
  // 资产名 = 首选源 fileUrl 的末段模板渲染({ver} 用目录原文,如 v22.20.0 的 ver 组)
  const assetTpl = entry.sources[0]!.fileUrl.slice(entry.sources[0]!.fileUrl.lastIndexOf('/') + 1);
  return names.map((n) => ({
    tool: entry.id,
    version: n.version,
    dir: n.dir,
    asset: renderTemplate(assetTpl, { ver: n.dir, path: `${n.dir}/` }),
    preferredSourceId: entry.sources[0]!.id,
  }));
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
