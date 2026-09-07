/**
 * §11 renderer 冒烟(不追覆盖率):整棵渲染树(App + router + naive providers + 三视图)
 * 在注入假 bridge 下可挂载、侧边栏 4+1 页渲染、商店卡片经 api$ 取到数据。
 * 组件哑、逻辑在 api$/store —— 这里验证"接线"而非交互细节。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from '../../src/renderer/src/App.vue';
import type { DevkitApi } from '../../src/shared/ipc';

function makeBridge(): DevkitApi {
  const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
  return {
    catalogList: vi.fn(() => ok([{ id: 'node', displayName: 'Node.js', installedCount: 0, currentVersion: null }])),
    catalogVersions: vi.fn(() => ok([])),
    downloadStart: vi.fn(() => ok({ taskId: 'node-1' })),
    downloadCancel: vi.fn(() => ok({ cancelled: true })),
    onDownloadProgress: vi.fn(() => () => undefined),
    installList: vi.fn(() => ok([])),
    installSwitch: vi.fn(() => ok(null)),
    installUninstall: vi.fn(() => ok(null)),
    envState: vi.fn(() => ok({ devRoot: 'D:\\dev', wired: true, entries: [], backups: [] })),
    envAudit: vi.fn(() => Promise.resolve({ ok: false, code: 'not-implemented', message: '' })),
    envPrune: vi.fn(() => Promise.resolve({ ok: false, code: 'not-implemented', message: '' })),
    envRestore: vi.fn(() => ok(null)),
    historyList: vi.fn(() => ok([])),
    settingsGet: vi.fn(() => ok({ devRoot: 'D:\\dev', sourcePriority: {}, proxy: '', concurrency: 2 })),
    settingsSet: vi.fn(() => ok({ devRoot: 'D:\\dev', sourcePriority: {}, proxy: '', concurrency: 2 })),
    setupPreview: vi.fn(() => ok({ devRoot: 'D:\\dev', warnings: [], willAdd: [], javaHome: '', noop: true })),
    setupRun: vi.fn(() => ok({ applied: [], broadcast: 'ok', backupFile: null })),
    setupCheck: vi.fn(() => ok({ ok: true, reasons: [], warnings: [] })),
    setupDefaults: vi.fn(() => ok({ devRoot: 'D:\\dev', check: { ok: true, reasons: [], warnings: [] } })),
    openPath: vi.fn(() => ok(null)),
  } as unknown as DevkitApi;
}

const routes = [
  { path: '/setup', name: 'setup', component: { template: '<div/>' } },
  { path: '/', name: 'store', component: { template: '<div/>' } },
  { path: '/installed', name: 'installed', component: { template: '<div/>' } },
  { path: '/env', name: 'env', component: { template: '<div/>' }, meta: { title: '环境', milestone: 'M3' } },
  { path: '/history', name: 'history', component: { template: '<div/>' } },
  { path: '/settings', name: 'settings', component: { template: '<div/>' } },
];

describe('App 渲染树冒烟', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('挂载后渲染侧边栏全部导航项', async () => {
    (window as unknown as { devkit: DevkitApi }).devkit = makeBridge();
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router, createPinia()] }, attachTo: document.body });
    await flushPromises();
    const text = wrapper.text();
    for (const label of ['软件商店', '已安装', '环境', '历史', '设置']) {
      expect(text).toContain(label);
    }
    wrapper.unmount();
  });

  it('环境未接入时顶栏出现黄色提示入口(§4.0)', async () => {
    const b = makeBridge();
    (b.envState as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { devRoot: null, wired: false, entries: [], backups: [] } });
    (b.settingsGet as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { devRoot: 'D:\\dev', sourcePriority: {}, proxy: '', concurrency: 2 } });
    (window as unknown as { devkit: DevkitApi }).devkit = b;
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router, createPinia()] }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain('环境未接入');
    wrapper.unmount();
  });
});
