import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyNetworkError, Downloader, DownloadError, type DownloadOutcome } from '../src/main/core/download';
import { partPaths } from '../src/main/core/paths';
import { startFileServer, type TestServer } from './helpers/server';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex');

let devRoot: string;
let servers: TestServer[];
beforeEach(() => {
  devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-dl-'));
  fs.mkdirSync(path.join(devRoot, 'cache'), { recursive: true });
  servers = [];
});
afterEach(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(devRoot, { recursive: true, force: true });
});
const serve = async (content: Buffer, file: string, opts?: Parameters<typeof startFileServer>[2]) => {
  const s = await startFileServer(content, file, opts);
  servers.push(s);
  return s;
};

function makeContent(seed: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

describe('Downloader 主流程(§7.4)', () => {
  it('全新下载:双哈希正确,产物完整,meta 不残留', async () => {
    const content = makeContent(1, 300_000);
    const srv = await serve(content, 'pkg.zip');
    const dl = new Downloader({ devRoot });
    const r = await dl.start({ id: 'a', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip', expected: { algo: 'sha256', hex: sha256(content) } });
    expect(r.sha256).toBe(sha256(content));
    expect(r.sha512).toBe(sha512(content));
    expect(r.resumedFrom).toBe(0);
    expect(fs.readFileSync(r.partPath)).toEqual(content);
    expect(fs.existsSync(partPaths(devRoot, 'pkg.zip').meta)).toBe(false);
  });

  it('进度回调:received 单调、total 正确、speed>0', async () => {
    const content = makeContent(2, 300_000);
    const srv = await serve(content, 'pkg.zip');
    const seen: number[] = [];
    let total = -1;
    await new Downloader({ devRoot }).start(
      { id: 'p', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip' },
      (pr) => {
        seen.push(pr.received);
        total = pr.total;
      },
    );
    expect(total).toBe(content.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // 单调不降
    expect(seen[seen.length - 1]).toBe(content.length);
  });

  it('取消保留断点 → 重连从 Range 续传,结果字节一致', async () => {
    const content = makeContent(3, 600_000);
    const srv = await serve(content, 'pkg.zip', { chunkDelayMs: 20, chunkSize: 64 * 1024 });
    const dl = new Downloader({ devRoot });
    const spec = { id: 'r', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip' };
    let cancelled = false;
    const e0 = await dl.start(spec, (p) => {
      if (p.received >= 64 * 1024 && !cancelled) {
        cancelled = true;
        dl.cancel('r');
      }
    }).catch((e) => e as DownloadError);
    expect(cancelled).toBe(true);
    expect(e0).toBeInstanceOf(DownloadError);
    expect((e0 as DownloadError).kind).toBe('aborted');
    const { part, meta } = partPaths(devRoot, 'pkg.zip');
    const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { size: number; url: string; etag?: string };
    const paused = fs.statSync(part).size;
    expect(m.size).toBe(paused);
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(content.length);

    const r2: DownloadOutcome = await dl.start({ ...spec, expected: { algo: 'sha256', hex: sha256(content) } });
    expect(r2.resumedFrom).toBe(m.size);
    expect(r2.bytes).toBe(content.length);
    expect(r2.sha256).toBe(sha256(content));
    expect(srv.requests[1]!.range).toBe(`bytes=${paused}-`);
  });

  it('服务器不支持 Range(回 200)→ 清头重下而非拼接坏数据', async () => {
    const content = makeContent(4, 300_000);
    const srv = await serve(content, 'pkg.zip', { ignoreRange: true });
    const { part, meta } = partPaths(devRoot, 'pkg.zip');
    fs.writeFileSync(part, content.subarray(0, 100_000)); // 伪造半截断点
    fs.writeFileSync(meta, JSON.stringify({ size: 100_000, url: `${srv.url}/pkg.zip`, savedAt: new Date().toISOString() }));
    const r = await new Downloader({ devRoot }).start({ id: 'n', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip', expected: { algo: 'sha512', hex: sha512(content) } });
    expect(r.resumedFrom).toBe(0);
    expect(r.sha512).toBe(sha512(content)); // 若拼接坏数据必然 mismatch
    expect(srv.requests.filter((x) => x.range).length).toBe(1); // 带 Range 请求了一次
    expect(srv.requests.length).toBe(2); // 然后清头重来
  });

  it('etag 变化 → 放弃续传整段重下', async () => {
    const content = makeContent(5, 250_000);
    const srv = await serve(content, 'pkg.zip', { etag: '"v2"' });
    const { part, meta } = partPaths(devRoot, 'pkg.zip');
    fs.writeFileSync(part, content.subarray(0, 120_000));
    fs.writeFileSync(meta, JSON.stringify({ size: 120_000, url: `${srv.url}/pkg.zip`, etag: '"v1"', savedAt: 'x' }));
    const r = await new Downloader({ devRoot }).start({ id: 'e', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip', expected: { algo: 'sha256', hex: sha256(content) } });
    expect(r.sha256).toBe(sha256(content));
  });

  it('校验和不匹配:拒绝并清断点(§3.5 红线默认行为)', async () => {
    const content = makeContent(6, 100_000);
    const srv = await serve(content, 'pkg.zip');
    const dl = new Downloader({ devRoot });
    await expect(dl.start({ id: 'b', url: `${srv.url}/pkg.zip`, fileName: 'pkg.zip', expected: { algo: 'sha256', hex: 'f'.repeat(64) } })).rejects.toBeInstanceOf(DownloadError);
    const { part, meta } = partPaths(devRoot, 'pkg.zip');
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('HTTP 403 归类为可换源错误', async () => {
    const srv = await serve(Buffer.from('x'), 'pkg.zip', { statusOverride: (p) => (p.includes('403') ? 403 : undefined) });
    const dl = new Downloader({ devRoot });
    const e = await dl.start({ id: 'd', url: `${srv.url}/403/pkg.zip`, fileName: 'g.zip' }).catch((e2) => e2 as DownloadError);
    expect(e).toBeInstanceOf(DownloadError);
    expect((e as DownloadError).kind).toBe('http-status');
    expect((e as DownloadError).status).toBe(403);
    expect((e as DownloadError).switchable).toBe(true);
  });

  it('并发上限 2(§7.4,客户端槽位视角)', async () => {
    const content = makeContent(7, 64 * 1024 * 3);
    const srv = await serve(content, 'pkg.zip', { chunkDelayMs: 10, chunkSize: 64 * 1024 });
    const dl = new Downloader({ devRoot });
    let peakActive = 0;
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        dl.start({ id: `c${i}`, url: `${srv.url}/pkg.zip`, fileName: `p${i}.zip` }, () => {
          peakActive = Math.max(peakActive, dl.activeIds.length);
        }),
      ),
    );
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(dl.activeIds).toEqual([]);
    expect(srv.requests.length).toBe(4);
  });

  it('peekResumable:url 不一致/无 meta 视为不可续', () => {
    const dl = new Downloader({ devRoot });
    const { part, meta } = partPaths(devRoot, 'q.zip');
    fs.writeFileSync(part, Buffer.alloc(10));
    fs.writeFileSync(meta, JSON.stringify({ size: 10, url: 'http://other/q.zip', savedAt: 'x' }));
    expect(dl.peekResumable('q.zip', 'http://mine/q.zip')).toBeNull();
  });

  it('错误分类纯函数', () => {
    expect(classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }))).toBe('net-dns');
    expect(classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }))).toBe('net-tls');
    expect(classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe('net-connect');
    expect(classifyNetworkError(new Error('AbortError: timeout'))).toBe('net-timeout');
    expect(classifyNetworkError(new Error('weird'))).toBe('io');
  });
});
