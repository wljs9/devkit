/** 测试夹具:支持 Range 开关/限速分块/请求记录的本地 HTTP 服务器。 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  close(): Promise<void>;
  /** 收到的每个请求的路径与 Range 头 */
  requests: { path: string; range?: string }[];
  maxConcurrent: () => number;
}

export interface ServeOptions {
  /** 返回 200 而无视 Range(模拟不支持断点的服务器) */
  ignoreRange?: boolean;
  etag?: string;
  /** 每 chunk 之间延迟毫秒(chunkSize 默认 64KB) */
  chunkDelayMs?: number;
  chunkSize?: number;
  /** 指定路径返回状态码(如 /x 403) */
  statusOverride?: (path: string) => number | undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startFileServer(content: Buffer, filename: string, opts: ServeOptions = {}): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  let inflight = 0;
  let peak = 0;
  const srv: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    inflight++;
    peak = Math.max(peak, inflight);
    requests.push({ path, range: req.headers.range });
    try {
      const ov = opts.statusOverride?.(path);
      if (ov) {
        res.statusCode = ov;
        res.end('nope');
        return;
      }
      if (!path.endsWith(filename)) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      const etag = opts.etag ?? '"t1"';
      const m = req.headers.range?.match(/^bytes=(\d+)-$/);
      if (m && !opts.ignoreRange) {
        const start = Number(m[1]);
        if (start >= content.length) {
          res.statusCode = 416;
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${content.length - 1}/${content.length}`);
        res.setHeader('Content-Length', content.length - start);
        res.setHeader('ETag', etag);
        const cs = opts.chunkSize ?? 64 * 1024;
        for (let p = start; p < content.length; p += cs) {
          const ok = res.write(content.subarray(p, Math.min(p + cs, content.length)));
          if (opts.chunkDelayMs) {
            if (!ok) await new Promise<void>((r) => res.once('drain', () => r()));
            await sleep(opts.chunkDelayMs);
          }
        }
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Length', content.length);
      res.setHeader('ETag', etag);
      const cs = opts.chunkSize ?? 64 * 1024;
      for (let p = 0; p < content.length; p += cs) {
        const ok = res.write(content.subarray(p, Math.min(p + cs, content.length)));
        if (opts.chunkDelayMs) {
          if (!ok) await new Promise<void>((r) => res.once('drain', () => r()));
          await sleep(opts.chunkDelayMs);
        }
      }
      res.end();
    } finally {
      inflight--;
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
    requests,
    maxConcurrent: () => peak,
  };
}

export async function stubResponses(map: Record<string, string>): Promise<{ fn: typeof fetch; urls: string[] }> {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const u = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    urls.push(u);
    const body = map[u];
    if (body === undefined) return new Response('not stubbed', { status: 418 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
  return { fn, urls };
}
