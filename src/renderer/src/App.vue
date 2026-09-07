<script setup lang="ts">
// 应用框架(产品 §4:侧边栏 4 页 + 顶栏下载指示)。M2 只实装 商店/已安装 两页,环境·历史·设置为 M3 占位。
import { computed, h, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NConfigProvider, NMessageProvider, NDialogProvider, NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NIcon, zhCN, dateZhCN } from 'naive-ui';
import { StorefrontOutline, CubeOutline, GitNetworkOutline, TimeOutline, SettingsOutline } from '@vicons/ionicons5';
import DownloadTray from './components/DownloadTray.vue';
import { api$ } from './api';

const route = useRoute();
const router = useRouter();
const envWired = ref<boolean | null>(null); // null=未探测(不闪提示)

const icons = {
  store: StorefrontOutline,
  installed: CubeOutline,
  env: GitNetworkOutline,
  history: TimeOutline,
  settings: SettingsOutline,
};
const renderIcon = (key: keyof typeof icons) => () => h(NIcon, null, { default: () => h(icons[key]) });

const menu = computed(() => [
  { label: '软件商店', key: 'store', icon: renderIcon('store') },
  { label: '已安装', key: 'installed', icon: renderIcon('installed') },
  { label: '环境', key: 'env', icon: renderIcon('env') },
  { label: '历史', key: 'history', icon: renderIcon('history') },
  { label: '设置', key: 'settings', icon: renderIcon('settings') },
]);
const activeKey = computed(() => (route.name as string) || 'store');

const onMenu = (key: string): void => void router.push({ name: key });

// 首跑守卫(§4.0):settings.devRoot 未落 → 强制走向导。settingsGet 纯进程内,路由切换可频繁调。
async function guardFirstRun(): Promise<void> {
  const st = await api$.settingsGet().catch(() => null);
  if (st && !st.devRoot) await router.replace({ name: 'setup' });
}
// envState 会 spawn PowerShell 读注册表(重),仅在挂载与离开向导后刷新,不随每次导航触发。
async function refreshEnv(): Promise<void> {
  const env = await api$.envState().catch(() => null);
  envWired.value = env ? env.wired : null;
}

onMounted(() => {
  void guardFirstRun();
  void refreshEnv();
});
watch(
  () => route.name,
  (name, prev) => {
    void guardFirstRun();
    if (prev === 'setup' && name !== 'setup') void refreshEnv(); // 走完/跳过向导回到主页才重探
  },
);
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <n-layout has-sider style="height: 100vh">
          <n-layout-sider bordered :width="200" :native-scrollbar="false">
            <div style="padding: 18px 20px 8px; font-weight: 700; font-size: 18px">DevKit</div>
            <n-menu :value="activeKey" :options="menu" @update:value="onMenu" />
          </n-layout-sider>
          <n-layout>
            <n-layout-header bordered style="height: 52px; display: flex; align-items: center; justify-content: flex-end; padding: 0 16px; gap: 14px">
              <span
                v-if="envWired === false"
                style="color: #d98320; font-size: 13px"
              >环境未接入 —— <a style="cursor: pointer" @click="router.push({ name: 'setup' })">运行首跑向导</a></span>
              <span v-else-if="envWired === true" style="color: #18a058; font-size: 13px">✓ 环境已接入</span>
              <download-tray />
            </n-layout-header>
            <n-layout-content content-style="height: calc(100vh - 52px); overflow: auto">
              <router-view />
            </n-layout-content>
          </n-layout>
        </n-layout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
