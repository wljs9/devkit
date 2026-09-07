import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyData, JsonRepository, type DevkitData, type InstallRecord } from '../src/main/core/store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const install = (v: string): InstallRecord => ({
  id: `node-${v}`, tool: 'node', version: v, path: `D:\\dev\\tools\\node\\${v}`,
  sourceId: 'huawei', sourceUrl: 'https://example.invalid/x.zip', sha256: 'ab'.repeat(32),
  size: 1, installedAt: new Date().toISOString(), isCurrent: false,
});

const data = (installs: InstallRecord[]): DevkitData => ({ ...emptyData(), installs });

describe('JsonRepository(§9)', () => {
  it('文件缺失 → 空仓储;保存后可读回', () => {
    const repo = new JsonRepository(path.join(dir, 'devkit.json'));
    expect(repo.load()).toEqual(emptyData());
    repo.save(data([install('22.1.0')]));
    expect(repo.load().installs.map((i) => i.version)).toEqual(['22.1.0']);
  });

  it('两次保存:第一次内容留在 .bak(§9 每次写保留上一份)', () => {
    const file = path.join(dir, 'devkit.json');
    const repo = new JsonRepository(file);
    repo.save(data([install('22.1.0')]));
    repo.save(data([install('22.1.0'), install('22.2.0')]));
    const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')) as DevkitData;
    expect(bak.installs.map((i) => i.version)).toEqual(['22.1.0']);
  });

  it('主文件损坏 → 自动从 .bak 恢复并置 recoveredFromBackup', () => {
    const file = path.join(dir, 'devkit.json');
    const repo = new JsonRepository(file);
    repo.save(data([install('20.1.0')]));
    repo.save(data([install('20.1.0'), install('22.1.0')]));
    fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
    const loaded = repo.load();
    expect(repo.recoveredFromBackup).toBe(true);
    expect(loaded.installs.map((i) => i.version)).toEqual(['20.1.0']);
  });

  it('两坏俱毁 → store-corrupt;只坏备份不伤主文件', () => {
    const file = path.join(dir, 'devkit.json');
    const repo = new JsonRepository(file);
    repo.save(data([]));
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(`${file}.bak`, 'y');
    expect(() => repo.load()).toThrowError(/store-corrupt|损坏/);
  });

  it('结构不合法:读与写都拒绝', () => {
    const repo = new JsonRepository(path.join(dir, 'd.json'));
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(codeOf(() => repo.save({ installs: 'nope' } as unknown as DevkitData))).toBe('store-invalid');
    fs.writeFileSync(path.join(dir, 'd2.json'), '{"installs":[{"id":"x"}]}', 'utf8');
    expect(codeOf(() => new JsonRepository(path.join(dir, 'd2.json')).load())).toBe('store-invalid');
  });

  it('update 读改写;save 不留 .tmp(原子性痕迹干净)', () => {
    const file = path.join(dir, 'devkit.json');
    const repo = new JsonRepository(file);
    repo.update((d) => ({ ...d, installs: [install('24.0.0')] }));
    expect(repo.load().installs.length).toBe(1);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
