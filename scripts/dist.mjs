/**
 * pnpm dist(技术手册 §10"一个脚本跑完"+ M4 出包):typecheck → test → build → electron-builder --win nsis。
 * 任一步非零退出即中止(§11 门禁:测试不绿不出包)。
 * 镜像内置:本机 GitHub 不可直连(§7.6)——
 *   ELECTRON_MIRROR:builder 拉 electron dist zip 走 npmmirror;
 *   ELECTRON_BUILDER_BINARIES_MIRROR:nsis / nsis-resources 等工具链 zip 同样走 npmmirror。
 *   已存在同名缓存(%LOCALAPPDATA%/electron/Cache 等)则命中本地,不重复下载。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const STEPS = [
  ['typecheck(§11 门禁)', ['typecheck']],
  ['test(§11 门禁:不绿不出包)', ['test']],
  ['build(electron-vite 三段)', ['build']],
  ['pack(NSIS,electron-builder)', ['exec', 'electron-builder', '--win', 'nsis']],
];

for (const [label, args] of STEPS) {
  console.log(`\n[dist] ▶ ${label} … pnpm ${args.join(' ')}`);
  const r = spawnSync('pnpm', args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`[dist] ✗ ${label} 失败(exit ${r.status})——中止出包`);
    process.exit(r.status ?? 1);
  }
}

const MB = 1024 * 1024;
const release = 'release';
if (fs.existsSync(release)) {
  for (const f of fs.readdirSync(release).filter((x) => /\.(exe|yml|blockmap)$/i.test(x))) {
    const bytes = fs.statSync(path.join(release, f)).size;
    console.log(`[dist] ✓ ${f}  ${(bytes / MB).toFixed(1)} MB`);
  }
}
console.log('[dist] ✓ 全流程完成。安装器见 release/(NSIS per-user,默认 %LOCALAPPDATA%\\Programs\\DevKit,向导内目录可选)');
