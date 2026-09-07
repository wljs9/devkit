<script setup lang="ts">
// 顶栏下载指示 + 队列面板(产品 §4.2):进度条/速率/[取消],完成自动转"已安装"。
import { NPopover, NBadge, NIcon, NButton, NProgress, NEmpty, NSpace, NText } from 'naive-ui';
import { DownloadOutline, CloseCircleOutline } from '@vicons/ionicons5';
import { useDownloadQueue } from '../stores/downloadQueue';
import { api$ } from '../api';

const dlq = useDownloadQueue();
const pct = (t: { received: number; total: number }): number => (t.total > 0 ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0);
const mb = (n: number): string => (n >= 0 ? `${(n / 1048576).toFixed(1)} MB` : '—');
const mbps = (n: number): string => `${(n / 1048576).toFixed(2)} MB/s`;
const cancel = (id: string): void => void api$.downloadCancel(id).catch(() => undefined);
</script>

<template>
  <n-popover trigger="click" placement="bottom-end" :width="380">
    <template #trigger>
      <n-badge :value="dlq.activeCount" :max="99" :show="dlq.activeCount > 0" :offset="[-4, 4]">
        <n-button quaternary circle><n-icon size="20"><download-outline /></n-icon></n-button>
      </n-badge>
    </template>
    <div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
        <b>下载队列</b>
        <n-text depth="3" style="font-size: 12px">并发上限 2 · 支持断点续传</n-text>
      </div>
      <n-empty v-if="dlq.list.length === 0" description="暂无任务" size="small" />
      <div v-for="t in dlq.list" :key="t.id" style="padding: 8px 0; border-bottom: 1px solid #efefef">
        <n-space justify="space-between" align="center">
          <span>{{ t.tool }} · {{ t.version }}</span>
          <n-button v-if="t.status === 'downloading' || t.status === 'queued'" text size="tiny" @click="cancel(t.id)">
            <n-icon size="14"><close-circle-outline /></n-icon> 取消
          </n-button>
        </n-space>
        <n-progress
          v-if="t.status === 'downloading'"
          type="line"
          :percentage="pct(t)"
          :height="8"
          indicator-placement="inside"
          processing
        />
        <n-text v-else-if="t.status === 'queued'" depth="3" style="font-size: 12px">排队中…</n-text>
        <n-text v-else-if="t.status === 'done'" style="font-size: 12px; color: #18a058">✓ 已安装</n-text>
        <n-text v-else-if="t.status === 'cancelled'" depth="3" style="font-size: 12px">已取消(断点已保留,可续传)</n-text>
        <n-text v-else-if="t.status === 'failed'" type="error" style="font-size: 12px">{{ t.error?.message }}</n-text>
        <n-text v-if="t.status === 'downloading'" depth="3" style="font-size: 11px; float: right">
          {{ mb(t.received) }} / {{ mb(t.total) }} · {{ mbps(t.speed) }}
        </n-text>
      </div>
    </div>
  </n-popover>
</template>
