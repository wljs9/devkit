/**
 * M0 镜像可行性探测(技术手册 §13、产品文档 §5)
 *
 * 目标:对 Node.js / JDK(Temurin) / Maven 三工具的 目录解析 → 抽样下载 → 校验和匹配 全链路实测,
 *       验证结果用于固化 catalog/*.json。不依赖任何脚手架与 npm 包,纯 Node ≥ 22 直跑:
 *
 *   node scripts/m0-probe.ts            # 全量探测(含 ~230MB 抽样下载)
 *   node scripts/m0-probe.ts --quick    # 只跑目录解析与校验和文件可达性,不下载大包
 *
 * 退出码:0 = 三工具全部核心步骤通过;1 = 存在失败项。
 * 结果证据写入仓库根 m0-results.json(随 catalog 一起提交)。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- 基础设施工具

const UA = { 'User-Agent': 'DevKit-M0-Probe/0.1 (mirror feasibility test)' };
const QUICK = process.argv.includes('--quick');

interface StepResult {
  name: string;
  ok: boolean;
  /** 通过时的关键证据(版本/哈希/状态码),失败时的错误摘要 */
  detail: string;
  ms: number;
}

interface ToolResult {
  id: string;
  steps: StepResult[];
  sample?: { version: string; url: string; sha256?: string; sizeBytes?: number };
}

const results: ToolResult[] = [];
let hadFailure = false;

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

/** Range 支持性探测(M1 断点续传的前提):期望 206;200 也能工作但只能重头下 */
async function rangeProbe(url: string): Promise<string> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...UA, Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(30_000),
  });
  await res.body?.cancel();
  return `HTTP ${res.status}${res.status === 206 ? ' (支持 Range)' : ' (整文件重下)'}`;
}

/** 流式下载到临时文件,边下边算 sha256/sha512 */
async function downloadAndHash(url: string, timeoutMs = 600_000): Promise<{
  sha256: string;
  sha512: string;
  bytes: number;
  ms: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-m0-'));
  const dest = join(dir, 'sample.part');
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${url}`);
    const h256 = createHash('sha256');
    const h512 = createHash('sha512');
    const out = createWriteStream(dest);
    const t0 = Date.now();
    let bytes = 0;
    let lastBeat = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      h256.update(chunk);
      h512.update(chunk);
      bytes += chunk.byteLength;
      out.write(chunk);
      if (bytes - lastBeat > 32 * 1024 * 1024) {
        lastBeat = bytes;
        const mb = (bytes / 1048576).toFixed(0);
        process.stderr.write(`\r  … 已下载 ${mb} MB`);
      }
    }
    out.end();
    await new Promise<void>((ok, err) => {
      out.on('finish', () => ok());
      out.on('error', err);
    });
    process.stderr.write(`\r\r  … 下载完成 ${(bytes / 1048576).toFixed(1)} MB\n`);
    return { sha256: h256.digest('hex'), sha512: h512.digest('hex'), bytes, ms: Date.now() - t0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 HTML 目录页提取全部 href */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

/** 极简 semver 比较(仅数字段,降序排序用) */
function semverDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 执行一个探测步骤:计时、捕获异常、打印 ✓/✗ */
async function step(tool: ToolResult, name: string, fn: () => Promise<string>): Promise<string> {
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  try {
    detail = await fn();
    ok = true;
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
    hadFailure = true;
  }
  const ms = Date.now() - t0;
  tool.steps.push({ name, ok, detail, ms });
  log(`  ${ok ? '✓' : '✗'} ${name} — ${detail} [${ms}ms]`);
  return detail;
}

// ---------------------------------------------------------------- Node.js

async function probeNode(): Promise<void> {
  const tool: ToolResult = { id: 'node', steps: [] };
  results.push(tool);
  const HU = 'https://mirrors.huaweicloud.com/nodejs';
  log('\n== Node.js ==');

  // 1. 目录解析:拉根目录页 → 提取 vX.Y.Z → 选最新偶数版本号(即最新 LTS 线内的最新版)
  const versions = await step(tool, '目录解析(华为云 /nodejs/)', async () => {
    const html = await fetchText(`${HU}/`);
    const vs = [...new Set(hrefs(html).flatMap((h) => h.match(/^v(\d+\.\d+\.\d+)\/?$/)?.slice(1) ?? []))]
      .sort(semverDesc);
    if (vs.length === 0) throw new Error('未解析到任何版本目录');
    const lts = vs.filter((v) => Number(v.split('.')[0]) % 2 === 0);
    const pick = (lts[0] ?? vs[0])!;
    tool.sample = { version: pick, url: `${HU}/v${pick}/node-v${pick}-win-x64.zip` };
    return `解析 ${vs.length} 版,抽样 LTS ${pick}`;
  });
  if (!tool.sample) return;
  const ver = tool.sample.version;
  const zipName = `node-v${ver}-win-x64.zip`;

  // 2. 校验和文件:同目录 SHASUMS256.txt 中提取目标 zip 的 sha256
  const expected = await step(tool, 'SHASUMS256.txt 解析', async () => {
    const txt = await fetchText(`${HU}/v${ver}/SHASUMS256.txt`);
    const m = txt.match(new RegExp(`([0-9a-f]{64})\\s+${zipName.replace(/\./g, '\\.')}$`, 'm'));
    if (!m) throw new Error('SHASUMS256.txt 中无 win-x64.zip 行');
    return m[1]!;
  });

  await step(tool, 'zip 文件 Range 探测', () => rangeProbe(tool.sample!.url));

  // 3. 抽样下载 + 校验
  if (!QUICK && expected.length === 64) {
    const got = await step(tool, `真实下载(~30MB)与 SHA256 比对 v${ver}`, async () => {
      const r = await downloadAndHash(tool.sample!.url);
      const speed = (r.bytes / 1048576 / (r.ms / 1000)).toFixed(1);
      if (r.sha256 !== expected) throw new Error(`校验失败 期望 ${expected.slice(0, 12)}… 实际 ${r.sha256.slice(0, 12)}…`);
      tool.sample!.sha256 = r.sha256;
      tool.sample!.sizeBytes = r.bytes;
      return `匹配 ${r.sha256.slice(0, 12)}… ${speed}MB/s`;
    });
    void got;
  }
  void versions;
}

// ---------------------------------------------------------------- JDK (Temurin)

interface AdoptiumBinary {
  package: { link: string; checksum: string; size: number };
  image_type?: string;
}
/** /v3/assets/feature_releases 条目:版本信息在 version_data,包在 binaries[](实测形状) */
interface AdoptiumRelease {
  version_data: { semver: string; build: number; openjdk_version: string };
  binaries: AdoptiumBinary[];
  release_name: string;
}
const GH_PROXY = 'https://ghfast.top/';

async function probeJdk(): Promise<void> {
  const tool: ToolResult = { id: 'jdk', steps: [] };
  results.push(tool);
  const MAJOR = 21;
  const USTC_LATEST = `https://mirrors.ustc.edu.cn/github-release/adoptium/temurin${MAJOR}-binaries/LatestRelease/`;
  log('\n== JDK (Temurin) ==');

  // 1. 版本发现:Adoptium API(已实测境内可达;GitHub Release 本体不可直连)
  const releases = await step(tool, '版本发现(Adoptium API x64/windows/jdk)', async () => {
    const arr = await fetchJson<AdoptiumRelease[]>(
      `https://api.adoptium.net/v3/assets/feature_releases/${MAJOR}/ga?architecture=x64&image_type=jdk&os=windows&vendor=adoptium&page_size=20`,
    );
    if (arr.length < 2) throw new Error(`仅返回 ${arr.length} 条,无法抽样历史版本`);
    return `返回 ${arr.length} 条,最新 ${arr[0]!.version_data.semver}`;
  });
  void releases;

  // 2. 国内镜像解析:USTC LatestRelease 目录 → 目标 zip 资产 + .sha256.txt 侧车
  const ustc = await step(tool, '目录解析(USTC LatestRelease temurin' + MAJOR + ')', async () => {
    const html = await fetchText(USTC_LATEST);
    const zip = hrefs(html)
      .map((h) => (h.match(/\/(OpenJDK\d+U-jdk_x64_windows_hotspot_[\d.]+_[\d.]+\.zip)$/) ?? [])[1])
      .find((x): x is string => Boolean(x));
    if (!zip) throw new Error('LatestRelease 内未找到 win-x64 jdk zip');
    const url = USTC_LATEST + zip;
    const txt = await fetchText(url + '.sha256.txt');
    const m = txt.match(/([0-9a-f]{64})/i);
    if (!m) throw new Error('sidecar .sha256.txt 无哈希');
    const v = zip.match(/hotspot_([\d.]+)_([\d.]+)\.zip/)!;
    tool.sample = { version: `${v[1]}+${v[2]}`, url };
    return `${zip} sha256=${m[1]!.slice(0, 12)}…`;
  });
  void ustc;

  // 3. 交叉验证:API 中与 USTC 镜像【同构建】条目的 checksum 应等于镜像 sidecar
  //    (USTC LatestRelease 可能滞后于 API 最新版,必须按版本对齐后再比)
  const api = await step(tool, 'Adoptium API 同构建 checksum 与 USTC sidecar 比对', async () => {
    const [semver, build] = tool.sample!.version.split('+');
    const arr = await fetchJson<AdoptiumRelease[]>(
      `https://api.adoptium.net/v3/assets/feature_releases/${MAJOR}/ga?architecture=x64&image_type=jdk&os=windows&vendor=adoptium&page_size=40`,
    );
    // 注:version_data.semver 现格式含构建元数据(如 "21.0.9+10.0.LTS"),按 release_name 对齐最稳
    const hit = arr.find((r) => r.release_name === `jdk-${semver}+${build}`);
    if (!hit) throw new Error(`API 列表(${arr.length} 条,最新 ${arr[0]?.version_data.semver})中无 ${tool.sample!.version}`);
    const b = hit.binaries[0]!.package;
    const sidecar = (await fetchText(tool.sample!.url + '.sha256.txt')).toLowerCase();
    if (!sidecar.includes(b.checksum.toLowerCase())) throw new Error(`sidecar 与 API checksum 不一致: ${b.checksum.slice(0, 12)}…`);
    return `${tool.sample!.version} 一致 ${b.checksum.slice(0, 12)}… (GitHub 原始包 ${b.size} 字节)`;
  });
  void api;

  // 4. 历史版本走 ghfast 代理:sidecar 拉取 + 包体 Range 探测
  const old = await step(tool, '历史版本经 ghfast.top 代理可达(21 线第 10+ 条)', async () => {
    const arr = await fetchJson<AdoptiumRelease[]>(
      `https://api.adoptium.net/v3/assets/feature_releases/${MAJOR}/ga?architecture=x64&image_type=jdk&os=windows&vendor=adoptium&page_size=20`,
    );
    const target = arr[Math.min(10, arr.length - 1)]!;
    const pkg = target.binaries[0]!.package;
    const via = GH_PROXY + pkg.link;
    const txt = await fetchText(via + '.sha256.txt');
    if (!txt.toLowerCase().includes(pkg.checksum.toLowerCase())) throw new Error('代理 sidecar 与 API checksum 不一致');
    const range = await rangeProbe(via);
    return `${target.version_data.semver}+${target.version_data.build} sidecar 匹配;${range}`;
  });
  void old;

  // 5. 真实下载(USTC,~190MB)全量校验
  if (!QUICK) {
    await step(tool, `真实下载(~190MB)与 SHA256 比对 v${tool.sample?.version}`, async () => {
      const expected = (await fetchText(tool.sample!.url + '.sha256.txt')).match(/([0-9a-f]{64})/i)![1]!;
      const r = await downloadAndHash(tool.sample!.url, 900_000);
      const speed = (r.bytes / 1048576 / (r.ms / 1000)).toFixed(1);
      if (r.sha256 !== expected.toLowerCase()) throw new Error(`校验失败 期望 ${expected.slice(0, 12)}… 实际 ${r.sha256.slice(0, 12)}…`);
      tool.sample!.sha256 = r.sha256;
      tool.sample!.sizeBytes = r.bytes;
      return `匹配 ${r.sha256.slice(0, 12)}… ${speed}MB/s`;
    });
  }
}

// ---------------------------------------------------------------- Maven

async function probeMaven(): Promise<void> {
  const tool: ToolResult = { id: 'maven', steps: [] };
  results.push(tool);
  const HU = 'https://mirrors.huaweicloud.com/apache/maven/maven-3';
  log('\n== Maven ==');

  // 1. 目录解析(注意过滤 rc/snapshot 目录)
  await step(tool, '目录解析(华为云 maven-3/)', async () => {
    const html = await fetchText(`${HU}/`);
    const vs = [...new Set(hrefs(html).flatMap((h) => (h.match(/^(3\.\d+\.\d+)\/?$/) ?? []).slice(1) as string[]))]
      .sort(semverDesc);
    if (vs.length === 0) throw new Error('未解析到正式版目录');
    const pick = vs[0]!;
    tool.sample = { version: pick, url: `${HU}/${pick}/binaries/apache-maven-${pick}-bin.zip` };
    return `解析 ${vs.length} 版(已滤 rc),抽样 ${pick}`;
  });
  if (!tool.sample) return;
  const ver = tool.sample.version;
  const zipName = `apache-maven-${ver}-bin.zip`;

  // 2. 校验和:镜像目录【无】sidecar,需回官方 dlcdn → archive.apache.org(.sha512)
  let expected512: string | undefined;
  const expected = await step(tool, '校验和取回(dlcdn .sha512,回退 archive.apache.org)', async () => {
    const paths = [
      `https://dlcdn.apache.org/maven/maven-3/${ver}/binaries/${zipName}.sha512`,
      `https://archive.apache.org/dist/maven/maven-3/${ver}/binaries/${zipName}.sha512`,
    ];
    for (const p of paths) {
      try {
        const txt = await fetchText(p, 45_000);
        const m = txt.trim().match(/^([0-9a-f]{128})/i);
        if (m) {
          expected512 = m[1]!.toLowerCase();
          return `来源 ${new URL(p).hostname} sha512=${expected512.slice(0, 12)}…`;
        }
      } catch {
        /* 试下一个来源 */
      }
    }
    throw new Error('两处官方源均取不到 .sha512');
  });
  void expected;

  await step(tool, 'zip 文件 Range 探测', () => rangeProbe(tool.sample!.url));

  // 3. 真实下载 + SHA512 比对(镜像字节 == 官方字节 才算成立)
  if (!QUICK && expected512) {
    await step(tool, `真实下载(~10MB)与 SHA512 比对 ${ver}`, async () => {
      const r = await downloadAndHash(tool.sample!.url);
      const speed = (r.bytes / 1048576 / (r.ms / 1000)).toFixed(1);
      if (r.sha512 !== expected512!.toLowerCase()) throw new Error(`校验失败 期望 ${expected512!.slice(0, 12)}… 实际 ${r.sha512.slice(0, 12)}…`);
      tool.sample!.sha256 = r.sha256;
      tool.sample!.sizeBytes = r.bytes;
      return `匹配 ${r.sha512.slice(0, 12)}… 顺带 sha256=${r.sha256.slice(0, 12)}… ${speed}MB/s`;
    });
  }
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  log(`DevKit M0 镜像探测 | node ${process.version} | 模式 ${QUICK ? 'quick(不下载大包)' : 'full'}`);
  const t0 = Date.now();
  await probeNode();
  await probeJdk();
  await probeMaven();

  const evidence = {
    probedAt: new Date().toISOString(),
    node: process.version,
    mode: QUICK ? 'quick' : 'full',
    durationMs: Date.now() - t0,
    allGreen: !hadFailure,
    tools: results,
  };
  await writeFile(new URL('../m0-results.json', import.meta.url), JSON.stringify(evidence, null, 2), 'utf8');

  log('\n== 汇总 ==');
  for (const t of results) {
    const bad = t.steps.filter((s) => !s.ok);
    log(`  ${bad.length === 0 ? '✅' : '❌'} ${t.id}:${t.steps.length} 步,失败 ${bad.length}`);
    for (const b of bad) log(`      ↳ ${b.name}: ${b.detail}`);
  }
  log(`  证据已写入 m0-results.json(${(Date.now() - t0) / 1000}s)`);
  process.exit(hadFailure ? 1 : 0);
}

main().catch((e) => {
  log(`探测脚本自身异常:${e?.stack ?? e}`);
  process.exit(2);
});
