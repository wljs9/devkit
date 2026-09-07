#!/usr/bin/env node
/**
 * 稳妥地补全 Electron 预编译二进制(CLAUDE.md M2 注意:本机 GitHub 不可直连 → 走 npmmirror)。
 * 背景(实测 2026-09-07):@electron/get + 包内 extract-zip 在本机对 ~130MB 包解压会在 locales 后静默停住,
 *   故本脚本改为【下载 + 调用系统 bsdtar 流式解压】,不依赖第三方解压库,可重复执行。
 * 用法:pnpm bin:electron(装好 electron npm 包后)
 * 环境变量:ELECTRON_MIRROR 覆盖镜像基址(默认 npmmirror)。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MIRROR = (process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/').replace(/\/+$/, '');
const electronPkgDir = path.resolve('node_modules/electron');
const pkgFile = path.join(electronPkgDir, 'package.json');
if (!fs.existsSync(pkgFile)) {
  console.error('未找到 node_modules/electron —— 先跑 pnpm install');
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;

const platform = process.platform; // win32 | darwin | linux
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
const url = `${MIRROR}/v${version}/${fileName}`;
const exeName = platform === 'win32' ? 'electron.exe' : 'electron';
const zipPath = path.join(os.tmpdir(), fileName);
const distDir = path.join(electronPkgDir, 'dist');

if (fs.existsSync(path.join(distDir, exeName))) {
  console.log(`Electron ${version} 二进制已就位,跳过。`);
  process.exit(0);
}

// 复用已存在的完整临时包,避免重复下载(本机网络对大包偶发 ECONNRESET)
const existing = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
if (existing > 20_000_000) {
  console.log(`复用已下载的完整包(${existing}B)`);
} else {
  console.log(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`下载失败 HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20_000_000) {
    console.error(`下载内容过小(${buf.length}B),疑似不是完整包 —— 中止`);
    process.exit(1);
  }
  fs.writeFileSync(zipPath, buf);
  console.log(`已下载 ${buf.length} 字节 → ${zipPath}`);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Windows 下 git-bash 的 tar 是 GNU 版(不支持 zip、且把 C:\ 当远程主机),故用系统 PowerShell 原生解压。
// 内联 -Command(非入库 .ps1),不受 §7.1 BOM 约束。
console.log('用 PowerShell Expand-Archive 解压…');
const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force`],
  { stdio: 'inherit' },
);
if (ps.status !== 0) {
  console.error(`Expand-Archive 失败(exit ${ps.status})`);
  process.exit(1);
}

// zip 内文件平铺在 dist/;electron.d.ts 需上移到包根(electron 的 npm index 约定)
const dts = path.join(distDir, 'electron.d.ts');
if (fs.existsSync(dts)) fs.renameSync(dts, path.join(electronPkgDir, 'electron.d.ts'));
fs.writeFileSync(path.join(electronPkgDir, 'path.txt'), exeName);
fs.rmSync(zipPath, { force: true });

if (!fs.existsSync(path.join(distDir, exeName))) {
  console.error('解压后仍无 ' + exeName + ' —— 请检查杀毒软件/权限是否拦截 dist/');
  process.exit(1);
}
console.log(`✓ Electron ${version} 二进制就绪:dist/${exeName}`);
console.log('  现在可 `pnpm dev` 启动界面做 Node 全链路走查。');
