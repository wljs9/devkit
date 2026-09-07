<script setup lang="ts">
/**
 * 软件商店(产品 §4.1):工具卡片 → 详情版本列表(实时解析镜像目录 + 本地缓存 + 刷新);
 * 每行 版本号/大小/可用源(可展开换源)/[安装]。安装即 downloadStart,进度在顶栏下载指示看。
 */
import { onMounted, ref, watch } from 'vue';
import {
  NGrid, NGridItem, NCard, NList, NListItem, NButton, NSpace, NTag, NSelect, NEmpty, NSpin, NProgress, NText, NStatistic, useMessage,
} from 'naive-ui';
import { api$, DevkitError } from '../api';
import { useDownloadQueue } from '../stores/downloadQueue';
import type { ToolCardView, VersionRowView } from '../../../shared/ipc';

const msg = useMessage();
const dlq = useDownloadQueue();

const cards = ref<ToolCardView[]>([]);
const loadingCards = ref(false);
const selected = ref<ToolCardView | null>(null);
const versions = ref<VersionRowView[]>([]);
const loadingVersions = ref(false);
const chosenSource = ref<Record<string, string>>({}); // key: version → sourceId

async function loadCards(): Promise<void> {
  loadingCards.value = true;
  try {
    cards.value = await api$.catalogList();
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    loadingCards.value = false;
  }
}

async function openTool(c: ToolCardView): Promise<void> {
  selected.value = c;
  await loadVersions(false);
}

async function loadVersions(force: boolean): Promise<void> {
  if (!selected.value) return;
  loadingVersions.value = true;
  try {
    versions.value = await api$.catalogVersions(selected.value.id, force);
  } catch (e) {
    msg.error(`版本列表加载失败:${(e as DevkitError).message}`);
    versions.value = [];
  } finally {
    loadingVersions.value = false;
  }
}

function taskFor(tool: string, version: string) {
  return dlq.tasks[`${tool}-${version}`];
}
/** 进行中的任务禁用安装按钮;终态(done/failed/cancelled/undefined)允许再次点击(§7.4 续/重试/换源) */
function busy(tool: string, version: string): boolean {
  const s = taskFor(tool, version)?.status;
  return s === 'queued' || s === 'downloading';
}
function btnLabel(tool: string, version: string): string {
  const s = taskFor(tool, version)?.status;
  return s === 'done' ? '已安装' : s === 'downloading' ? '下载中' : s === 'queued' ? '排队中' : s === 'failed' ? '重试' : '安装';
}

async function install(v: VersionRowView): Promise<void> {
  const src = chosenSource.value[v.version] ?? v.preferredSourceId;
  try {
    await api$.downloadStart(v.tool, v.version, src);
    msg.info(`已开始下载 ${v.tool} ${v.version}(${src})`);
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

const mb = (n: number | null): string => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);

onMounted(loadCards);
// 有任务转 done 时刷新卡片计数/当前版本
watch(() => dlq.doneTick, () => void loadCards());
</script>

<template>
  <div class="page">
    <!-- 卡片列表 -->
    <template v-if="!selected">
      <n-spin :show="loadingCards">
        <n-empty v-if="!loadingCards && cards.length === 0" description="目录为空(catalog/*.json 未加载)" />
        <n-grid v-else :cols="3" :x-gap="16" :y-gap="16">
          <n-grid-item v-for="c in cards" :key="c.id">
            <n-card hoverable :title="c.displayName" @click="openTool(c)">
              <n-space vertical size="small">
                <n-statistic label="已装版本" :value="c.installedCount" />
                <n-text depth="3" style="font-size: 13px">
                  当前:
                  <n-tag v-if="c.currentVersion" size="small" type="success" :bordered="false">{{ c.currentVersion }}</n-tag>
                  <span v-else class="muted">未安装</span>
                </n-text>
              </n-space>
            </n-card>
          </n-grid-item>
        </n-grid>
      </n-spin>
    </template>

    <!-- 工具详情:版本列表 -->
    <template v-else>
      <n-space align="center" justify="space-between" style="margin-bottom: 12px">
        <n-space align="center">
          <n-button text @click="selected = null">← 返回</n-button>
          <h3 style="margin: 0">{{ selected.displayName }}</h3>
        </n-space>
        <n-button size="small" :loading="loadingVersions" @click="loadVersions(true)">刷新目录</n-button>
      </n-space>

      <n-spin :show="loadingVersions">
        <n-empty v-if="!loadingVersions && versions.length === 0" description="无可用版本" />
        <n-list v-else bordered>
          <n-list-item v-for="v in versions" :key="v.version">
            <n-space align="center" justify="space-between" style="width: 100%">
              <n-space align="center">
                <span class="mono" style="font-weight: 600; min-width: 120px">{{ v.version }}</span>
                <n-text depth="3" style="min-width: 72px">{{ mb(v.size) }}</n-text>
                <n-tag size="tiny" :bordered="false">{{ v.preferredSourceId }}</n-tag>
              </n-space>
              <n-space align="center">
                <n-select
                  v-if="v.sourceIds.length > 1"
                  v-model:value="chosenSource[v.version]"
                  size="tiny"
                  style="width: 120px"
                  :options="v.sourceIds.map((s) => ({ label: s, value: s }))"
                  :placeholder="v.preferredSourceId"
                />
                <n-button size="small" type="primary" :disabled="busy(v.tool, v.version)" @click="install(v)">
                  {{ btnLabel(v.tool, v.version) }}
                </n-button>
              </n-space>
            </n-space>
            <n-progress
              v-if="taskFor(v.tool, v.version)?.status === 'downloading'"
              type="line"
              :percentage="taskFor(v.tool, v.version)!.total > 0 ? Math.round((taskFor(v.tool, v.version)!.received / taskFor(v.tool, v.version)!.total) * 100) : 0"
              :height="4"
              :show-indicator="false"
            />
          </n-list-item>
        </n-list>
      </n-spin>
    </template>
  </div>
</template>
