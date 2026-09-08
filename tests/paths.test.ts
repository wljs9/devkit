import { describe, expect, it } from 'vitest';
import {
  auditPathEntries,
  checkDevRoot,
  currentLinkPath,
  defaultDevRoot,
  envPlan,
  expandPathVars,
  joinPathList,
  mergePathEntries,
  partPaths,
  pathEntryEquals,
  removePathEntries,
  splitPathList,
  toolVersionDir,
  versionDir,
} from '../src/main/core/paths';

describe('defaultDevRoot', () => {
  it('存在 D 盘则 D:\\dev,否则 %USERPROFILE%\\dev', () => {
    expect(defaultDevRoot({ USERPROFILE: 'C:\\Users\\me' }, (p) => p === 'D:\\')).toBe('D:\\dev');
    expect(defaultDevRoot({ USERPROFILE: 'C:\\Users\\me' }, () => false)).toBe('C:\\Users\\me\\dev');
  });
});

describe('checkDevRoot(§5 校验)', () => {
  it('非 ASCII / 含空格 / 相对路径均拒绝', () => {
    expect(checkDevRoot('D:\\开发\\dev').ok).toBe(false);
    expect(checkDevRoot('C:\\my tools\\dev').ok).toBe(false);
    expect(checkDevRoot('dev').ok).toBe(false);
    expect(checkDevRoot('D:\\dev').ok).toBe(true);
  });
  it('OneDrive 路径:可通过但必须带警告', () => {
    const r = checkDevRoot('C:\\Users\\me\\OneDrive\\dev');
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('布局与目录名安全', () => {
  it('versionDir 拒绝穿越与非法字符,保留 + 号', () => {
    expect(versionDir('21.0.9+10')).toBe('21.0.9+10');
    for (const bad of ['..', '..\\x', 'a/b', 'a:b', 'x..', 'dot.', ' ']) {
      expect(() => versionDir(bad)).toThrowError();
    }
  });
  it('tool id 白名单', () => {
    expect(() => toolVersionDir('D:\\dev', '..', '1.0')).toThrowError(/id 不合法/);
    expect(toolVersionDir('D:\\dev', 'maven', '3.9.16')).toBe('D:\\dev\\tools\\maven\\3.9.16');
  });
  it('part 文件路径净化并落在 cache 下(§7.4)', () => {
    const p = partPaths('D:\\dev', 'node-v22.20.0-win-x64:zip');
    expect(p.part).toBe('D:\\dev\\cache\\node-v22.20.0-win-x64_zip.part');
    expect(p.meta).toBe(`${p.part}.json`);
  });
});

describe('PATH 条目代数', () => {
  it('envPlan 固定三条且指向 current 层(产品文档 §6)', () => {
    const plan = envPlan('D:\\dev');
    expect(plan.pathEntries).toEqual(['D:\\dev\\current\\node', 'D:\\dev\\current\\maven\\bin', '%JAVA_HOME%\\bin']);
    expect(plan.javaHome).toBe('D:\\dev\\current\\jdk');
    expect(currentLinkPath('D:\\dev', 'jdk')).toBe('D:\\dev\\current\\jdk');
  });
  it('merge 幂等:重复安装不产生重复条目(§7.2②),大小写/尾斜杠视为相同', () => {
    const plan = envPlan('D:\\dev');
    const first = mergePathEntries('C:\\Windows', plan.pathEntries);
    expect(first.changed).toBe(true);
    expect(first.appended.length).toBe(3);
    const doubled = joinPathList([first.value.toUpperCase(), 'C:\\Other\\']);
    const second = mergePathEntries(doubled, plan.pathEntries);
    expect(second.changed).toBe(false);
    expect(second.value).toBe(doubled);
    const trailing = mergePathEntries('D:\\dev\\current\\maven\\bin\\;', plan.pathEntries);
    expect(trailing.changed).toBe(true); // node 与 %JAVA_HOME%\bin 仍缺
    expect(splitPathList(trailing.value).length).toBe(3); // maven\bin 不因尾斜杠重复
    expect(pathEntryEquals('D:\\A\\B', 'd:\\a\\b\\')).toBe(true);
  });
  it('remove 只按等值精确命中(红线 3 底层保障)', () => {
    const cur = 'C:\\Windows;D:\\dev\\current\\node;D:\\devsoft\\x';
    const r = removePathEntries(cur, [cur.split(';')[1]!]);
    expect(r.removed).toEqual(['D:\\dev\\current\\node']);
    expect(r.value).toBe('C:\\Windows;D:\\devsoft\\x'); // 前缀相似项 D:\\devsoft 不受影响
  });
  it('audit 标失效与重复,跳过 %VAR% 条目', () => {
    const a = auditPathEntries('C:\\Windows;C:\\Windows;D:\\no\\such;D:\\no\\such;%SystemRoot%\\x', (p) => p === 'C:\\Windows');
    expect(a.total).toBe(5);
    expect(a.missing).toEqual(['D:\\no\\such']);
    expect(a.duplicates).toEqual([['C:\\Windows', 'C:\\Windows'], ['D:\\no\\such', 'D:\\no\\such']]);
  });
});

describe('expandPathVars(§4.4 体检前置,大小写不敏感)', () => {
  const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' };
  it('命中的 %VAR% 展开(变量名大小写不敏感),未知变量与无 %-对保留原文', () => {
    expect(expandPathVars('%SystemRoot%\\system32;%JAVA_HOME%\\bin;C:\\x%y', env)).toBe(
      'C:\\Windows\\system32;%JAVA_HOME%\\bin;C:\\x%y',
    );
  });
  it('展开后可交给 auditPathEntries 判存在性(不再被 % 跳过)', () => {
    const expanded = expandPathVars('%SystemRoot%\\System32', env);
    const a = auditPathEntries(expanded, (p) => p === 'C:\\Windows\\System32');
    expect(a.missing).toEqual([]);
  });
  it('展开失败(未知变量)保持跳过语义 → 不误报失效', () => {
    const a = auditPathEntries(expandPathVars('%NOPE%\\bin', env), () => false);
    expect(a.missing).toEqual([]); // 仍含 %,audit 不判存在性
  });
});
