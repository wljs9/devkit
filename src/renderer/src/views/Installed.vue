<script setup lang="ts">
/**
 * 已安装(产品 §4.3):按工具分组,行 = 版本/路径/大小/来源/时间/状态(● 当前);
 * 行操作 [设为当前](秒级重建 junction,弹 toast)/[打开目录]/[卸载](预览影响 → 确认)。
 * 组件哑:数据 api$,确认用 n-popconfirm(§11)。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NSpace, NPopconfirm, NEmpty, NInput, NAlert, useMessage } from 'naive-ui';
import { api$, DevkitError } from '../api';
import { useDownloadQueue } from '../stores/downloadQueue';
import type { InstallView } from '../../../shared/ipc';

const msg = useMessage();
const dlq = useDownloadQueue();
const installs = ref<InstallView[]>([]);
const loading = ref(false);
const keyword = ref('');
const noDevRoot = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    installs.value = await api$.installList();
    noDevRoot.value = false;
  } catch (e) {
    const de = e as DevkitError;
    noDevRoot.value = de.code === 'no-devroot';
    installs.value = [];
    if (!noDevRoot.value) msg.error(de.message);
  } finally {
    loading.value = false;
  }
}

// 过滤 → 按工具分组(§4.3 顶部每工具搜索;MVP 一个全局过滤框即可)
const groups = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  const m = new Map<string, InstallView[]>();
  for (const i of installs.value) {
    if (k && !`${i.tool} ${i.version}`.toLowerCase().includes(k)) continue;
    (m.get(i.tool) ?? m.set(i.tool, []).get(i.tool)!).push(i);
  }
  return [...m.entries()]
    .map(([tool, rows]) => ({ tool, rows: rows.sort((a, b) => b.installedAt.localeCompare(a.installedAt)) }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
});

async function switchTo(i: InstallView): Promise<void> {
  try {
    await api$.installSwitch(i.tool, i.version);
    msg.success(`已切换 ${i.tool} → ${i.version},新开的终端立即生效`);
    await load();
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

async function uninstall(i: InstallView): Promise<void> {
  try {
    await api$.installUninstall(i.tool, i.version);
    msg.success(`已卸载 ${i.tool} ${i.version}`);
    await load();
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

// S2 收口:只传 installId,路径由 main 查登记表校验后解析(§4.3 [打开目录])
const openDir = (i: InstallView): void => void api$.openPath(i.id).catch((e: DevkitError) => msg.error(e.message));
const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
const when = (iso: string): string => iso.replace('T', ' ').slice(0, 19);

onMounted(load);
watch(() => dlq.doneTick, load); // 下载→装完自动刷新(§4.2 完成后自动进入安装)
</script>

<template>
  <div class="page">
    <n-space align="center" justify="space-between" style="margin-bottom: 12px">
      <h3 style="margin: 0">已安装</h3>
      <n-input v-model:value="keyword" size="small" clearable placeholder="搜索工具/版本" style="width: 220px" />
    </n-space>

    <n-alert v-if="noDevRoot" type="warning" style="margin-bottom: 12px" title="尚未选择 DevRoot">
      请先在「首跑向导」选择安装根目录,才能安装与查看已装工具。<router-link to="/setup">去设置</router-link>
    </n-alert>
    <n-empty v-else-if="!loading && installs.length === 0" description="还没有安装任何工具 —— 去商店页装一个吧" style="margin-top: 40px" />

    <div v-for="g in groups" :key="g.tool" style="margin-bottom: 22px">
      <div style="font-weight: 600; margin-bottom: 6px">{{ g.tool }}</div>
      <table class="inst-table">
        <thead>
          <tr>
            <th>版本</th><th>大小</th><th>来源</th><th>安装时间</th><th>路径</th><th style="text-align: right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in g.rows" :key="r.id" :class="{ current: r.isCurrent }">
            <td>
              <span v-if="r.isCurrent" title="当前生效">● </span><span class="mono">{{ r.version }}</span>
            </td>
            <td>{{ mb(r.size) }}</td>
            <td>{{ r.sourceId }}</td>
            <td class="mono">{{ when(r.installedAt) }}</td>
            <td class="mono muted" :title="r.path">{{ r.path }}</td>
            <td style="text-align: right">
              <n-space justify="end" size="small">
                <n-button size="tiny" :disabled="r.isCurrent" @click="switchTo(r)">设为当前</n-button>
                <n-button size="tiny" @click="openDir(r)">打开目录</n-button>
                <n-popconfirm @positive-click="uninstall(r)">
                  <template #trigger>
                    <n-button size="tiny" type="error" :disabled="r.isCurrent">卸载</n-button>
                  </template>
                  将删除 <b class="mono">{{ r.path }}</b><br />并从登记表移除,不可撤销。确认卸载?
                </n-popconfirm>
              </n-space>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.inst-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.inst-table th,
.inst-table td {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 1px solid #efefef;
  white-space: nowrap;
}
.inst-table td:nth-child(5) {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.inst-table tr.current {
  background: #f1f8f3;
}
</style>
