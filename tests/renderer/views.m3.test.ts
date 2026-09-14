/**
 * M3 三页渲染冒烟(§11 renderer 行:不追覆盖率,验"接线"):
 * 各视图在假 bridge 下可挂载,且 §4.4/§4.5/§4.6 的关键信息真的渲染出来
 * (决策 A 的 ⚠失效 标签、体检汇总、回滚入口、缓存/关于区块)。
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { NDialogProvider, NMessageProvider } from 'naive-ui';
import type { DevkitApi, EnvAuditView } from '../../src/shared/ipc';

function ok<T>(data: T) {
  return Promise.resolve({ ok: true as const, data });
}

function withProviders(comp: Component): Component {
  return defineComponent({
    render: () => h(NMessageProvider, null, () => h(NDialogProvider, null, () => h(comp))),
  });
}

async function mountView(comp: Component, bridge: Partial<DevkitApi>) {
  (window as unknown as { devkit: DevkitApi }).devkit = {
    onDownloadProgress: vi.fn(() => () => undefined),
    ...bridge,
  } as unknown as DevkitApi;
  const w = mount(withProviders(comp), { attachTo: document.body });
  await flushPromises();
  return w;
}

describe('Environment.vue(§4.4)', () => {
  it('受管 ✓/⚠失效/✗未接入 三态、体检汇总、外部区分区与回滚入口齐备(决策 A)', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Environment.vue');
    const w = await mountView(View, {
      envAudit: vi.fn(() =>
        ok({
          devRoot: 'D:\\dev',
          managed: [
            { label: 'D:\\dev\\current\\node', kind: 'path', value: 'D:\\dev\\current\\node', present: true, targetOk: true },
            { label: '%JAVA_HOME%\\bin', kind: 'path', value: '%JAVA_HOME%\\bin', present: true, targetOk: false },
            { label: 'JAVA_HOME', kind: 'java_home', value: 'D:\\dev\\current\\jdk', present: false, targetOk: false },
          ],
          rows: [
            { raw: 'C:\\ghost\\bin', expanded: 'C:\\ghost\\bin', scope: 'user', missing: true, duplicated: false, managed: false },
            { raw: 'C:\\Windows\\system32', expanded: 'C:\\Windows\\system32', scope: 'system', missing: false, duplicated: true, managed: false },
            // ★F2:本工具受管条目也在检测表里(打「受管」标签,不可勾删)
            { raw: 'D:\\dev\\current\\node', expanded: 'D:\\dev\\current\\node', scope: 'user', missing: false, duplicated: false, managed: true },
          ],
          systemReadable: true,
          summary: { total: 23, missing: 2, duplicates: 1 },
        } satisfies EnvAuditView),
      ),
      envState: vi.fn(() =>
        ok({
          devRoot: 'D:\\dev', wired: false,
          entries: [],
          backups: [{ ts: '2026-09-07T10:00:00.000Z', file: 'C:\\appdata\\env_backups\\a.json', names: ['Path'], scope: 'user' as const }],
        }),
      ),
      envSystemList: vi.fn(() => ok({ enabled: false, elevated: false, rows: [] })),
    });
    const text = w.text();
    expect(text).toContain('PATH 共 23 条,失效 2,重复 1');
    expect(text).toContain('✓ 正常');
    expect(text).toContain('⚠ 失效(目标不存在)'); // %JAVA_HOME%\bin 悬空
    expect(text).toContain('✗ 未接入');
    expect(text).toContain('指向不存在的目录'); // 人工失效项被标出(DoD)
    expect(text).toContain('系统(只读)');
    expect(text).toContain('恢复此状态');
    expect(text).toContain('重新接入环境'); // 有 absent 项 → 修复入口
    w.unmount();
  });

  it('★F2 受管条目并入检测表:同表展示 + 「受管」标签 + 勾选框禁用(防误删自己的入口)', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Environment.vue');
    const w = await mountView(View, {
      envAudit: vi.fn(() =>
        ok({
          devRoot: 'D:\\dev',
          managed: [{ label: 'D:\\dev\\current\\node', kind: 'path', value: 'D:\\dev\\current\\node', present: true, targetOk: true }],
          rows: [
            { raw: 'C:\\ghost\\bin', expanded: 'C:\\ghost\\bin', scope: 'user', missing: true, duplicated: false, managed: false },
            { raw: 'D:\\dev\\current\\node', expanded: 'D:\\dev\\current\\node', scope: 'user', missing: false, duplicated: false, managed: true },
          ],
          systemReadable: true,
          summary: { total: 2, missing: 1, duplicates: 0 },
        } satisfies EnvAuditView),
      ),
      envState: vi.fn(() => ok({ devRoot: 'D:\\dev', wired: true, entries: [], backups: [] })),
      envSystemList: vi.fn(() => ok({ enabled: false, elevated: false, rows: [] })),
    });
    const text = w.text();
    expect(text).toContain('PATH 条目体检(用户 + 系统)'); // 原「外部条目区」已升格为全量表
    expect(text).toContain('D:\\dev\\current\\node'); // 受管条目出现在检测列表里
    expect(text).toContain('受管');
    // 受管行的勾选框必须禁用(只有受管/系统项之外的用户级项可选)
    expect(w.findAll('.n-checkbox').length).toBe(2);
    expect(w.findAll('.n-checkbox--disabled').length).toBe(1);
    w.unmount();
  });

  it('★F3 系统环境变量区:开关关时只读引导 + 内置变量标「内置·只读」;开时给增改删入口', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Environment.vue');
    const rows = [
      { name: 'Path', kind: 'ExpandString', value: 'C:\\Windows\\system32', protected: true },
      { name: 'JAVA_HOME', kind: 'ExpandString', value: 'C:\\Program Files\\Java\\jdk-21', protected: false },
    ];
    const bridge = (sysv: { enabled: boolean; elevated: boolean }) => ({
      envAudit: vi.fn(() => ok({
        devRoot: 'D:\\dev', managed: [], rows: [], systemReadable: true, summary: { total: 0, missing: 0, duplicates: 0 },
      } satisfies EnvAuditView)),
      envState: vi.fn(() => ok({ devRoot: 'D:\\dev', wired: true, entries: [], backups: [] })),
      envSystemList: vi.fn(() => ok({ ...sysv, rows })),
    });

    // 关:只读 + 引导去设置;内置项与自定义项都列出,但内置项标「内置·只读」
    const off = await mountView(View, bridge({ enabled: false, elevated: false }));
    const offText = off.text();
    expect(offText).toContain('系统环境变量(HKLM)');
    expect(offText).toContain('写入已关闭(默认)');
    expect(offText).toContain('设置 → 系统环境变量');
    expect(offText).toContain('内置·只读');
    expect(offText).toContain('JAVA_HOME');
    expect(offText).not.toContain('＋ 新增系统变量'); // 开关关时不给写入入口
    off.unmount();

    // 开 + 非管理员:给入口但明确警告写入会被拒
    const on = await mountView(View, bridge({ enabled: true, elevated: false }));
    const onText = on.text();
    expect(onText).toContain('写入已开启');
    expect(onText).toContain('非管理员');
    expect(onText).toContain('＋ 新增系统变量');
    on.unmount();
  });
});

describe('History.vue(§4.5)', () => {
  it('时间线渲染:类型标签、失败标记、环境记录带回滚入口', async () => {
    const { default: View } = await import('../../src/renderer/src/views/History.vue');
    const w = await mountView(View, {
      historyList: vi.fn(() =>
        ok([
          { ts: '2026-09-08T01:02:03.000Z', kind: 'install', ok: false, durationMs: 5, detail: { tool: 'jdk', version: '21.0.9', error: 'x' } },
          { ts: '2026-09-08T02:00:00.000Z', kind: 'env_write', ok: true, durationMs: 1200, detail: { via: 'prune', removed: ['C:\\ghost\\bin'] }, backupFile: 'C:\\appdata\\env_backups\\b.json' },
        ]),
      ),
    });
    const text = w.text();
    expect(text).toContain('安装 ✗ 失败');
    expect(text).toContain('环境变更');
    expect(text).toContain('清理 1 条');
    expect(text).toContain('回滚到变更前');
    expect(text).toContain('1.2 s');
    w.unmount();
  });
});

describe('Settings.vue(§4.6)', () => {
  it('六区块渲染:源优先级列表、代理前缀三态、★F3 系统变量开关(默认关)、缓存占用、关于版本', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Settings.vue');
    const w = await mountView(View, {
      settingsGet: vi.fn(() =>
        ok({
          devRoot: 'D:\\dev', sourcePriority: {}, proxy: '', concurrency: 2,
          sourcePrefixes: {}, cache: { dir: 'D:\\dev\\cache', files: 2, bytes: 1048576 * 3 },
          appVersion: '0.1.0', catalogVersion: '2026-09-07T00:00:00.000Z', allowSystemEnv: false,
        }),
      ),
      catalogList: vi.fn(() => ok([{ id: 'jdk', displayName: 'JDK', installedCount: 0, currentVersion: null, sourceIds: ['ustc-latest', 'ghproxy', 'github-direct'] }])),
    });
    const text = w.text();
    expect(text).toContain('镜像源优先级');
    expect(text).toContain('ustc-latest');
    expect(text).toContain('ghproxy');
    expect(text).toContain('目录默认(ghfast.top)');
    expect(text).toContain('系统环境变量(高级,默认关闭)'); // ★F3
    expect(text).toContain('Windows 内置变量与系统 Path 始终只读');
    expect(w.findAll('.n-switch').length).toBe(1); // 唯一的开关就是系统变量写开关
    expect(text).toContain('D:\\dev\\cache');
    expect(text).toContain('3.0 MB');
    expect(text).toContain('DevKit v0.1.0');
    w.unmount();
  });
});
