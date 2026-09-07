import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryLog, type HistoryEntry } from '../src/main/core/history';

let log: HistoryLog;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-hist-'));
  log = new HistoryLog(path.join(dir, 'history.jsonl'));
});

const base = { ok: true, durationMs: 12, detail: { tool: 'node' } } as const;

describe('HistoryLog(JSONL 追加写)', () => {
  it('追加并倒序读出;ts 自动 ISO', () => {
    log.append({ ...base, kind: 'install' });
    log.append({ ...base, kind: 'switch', detail: { tool: 'node', version: '22.2.0' } });
    const all = log.list();
    expect(all.length).toBe(2);
    expect(all[0]!.kind).toBe('switch'); // 新→旧
    expect(new Date(all[1]!.ts).toISOString()).toBe(all[1]!.ts);
  });
  it('按类型过滤与限量', () => {
    log.append({ ...base, kind: 'install' });
    log.append({ ...base, kind: 'env_write', ok: false, backupFile: '2026-09-07T00-00-00.json' });
    expect(log.list({ kind: 'env_write' })[0]?.backupFile).toBe('2026-09-07T00-00-00.json');
    expect(log.list({ limit: 1 }).length).toBe(1);
  });
  it('崩溃截断的坏末行:跳过而非全弃;未知类型同样过滤', () => {
    log.append({ ...base, kind: 'download' });
    fs.appendFileSync(log.file, '{"ts":"2026-09-07T00:00:00.000Z","ki', 'utf8'); // 截断行
    fs.appendFileSync(log.file, '\n{"ts":"x","kind":"hack","ok":true,"durationMs":0,"detail":{}}\n', 'utf8'); // 未知 kind
    const rows: HistoryEntry[] = log.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('download');
  });
  it('未知类型拒绝写入', () => {
    expect(() => log.append({ ...base, kind: 'rm-rf' as never })).toThrowError(/未知操作类型/);
  });
  it('空文件:read 返回 []', () => {
    expect(new HistoryLog(path.join(os.tmpdir(), 'devkit-none-', 'x.jsonl')).list()).toEqual([]);
  });
});
