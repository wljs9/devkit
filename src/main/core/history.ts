/**
 * 操作日志(技术手册 §9):userData\history.jsonl 追加写。
 * 读容忍坏行(崩溃可能截断末行,跳过而非全弃)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from './errors';

export type HistoryKind = 'install' | 'uninstall' | 'switch' | 'env_write' | 'env_restore' | 'download';

export interface HistoryEntry {
  ts: string;
  kind: HistoryKind;
  ok: boolean;
  durationMs: number;
  detail: Record<string, unknown>;
  /** 环境类操作关联的备份文件名(§7.2①),供历史页 [回滚] */
  backupFile?: string;
}

const KINDS: ReadonlySet<string> = new Set(['install', 'uninstall', 'switch', 'env_write', 'env_restore', 'download']);

export class HistoryLog {
  constructor(readonly file: string) {}

  append(entry: Omit<HistoryEntry, 'ts'> & { ts?: string }): HistoryEntry {
    const full: HistoryEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
    if (!KINDS.has(full.kind)) throw new CoreError('bad-history-kind', `未知操作类型:${full.kind}`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  /** 新→旧;可按类型过滤与限量 */
  list(filter?: { kind?: HistoryKind; limit?: number }): HistoryEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    const out: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < (filter?.limit ?? Infinity); i--) {
      try {
        const e = JSON.parse(lines[i]!) as HistoryEntry;
        if (KINDS.has(e.kind) && typeof e.ts === 'string' && (!filter?.kind || e.kind === filter.kind)) out.push(e);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  }
}
