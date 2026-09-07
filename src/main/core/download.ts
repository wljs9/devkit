/**
 * 下载队列(技术手册 §7.4)。
 * - 内置 fetch:响应流 → 写 *.part;已存在 part 带 Range 续传(206 追加 / 200 或 etag 变 → 清头重下);
 * - SHA256+SHA512 边下边增量算,续传场景从 0 重放 part 文件补算(一次顺序 I/O,内存安全);
 * - 取消 = 保留 part + 写 *.part.json(size/url/etag),重试点亮"续";
 * - 并发上限 2;错误分类(§7.4)决定提示文案与 [换源] 可用性。
 * 产物落 DevRoot\cache(与 tools 同盘),完成后由 install.ts 原子搬移;校验失败清 part。
 */
import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from './errors';
import { partPaths } from './paths';

export type HashAlgo = 'sha256' | 'sha512';

export interface DownloadSpec {
  id: string;
  url: string;
  /** 产物文件名(part 由此派生) */
  fileName: string;
  expected?: { algo: HashAlgo; hex: string };
}

export interface PartMeta {
  size: number;
  url: string;
  etag?: string;
  savedAt: string;
}

export interface DownloadProgress {
  received: number;
  /** -1 表示服务端未给长度 */
  total: number;
  /** 字节/秒 */
  speed: number;
}

export interface DownloadOutcome {
  /** 完成后的 .part 路径(保持原名,由消费方搬移) */
  partPath: string;
  sha256: string;
  sha512: string;
  bytes: number;
  resumedFrom: number;
}

export type DownloadErrorKind = 'net-dns' | 'net-tls' | 'net-timeout' | 'net-connect' | 'http-status' | 'checksum-mismatch' | 'aborted' | 'io';

export class DownloadError extends CoreError {
  readonly kind: DownloadErrorKind;
  readonly status?: number;
  /** 该错误下 [换源] 是否值得提供(§7.4) */
  readonly switchable: boolean;

  constructor(kind: DownloadErrorKind, message: string, context?: Record<string, unknown>) {
    super(`download-${kind}`, message, context);
    this.name = 'DownloadError';
    this.kind = kind;
    this.status = context?.status as number | undefined;
    this.switchable = Boolean(context?.switchable);
  }
}

/** 把 fetch/IO 异常归类(§7.4) */
export function classifyNetworkError(e: unknown): DownloadErrorKind {
  const chain = [e, (e as { cause?: unknown })?.cause, (e as { cause?: { code?: string } })?.cause?.code]
    .map((x) => String((x as { code?: string })?.code ?? x))
    .join(' ');
  if (/ENOTFOUND|EAI_|getaddrinfo/i.test(chain)) return 'net-dns';
  if (/CERT|TLS|SSL|ERR_TLS|unable_to_verify|self.signed/i.test(chain)) return 'net-tls';
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ENETDOWN|ENETUNREACH|EHOSTUNREACH/i.test(chain)) return 'net-connect';
  if (/AbortError|timeout/i.test(chain)) return 'net-timeout';
  return 'io';
}

export interface DownloaderOptions {
  devRoot: string;
  /** §7.4:2 */
  maxConcurrent?: number;
  fetchImpl?: typeof fetch;
}

export class Downloader {
  private readonly maxConcurrent: number;
  private readonly fetchImpl: typeof fetch;
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiters: (() => void)[] = [];
  private active = 0;

  constructor(private readonly opts: DownloaderOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get activeIds(): string[] {
    return [...this.controllers.keys()];
  }

  /** 发起(或续传)下载;resolve 时哈希校验已通过 */
  async start(spec: DownloadSpec, onProgress?: (p: DownloadProgress) => void): Promise<DownloadOutcome> {
    if (this.controllers.has(spec.id)) throw new CoreError('download-duplicate', `任务已在下载中:${spec.id}`);
    await this.acquireSlot();
    const controller = new AbortController();
    this.controllers.set(spec.id, controller);
    try {
      return await this.dl(spec, controller.signal, onProgress);
    } finally {
      this.controllers.delete(spec.id);
      this.releaseSlot();
    }
  }

  /** 取消:中断流,保留 part+meta(下次自动续)。返回是否命中运行中任务 */
  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort(new Error('user-cancel'));
    return true;
  }

  /** 已有断点?(供 UI 点亮"续"按钮,§7.4) */
  peekResumable(fileName: string, url: string): { bytes: number; meta: PartMeta } | null {
    const { part, meta } = partPaths(this.opts.devRoot, fileName);
    if (!fs.existsSync(part) || !fs.existsSync(meta)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as PartMeta;
      if (m.url !== url) return null;
      return { bytes: Math.min(fs.statSync(part).size, m.size), meta: m };
    } catch {
      return null;
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private async dl(spec: DownloadSpec, signal: AbortSignal, onProgress?: (p: DownloadProgress) => void): Promise<DownloadOutcome> {
    const { part, meta } = partPaths(this.opts.devRoot, spec.fileName);
    fs.mkdirSync(path.dirname(part), { recursive: true });

    let resumeFrom = this.peekResumable(spec.fileName, spec.url)?.bytes ?? 0;
    if (resumeFrom === 0) {
      fs.rmSync(part, { force: true }); // 孤儿 part(无 meta)不可信
      fs.rmSync(meta, { force: true });
    }

    let userCancelled = false;
    signal.addEventListener('abort', () => { userCancelled = true; }, { once: true });

    const headers: Record<string, string> = { 'User-Agent': 'DevKit/0.1' };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    let res: Response;
    try {
      res = await this.fetchImpl(spec.url, { headers, redirect: 'follow', signal });
    } catch (e) {
      throw userCancelled
        ? this.saveBreakpointAndAbort(spec, part, meta, undefined)
        : this.wrapNetwork(e, spec.url);
    }

    // —— 判定本次响应是【续传】还是【从头】(§7.4:206 续 / 200 清头重下)
    const resumable: { meta: PartMeta | undefined } = { meta: this.peekResumable(spec.fileName, spec.url)?.meta };
    let useResume = res.status === 206 && resumeFrom > 0;
    if (useResume && resumable.meta?.etag) {
      const etag = res.headers.get('etag');
      if (etag && etag !== resumable.meta.etag) useResume = false; // 源内容变了
    }
    if (resumeFrom > 0 && !useResume) {
      await res.body?.cancel().catch(() => undefined);
      fs.rmSync(part, { force: true });
      fs.rmSync(meta, { force: true });
      if (!res.ok) throw this.httpError(res, spec); // 重下也要状态码干净
      return this.dl(spec, signal, onProgress); // 已清断点,递归走 fresh 分支
    }
    if (!res.ok && res.status !== 206) throw this.httpError(res, spec);

    // —— 哈希:续传先重放已有 part 补算(一次顺序 I/O)
    const h256 = createHash('sha256');
    const h512 = createHash('sha512');
    if (useResume) this.replayIntoHashers(part, resumeFrom, h256, h512);

    const etag = res.headers.get('etag') ?? undefined;
    const total = useResume
      ? (contentRangeTotal(res.headers.get('content-range')) ?? (Number(res.headers.get('content-length')) || 0) + resumeFrom)
      : Number(res.headers.get('content-length') ?? -1);
    const receivedBase = useResume ? resumeFrom : 0;
    let written = receivedBase;
    const t0 = Date.now();
    let lastBeat = 0;
    const w = fs.createWriteStream(part, { flags: useResume ? 'a' : 'w' });
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        h256.update(chunk);
        h512.update(chunk);
        written += chunk.byteLength;
        if (!w.write(chunk)) await once(w, 'drain');
        if (written - lastBeat >= 256 * 1024) {
          lastBeat = written;
          onProgress?.({ received: written, total: total > 0 ? total : -1, speed: (written - receivedBase) / Math.max((Date.now() - t0) / 1000, 0.001) });
        }
      }
      await closeStream(w);
    } catch (e) {
      await closeStream(w).catch(() => undefined);
      // 断链/取消都保留断点(产品文档 §4.2:网络中断恢复后从断点续),part 前缀总是有效顺序写
      const bp = this.saveBreakpointAndAbort(spec, part, meta, etag);
      if (userCancelled) throw bp;
      const net = this.wrapNetwork(e, spec.url);
      net.context = { ...net.context, breakpointBytes: (bp.context as { bytes?: number })?.bytes };
      throw net;
    }
    onProgress?.({ received: written, total: total > 0 ? total : written, speed: (written - receivedBase) / Math.max((Date.now() - t0) / 1000, 0.001) });

    // —— 校验(§3.5:不匹配默认拒绝 → 清 part 强制重下)
    const sha256 = h256.digest('hex');
    const sha512 = h512.digest('hex');
    if (spec.expected) {
      const got = spec.expected.algo === 'sha256' ? sha256 : sha512;
      if (got !== spec.expected.hex.toLowerCase()) {
        fs.rmSync(part, { force: true });
        fs.rmSync(meta, { force: true });
        throw new DownloadError('checksum-mismatch', `校验和不匹配(${spec.expected.algo}):${spec.url}`, {
          expected: spec.expected.hex, got, switchable: true,
        });
      }
    }
    fs.rmSync(meta, { force: true });
    return { partPath: part, sha256, sha512, bytes: written, resumedFrom: useResume ? resumeFrom : 0 };
  }

  /** 中断时落断点档案(§7.4:保留 part + 写 part.json) */
  private saveBreakpointAndAbort(spec: DownloadSpec, part: string, metaPath: string, etag: string | undefined): DownloadError {
    const size = currentSize(part);
    const m: PartMeta = { size, url: spec.url, etag, savedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
    } catch {
      /* meta 写失败不掩取消语义 */
    }
    return new DownloadError('aborted', '已取消,断点已保留', { part, bytes: size });
  }

  private httpError(res: Response, spec: DownloadSpec): DownloadError {
    return new DownloadError('http-status', `HTTP ${res.status} ${spec.url}`, {
      status: res.status, url: spec.url,
      // §7.4:403/5xx 提示换源;404 多半是镜像删版本,也值得换
      switchable: res.status === 403 || res.status === 404 || res.status >= 500,
    });
  }

  private wrapNetwork(e: unknown, url: string): DownloadError {
    const kind = classifyNetworkError(e);
    return new DownloadError(kind, `网络错误(${kind}):${url}`, { url, cause: String(e) });
  }

  private replayIntoHashers(part: string, limit: number, h256: Hash, h512: Hash): void {
    const fd = fs.openSync(part, 'r');
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let pos = 0;
      while (pos < limit) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit - pos), pos);
        if (n <= 0) break;
        h256.update(buf.subarray(0, n));
        h512.update(buf.subarray(0, n));
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

function currentSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function contentRangeTotal(header: string | null): number | undefined {
  const m = header?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : undefined;
}

function once(w: fs.WriteStream, ev: 'drain'): Promise<void> {
  return new Promise((resolve) => w.once(ev, () => resolve()));
}

function closeStream(w: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    w.once('error', reject);
    w.end(() => resolve());
  });
}
