/**
 * ★ F1(2026-09-14)已安装页渲染冒烟:接管行与下载行的操作入口必须分清 ——
 * 接管项给 [移出登记](不删文件),下载项给 [卸载];顶部有 [添加已有安装] 入口,点开有接管面板。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { NDialogProvider, NMessageProvider } from 'naive-ui';
import type { DevkitApi, InstallView } from '../../src/shared/ipc';

beforeEach(() => {
  setActivePinia(createPinia()); // Installed.vue 用 pinia 下载队列(§4.2),挂载前先激活
});

function ok<T>(data: T) {
  return Promise.resolve({ ok: true as const, data });
}

function withProviders(comp: Component): Component {
  return defineComponent({
    render: () => h(NMessageProvider, null, () => h(NDialogProvider, null, () => h(comp))),
  });
}

const DL_ROW: InstallView = {
  id: 'node-22.20.0', tool: 'node', version: '22.20.0', path: 'D:\\dev\\tools\\node\\22.20.0',
  sourceId: 'huawei', sourceUrl: 'u', size: 1048576 * 40, installedAt: '2026-09-14T01:00:00.000Z', isCurrent: true, origin: 'download',
};

async function mountView(comp: Component, bridge: Partial<DevkitApi>) {
  (window as unknown as { devkit: DevkitApi }).devkit = {
    onDownloadProgress: vi.fn(() => () => undefined),
    ...bridge,
  } as unknown as DevkitApi;
  const w = mount(withProviders(comp), { attachTo: document.body });
  await flushPromises();
  return w;
}

describe('Installed.vue(§4.3 + ★F1 接管)', () => {
  it('只装下载行:显 [卸载] 与体积,不出现接管用语', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Installed.vue');
    const w = await mountView(View, { installList: vi.fn(() => ok([DL_ROW])) });
    const text = w.text();
    expect(text).toContain('添加已有安装');
    expect(text).toContain('40.0 MB');
    expect(text).toContain('huawei');
    expect(text).toContain('卸载');
    expect(text).not.toContain('移出登记');
    w.unmount();
  });

  it('接管行:显 [移出登记] 与「接管」标签,体积为「—」,不给 [卸载]', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Installed.vue');
    const adopt: InstallView = {
      ...DL_ROW, id: 'jdk-21.0.4', tool: 'jdk', version: '21.0.4', path: 'C:\\Program Files\\Java\\jdk-21.0.4',
      sourceId: 'local', size: 0, isCurrent: false, origin: 'adopt',
    };
    const w = await mountView(View, { installList: vi.fn(() => ok([adopt])) });
    const text = w.text();
    expect(text).toContain('移出登记');
    expect(text).toContain('接管');
    expect(text).toContain('本机目录'); // sourceId=local 的人类可读形态
    expect(text).toContain('—'); // 不统计既有安装体积
    expect(text).not.toContain('卸载'); // 接管项永不出现删除入口
    w.unmount();
  });

  it('[添加已有安装] 打开接管面板,拉工具清单,面板含目录选择与二次确认文案', async () => {
    const { default: View } = await import('../../src/renderer/src/views/Installed.vue');
    const catalogList = vi.fn(() => ok([{ id: 'jdk', displayName: 'JDK (Eclipse Temurin)', installedCount: 0, currentVersion: null, sourceIds: ['ustc-latest'] }]));
    const w = await mountView(View, { installList: vi.fn(() => ok([])), catalogList, pickDirectory: vi.fn(() => ok({ path: null })) });
    const btn = w.findAll('button').find((b) => b.text().includes('添加已有安装'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await flushPromises();
    expect(catalogList).toHaveBeenCalled();
    const modal = document.body.textContent ?? '';
    expect(modal).toContain('检测并登记');
    expect(modal).toContain('不复制、不移动、不删除');
    w.unmount();
  });
});