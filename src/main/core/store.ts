/**
 * JSON 抽象仓储(技术手册 §9,替代原 SQLite 决策)。
 * 写协议:序列化 → 写 <file>.tmp → rename 原子替换;每次写前把现存文件保留为 .bak。
 * 读损坏:从 .bak 恢复并置 recovered 标记(UI 提示);两者皆坏 → 抛 store-corrupt。
 * 将来换 SQLite 只需替换本文件实现。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from './errors';

export interface InstallRecord {
  id: string;
  tool: string;
  version: string;
  /** tools\<tool>\<version> 真实目录 */
  path: string;
  sourceId: string;
  sourceUrl: string;
  sha256: string;
  size: number;
  /** ISO 字符串(§12:时间一律 ISO) */
  installedAt: string;
  isCurrent: boolean;
}

export interface CatalogCacheEntry {
  fetchedAt: string;
  versions: unknown[];
}

export interface DevkitData {
  installs: InstallRecord[];
  settings: Record<string, unknown>;
  catalogCache: Record<string, CatalogCacheEntry>;
}

export function emptyData(): DevkitData {
  return { installs: [], settings: {}, catalogCache: {} };
}

export class JsonRepository {
  readonly file: string;
  /** 本次 load 是否走了 .bak 恢复(UI 据此弹提示) */
  recoveredFromBackup = false;

  constructor(file: string) {
    this.file = file;
  }

  load(): DevkitData {
    this.recoveredFromBackup = false;
    const direct = this.tryRead(this.file);
    if (direct !== undefined) return validateData(direct);
    const bak = this.tryRead(this.bakFile);
    if (bak !== undefined) {
      this.recoveredFromBackup = true;
      return validateData(bak);
    }
    if (!fs.existsSync(this.file) && !fs.existsSync(this.bakFile)) return emptyData();
    throw new CoreError('store-corrupt', `数据文件损坏且无可用备份:${this.file}`);
  }

  save(data: DevkitData): void {
    validateData(data); // 写前校验,坏数据不落盘
    const json = JSON.stringify(data, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, this.bakFile); // 保留上一份(§9)
    }
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.file); // Windows rename 允许覆盖既有文件
  }

  /** 读-改-写单事务式便捷口(M1 内无并发写者:仅主进程调用) */
  update(fn: (d: DevkitData) => DevkitData): DevkitData {
    const next = fn(this.load());
    this.save(next);
    return next;
  }

  get bakFile(): string {
    return `${this.file}.bak`;
  }

  private tryRead(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** 轻量结构校验(M1 手写;M2 与 shared 层合并后换 zod) */
function validateData(v: unknown): DevkitData {
  const d = v as Partial<DevkitData> | null;
  if (
    d === null || typeof d !== 'object' ||
    !Array.isArray(d.installs) || typeof d.settings !== 'object' || d.settings === null ||
    typeof d.catalogCache !== 'object' || d.catalogCache === null
  ) {
    throw new CoreError('store-invalid', '仓储结构不合法(顶层字段缺失)');
  }
  for (const it of d.installs) {
    if (typeof it?.id !== 'string' || typeof it?.tool !== 'string' || typeof it?.version !== 'string' || typeof it?.path !== 'string') {
      throw new CoreError('store-invalid', 'installs 记录缺必备字段');
    }
  }
  return d as DevkitData;
}
