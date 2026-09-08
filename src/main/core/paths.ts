/**
 * DevRoot 磁盘布局唯一权威(技术手册 §5 / 产品文档 §6)。
 * 铁律:一切路径拼接只许经由本模块,禁散拼 "\\" 字符串。
 */
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { CoreError } from './errors';

// ---------------------------------------------------------------- 默认值与校验

export interface DevRootCheck {
  ok: boolean;
  /** 拒绝理由(不可通过) */
  reasons: string[];
  /** 警告(可继续,UI 需提示) */
  warnings: string[];
}

/** 默认 DevRoot:存在 D 盘用 D:\dev,否则 %USERPROFILE%\dev(产品文档 §6) */
export function defaultDevRoot(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (exists('D:\\')) return join('D:\\', 'dev');
  const home = env.USERPROFILE ?? env.HOME;
  if (!home) throw new CoreError('devroot-unknown-home', '无法确定用户目录(USERPROFILE 缺失)');
  return join(home, 'dev');
}

/** 常见同步盘目录片段(OneDrive/Dropbox 等),命中仅警告——§5:非同步盘目录 */
const SYNC_MARKERS = ['onedrive', 'dropbox', 'google\\ drive', 'googledrive', 'onedesk', 'nutstore', 'syncthing'];

export function checkDevRoot(p: string, env: NodeJS.ProcessEnv = process.env): DevRootCheck {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!isAbsolute(p)) reasons.push(`必须是绝对路径:${p}`);
  // 盘符相对(如 D:dev)在 isAbsolute 为 false,已被拦截
  if (/\s/.test(p)) reasons.push('路径含空格(多版本工具链对空格敏感)');
  if (!/^[\x20-\x7e]+$/.test(p)) reasons.push('路径含非 ASCII 字符(中文/Unicode 会踩各类构建工具坑)');
  const lower = `\\${p.toLowerCase()}\\`;
  if (SYNC_MARKERS.some((m) => lower.includes(`\\${m}\\`) || lower.includes(m))) {
    warnings.push('路径疑似位于同步盘目录内,大量小文件会被同步引擎反复扫描');
  }
  const od = env.OneDrive ?? env.OneDriveConsumer;
  if (od && p.toLowerCase().startsWith(od.toLowerCase())) {
    warnings.push('路径在 OneDrive 之下,建议迁出');
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

// ---------------------------------------------------------------- 布局

/** 版本 → 目录名片段(拒绝路径穿越与 Windows 非法字符;'+ ' 等字符保留) */
export function versionDir(version: string): string {
  const v = version.trim();
  if (!v || v.includes('..') || /[<>:"/\\|?*]/.test(v) || /[. ]$/.test(v)) {
    throw new CoreError('bad-version', `版本名不可作目录名:${version}`);
  }
  return v;
}

export function toolRoot(devRoot: string, toolId: string): string {
  assertToolId(toolId);
  return join(devRoot, 'tools', toolId);
}

export function toolVersionDir(devRoot: string, toolId: string, version: string): string {
  return join(toolRoot(devRoot, toolId), versionDir(version));
}

/** current\<tool> junction 路径(切换 = 只改它) */
export function currentLinkPath(devRoot: string, toolId: string): string {
  assertToolId(toolId);
  return join(devRoot, 'current', toolId);
}

export function cacheDir(devRoot: string): string {
  return join(devRoot, 'cache');
}

/** 断点文件:<cache>/<文件名>.part 与 .part.json(§7.4) */
export function partPaths(devRoot: string, fileName: string): { part: string; meta: string } {
  const safe = fileName.replace(/[<>:"/\\|?*]/g, '_');
  const part = join(cacheDir(devRoot), `${safe}.part`);
  return { part, meta: `${part}.json` };
}

/** 解压暂存目录(与 tools 同盘,保证 rename 原子搬移,§7.5) */
export function extractTempDir(devRoot: string, token: string): string {
  return join(cacheDir(devRoot), `x-${token}`);
}

function assertToolId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CoreError('bad-tool-id', `工具 id 不合法:${id}`);
  }
}

// ---------------------------------------------------------------- 用户 PATH 条目(产品文档 §6:终身 3 条)

export interface EnvPlan {
  /** JAVA_HOME 的值(指向 current\jdk 的绝对路径) */
  javaHome: string;
  /** 追加进用户 PATH 的固定条目(顺序稳定,幂等合并用) */
  pathEntries: string[];
}

/**
 * 三条 PATH 条目 = <DevRoot>\current\node、<DevRoot>\current\maven\bin、%JAVA_HOME%\bin。
 * 前两条用绝对路径(DevRoot 固定后不随变量解析变化,幂等判定精确);
 * 第三条按产品文档 §6 以 %JAVA_HOME% 引用(REG_EXPAND_SZ 由注册表类型保证,§7.1)。
 */
export function envPlan(devRoot: string): EnvPlan {
  return {
    javaHome: currentLinkPath(devRoot, 'jdk'),
    pathEntries: [
      currentLinkPath(devRoot, 'node'),
      join(currentLinkPath(devRoot, 'maven'), 'bin'),
      '%JAVA_HOME%\\bin',
    ],
  };
}

// ---------------------------------------------------------------- PATH 字符串代数(纯函数,可测)

export function splitPathList(value: string): string[] {
  return value.split(';').filter((s) => s.length > 0);
}

export function joinPathList(parts: string[]): string {
  return parts.join(';');
}

/** Windows 路径条目等值:忽略大小写与尾部分隔符 */
export function pathEntryEquals(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\\/]+$/, '');
  return norm(a) === norm(b);
}

/** 幂等追加:已存在(等值)则不动,缺失者按序附加到尾部 */
export function mergePathEntries(currentValue: string, add: string[]): { value: string; changed: boolean; appended: string[] } {
  const parts = splitPathList(currentValue);
  const appended: string[] = [];
  for (const want of add) {
    if (!parts.some((p) => pathEntryEquals(p, want))) {
      parts.push(want);
      appended.push(want);
    }
  }
  return { value: joinPathList(parts), changed: appended.length > 0, appended };
}

/** 移除指定条目(仅等值命中;绝不模糊匹配——红线 3 的底层保障) */
export function removePathEntries(currentValue: string, remove: string[]): { value: string; changed: boolean; removed: string[] } {
  const parts = splitPathList(currentValue);
  const removed: string[] = [];
  const kept = parts.filter((p) => {
    const hit = remove.find((r) => pathEntryEquals(p, r));
    if (hit !== undefined) removed.push(p);
    return hit === undefined;
  });
  return { value: joinPathList(kept), changed: removed.length > 0, removed };
}

/**
 * 展开 PATH 条目里的 %VAR% 引用(大小写不敏感;env 可注入,M3 体检传 process.env)。
 * 表内无此变量 → 原文保留 —— auditPathEntries"含 % 跳过存在性判定"的既有约定不变,
 * 本函数只让它少跳过头(能展开的先展开再判)。M3 env:audit 消费。
 */
export function expandPathVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%;]+)%/g, (all, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = hit === undefined ? undefined : env[hit];
    return v === undefined ? all : v;
  });
}

/** PATH 体检原语(供 env.ts 的 audit 使用):失效项 + 重复项 */
export function auditPathEntries(currentValue: string, exists: (p: string) => boolean = existsSync): {
  total: number;
  missing: string[];
  duplicates: string[][];
} {
  const parts = splitPathList(currentValue);
  const missing: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const p of parts) {
    // %VAR% 开头的条目无法在 core 内展开,交给调用方(注册表读到的 Path 已由系统展开前保留原样,此处跳过存在性判定)
    if (!p.includes('%') && !exists(p) && !missing.some((m) => pathEntryEquals(m, p))) missing.push(p);
    const key = p.toLowerCase().replace(/[\\/]+$/, '');
    const group = byKey.get(key);
    if (group) group.push(p);
    else byKey.set(key, [p]);
  }
  return { total: parts.length, missing, duplicates: [...byKey.values()].filter((g) => g.length > 1) };
}
