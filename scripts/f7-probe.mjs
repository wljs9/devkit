#!/usr/bin/env node
/**
 * ★ F7 评估轮(2026-10-17)· 候选工具镜像/校验探测。
 * 沿用 F5/F6 判据,四项实证一次跑完:
 *   zip  —— Range bytes=0-3,验 PK 魔数(504b0304);只看状态码不算数
 *   bin  —— Range bytes=0-1,验 MZ 魔数(4d5a)
 *   any  —— 只取前几字节看真实格式(gzip 1f8b / PK / MZ / tar)
 *   dir  —— 整页拉取,报字节数 + <a href> 链接数(华为云 SPA 兜底页 ≈12KB 且零链接);可带 grep 列出条目
 *   sha  —— 校验侧车,报状态码 + 字节数 + 正文片段
 * ★ 必须走 curl:Node 原生 fetch 在本机被沙箱代理污染(403/501/魔数错乱),状态码与字节都不可信。
 * 用法:node scripts/f7-probe.mjs <probes.json> [并发数]
 * probes.json:[{ "id","kind","url","note"?,"grep"?,"n"? }]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const CONC = Number(process.argv[3] ?? 6);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-'));
const MAXDIR = 600_000;

const MAGIC = {
  '504b0304': 'PK zip',
  '4d5a': 'MZ exe',
  '1f8b': 'gzip(tar.gz)',
  '1f9d': 'compress',
  '425a68': 'bzip2',
  'fd377a585a00': 'xz',
  '213c617263683e': 'ar(deb)',
  'edabeedb': 'rpm',
};

function magicText(buf) {
  const hex = buf.subarray(0, 8).toString('hex');
  for (const [k, v] of Object.entries(MAGIC)) if (hex.startsWith(k)) return `${v} [${hex.slice(0, 8)}]`;
  return `? [${hex.slice(0, 8)}] ${JSON.stringify(buf.subarray(0, 24).toString('latin1'))}`;
}

async function run(p) {
  const body = path.join(TMP, `${p.id}.bin`);
  const range = p.kind === 'zip' ? '0-3' : p.kind === 'bin' ? '0-1' : p.kind === 'any' ? '0-7' : '';
  // ★ 不设自定义 UA:TUNA 对 Mozilla UA 返回 403(假阴性),默认 curl UA 才是真值
  const args = ['-sS', '--max-time', String(process.env.PROBE_TIMEOUT ?? 30), '-L', '-o', body, '-w', '%{http_code}|%{size_download}|%{url_effective}'];
  if (p.ua) args.push('-A', p.ua);
  if (range) args.push('-r', range);
  if (p.kind === 'dir') args.push('--max-filesize', String(MAXDIR));
  args.push(p.url);
  let meta = '';
  try {
    const { stdout } = await pexec('curl', args, { maxBuffer: 1 << 20 });
    meta = stdout.trim();
  } catch (e) {
    meta = `ERR|${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 90)}|`;
  }
  const [status, size, effUrl = ''] = meta.split('|');
  const buf = fs.existsSync(body) ? fs.readFileSync(body) : Buffer.alloc(0);
  let verdict = '';
  if (p.kind === 'dir' || p.kind === 'sha') {
    const txt = buf.toString('utf8');
    const links = (txt.match(/<a\s+href=/gi) ?? []).length;
    if (p.kind === 'dir') {
      verdict = links === 0 ? `非目录页(正文 ${buf.length}B,零链接)` : `目录页 ${links} 链接 / ${buf.length}B`;
    } else {
      verdict = `${buf.length}B :: ${txt.trim().replace(/\s+/g, ' ').slice(0, 60)}`;
    }
  } else {
    verdict = magicText(buf);
  }
  let hits = '';
  if (p.grep) {
    const txt = buf.toString('utf8');
    const re = new RegExp(p.grep, 'g');
    const found = [...txt.matchAll(re)].map((m) => m[1] ?? m[0]);
    hits = `\n     命中(${found.length}): ${found.slice(0, p.n ?? 8).join(' , ')}`;
  }
  return { p, status, size, effUrl, verdict, hits };
}

const out = [];
let i = 0;
await Promise.all(
  Array.from({ length: Math.min(CONC, spec.length) }, async () => {
    while (i < spec.length) out.push(await run(spec[i++]));
  }),
);

for (const r of out) {
  const ok = /^2\d\d$/.test(r.status);
  console.log(`${ok ? 'OK ' : 'NG '}[${r.p.id}] ${r.status} ${r.verdict}${r.size && r.p.kind === 'dir' ? '' : ` (${r.size}B)`}`);
  if (r.effUrl && r.effUrl !== r.p.url) console.log(`     → ${r.effUrl.slice(0, 110)}`);
  if (r.hits) console.log(r.hits);
  if (r.p.note) console.log(`     # ${r.p.note}`);
}
console.log(`\n汇总:${out.filter((r) => /^2\d\d$/.test(r.status)).length}/${out.length} 可用`);