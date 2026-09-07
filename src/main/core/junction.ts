/**
 * current\ 层的目录联接(技术手册 §7.3)。
 * 零依赖:fs.symlinkSync(..., 'junction') 普通用户即可创建,无需管理员。
 * ★ 安全红线:删除只许经本模块 removeJunction(lstat 判链 + rmdir 断链),
 *   任何递归删除入口(rm -r / rimraf)严禁先接触链接路径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from './errors';

export interface LinkState {
  exists: boolean;
  /** 是否符号链接/Junction(reparse point 在 Node 均报 isSymbolicLink) */
  isLink: boolean;
  /** 链接指向(readlink 原值) */
  linkTarget?: string;
  /** 解析后的真实路径(仅链接存在时) */
  realTarget?: string;
}

export function inspectLink(linkPath: string): LinkState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(linkPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, isLink: false };
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(linkPath);
    let real: string | undefined;
    try {
      real = fs.realpathSync(linkPath);
    } catch {
      /* 悬空链接:realTarget 留空 */
    }
    return { exists: true, isLink: true, linkTarget: target, realTarget: real };
  }
  return { exists: true, isLink: false };
}

/**
 * 确保 linkPath 指向 targetDir(幂等:已正确指向则什么都不做)。
 * 若 linkPath 是【真实】文件/目录 → 抛 link-blocked,绝不静默覆盖用户数据。
 */
export function ensureJunction(linkPath: string, targetDir: string): { created: boolean } {
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new CoreError('bad-junction-target', `Junction 目标必须是已存在目录:${targetDir}`, { targetDir });
  }
  const want = fs.realpathSync(targetDir);
  const state = inspectLink(linkPath);
  if (state.isLink) {
    if (state.realTarget && pathsEqual(state.realTarget, want)) return { created: false };
    removeJunction(linkPath);
  } else if (state.exists) {
    throw new CoreError('link-blocked', `路径已被真实目录/文件占用,拒绝接管:${linkPath}`, { linkPath });
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(want, linkPath, 'junction');
  return { created: true };
}

/** 切换指向:语义等价 ensureJunction,单列以表达"秒级切换"意图(§6) */
export function switchJunction(linkPath: string, newTargetDir: string): { changed: boolean } {
  const r = ensureJunction(linkPath, newTargetDir);
  return { changed: r.created };
}

/**
 * 断链删除。第一行即 lstat 判链(技术手册 §7.3 卸载红线):
 * 非链接 → 抛 junction-expected,防止任何调用方误把真实目录交进来"删除"。
 * 目标不存在(悬空链)也可删:readlink/lstat 不依赖目标。
 */
export function removeJunction(linkPath: string): void {
  const st = safeLstat(linkPath);
  if (st === null) return; // 幂等:本来就不在
  if (!st.isSymbolicLink()) {
    throw new CoreError('junction-expected', `不是链接,拒绝删除(防误删真实目录):${linkPath}`, { linkPath });
  }
  fs.rmdirSync(linkPath); // 只断链,不触目标
}

/** 供 install.ts 卸载前置守卫:该路径是否为可安全递归删除的真实目录 */
export function assertDeletableRealDir(p: string): void {
  const st = safeLstat(p);
  if (st === null) return; // 不存在 → 卸载按"已无文件"处理
  if (st.isSymbolicLink()) {
    throw new CoreError('junction-expected', `待删路径是链接而非真实目录:${p}`, { p });
  }
}

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function pathsEqual(a: string, b: string): boolean {
  return a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');
}
