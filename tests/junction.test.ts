import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDeletableRealDir, ensureJunction, inspectLink, removeJunction, switchJunction } from '../src/main/core/junction';

let root: string;
const mk = (name: string) => {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'marker.txt'), name);
  return p;
};
const markerOf = (link: string) => fs.readFileSync(path.join(link, 'marker.txt'), 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-jct-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true }); // 测试夹具本身允许递归删(junction 会在此被一并解除,不触目标)
});

describe('junction(§7.3 零依赖联接)', () => {
  it('创建 → 可读目标 → 幂等 no-op', () => {
    const a = mk('v-a');
    const link = path.join(root, 'current', 'node'); // 父目录不存在也要能建
    expect(ensureJunction(link, a)).toEqual({ created: true });
    expect(markerOf(link)).toBe('v-a');
    expect(ensureJunction(link, a)).toEqual({ created: false });
    const st = inspectLink(link);
    expect(st.isLink).toBe(true);
    expect(st.realTarget!.toLowerCase()).toBe(fs.realpathSync(a).toLowerCase());
  });

  it('切换指向后,旧目标文件毫发无损(断链不删目标)', () => {
    const a = mk('v-a');
    const b = mk('v-b');
    const link = path.join(root, 'cur', 'jdk');
    ensureJunction(link, a);
    expect(switchJunction(link, b)).toEqual({ changed: true });
    expect(markerOf(link)).toBe('v-b');
    expect(fs.existsSync(path.join(a, 'marker.txt'))).toBe(true);
  });

  it('目标被删 → 悬空链接仍可判定并可断链', () => {
    const a = mk('v-a');
    const link = path.join(root, 'cur', 'maven');
    ensureJunction(link, a);
    fs.rmSync(a, { recursive: true });
    const st = inspectLink(link);
    expect(st.isLink).toBe(true);
    expect(st.realTarget).toBeUndefined();
    removeJunction(link);
    expect(fs.existsSync(link)).toBe(false);
  });

  it('安全红线:链接位置被真实目录占用 → 拒绝接管;对真实目录断链 → 拒绝删除', () => {
    const real = mk('someone-elses-dir');
    expect(() => ensureJunction(real, mk('v-a'))).toThrowError(/link-blocked|拒绝接管/);
    expect(fs.existsSync(path.join(real, 'marker.txt'))).toBe(true);
    expect(() => removeJunction(real)).toThrowError(/拒绝删除/);
    expect(() => assertDeletableRealDir(real)).not.toThrow();
    const link = path.join(root, 'cur', 'node');
    ensureJunction(link, real);
    try {
      assertDeletableRealDir(link);
      expect.unreachable('应对链接路径拒绝递归删除入口');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('junction-expected');
    }
  });

  it('目标必须为已存在目录', () => {
    expect(() => ensureJunction(path.join(root, 'cur', 'x'), path.join(root, 'nope'))).toThrowError(/目标必须是已存在目录/);
  });
});
