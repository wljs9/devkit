<script setup lang="ts">
/**
 * 历史页(产品 §4.5):时间线 = 安装/切换/卸载/环境变更/恢复/下载 全量操作(含耗时与结果);
 * 环境类记录直链对应备份 → [回滚](env:restore);过滤仅按类型(MVP,不做检索)。
 */
import { computed, onMounted, ref } from 'vue';
import { NButton, NSpace, NSelect, NTimeline, NTimelineItem, NPopconfirm, NEmpty, NSpin, useMessage } from 'naive-ui';
import { api$, DevkitError } from '../api';
import type { HistoryViewEntry } from '../../../shared/ipc';

const msg = useMessage();
const entries = ref<HistoryViewEntry[]>([]);
const loading = ref(false);
const kind = ref<string | null>(null);

const KIND_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '安装', value: 'install' },
  { label: '切换', value: 'switch' },
  { label: '卸载', value: 'uninstall' },
  { label: '环境变更', value: 'env_write' },
  { label: '环境恢复', value: 'env_restore' },
  { label: '下载', value: 'download' },
];
const KIND_LABEL: Record<string, string> = {
  install: '安装', switch: '切换版本', uninstall: '卸载', env_write: '环境变更', env_restore: '环境恢复', download: '下载',
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    entries.value = await api$.historyList(kind.value || undefined, 200);
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    loading.value = false;
  }
}

/** 一行人类可读摘要(detail 各 kind 字段不同,取有则说) */
function summary(h: HistoryViewEntry): string {
  const d = h.detail as Record<string, unknown>;
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const arr = (k: string): string[] | null => (Array.isArray(d[k]) ? (d[k] as unknown[]).map(String) : null);
  switch (h.kind) {
    case 'install': {
      const t = [str('tool'), str('version')].filter(Boolean).join(' ');
      return t ? `${t}${str('sourceId') ? ` ← ${str('sourceId')}` : ''}` : '安装';
    }
    case 'switch':
      return [str('tool'), str('version')].filter(Boolean).join(' → ');
    case 'uninstall':
      return [str('tool'), str('version')].filter(Boolean).join(' ');
    case 'env_write': {
      if (str('via') === 'prune') return `清理 ${arr('removed')?.length ?? '?'} 条失效项`;
      const changed = arr('changed');
      return `${changed ? changed.join(', ') : 'PATH/JAVA_HOME'} 写入${str('devRoot') ? `(DevRoot=${str('devRoot')})` : ''}`;
    }
    case 'env_restore': {
      const changed = arr('changed');
      return `恢复${changed ? `(${changed.join(', ')})` : ''}`;
    }
    default: {
      const err = str('error');
      return err ? err.slice(0, 120) : JSON.stringify(d).slice(0, 120);
    }
  }
}

const isEnv = (h: HistoryViewEntry): boolean => h.kind === 'env_write' || h.kind === 'env_restore';
const when = (iso: string): string => iso.replace('T', ' ').slice(0, 19);
const dur = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const filterValue = computed({
  get: () => kind.value ?? '',
  set: (v: string) => {
    kind.value = v || null;
    void load();
  },
});

async function rollback(h: HistoryViewEntry): Promise<void> {
  if (!h.backupFile) return;
  try {
    await api$.envRestore(h.backupFile);
    msg.success(`已回滚到 ${when(h.ts)} 变更前的快照`);
    await load();
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <n-space align="center" justify="space-between" style="margin-bottom: 12px">
      <h3 style="margin: 0">历史</h3>
      <n-space align="center">
        <n-select v-model:value="filterValue" size="small" style="width: 140px" :options="KIND_OPTIONS" />
        <n-button size="small" :loading="loading" @click="load">↻ 刷新</n-button>
      </n-space>
    </n-space>

    <n-spin :show="loading">
      <n-empty v-if="!loading && entries.length === 0" description="还没有操作记录" style="margin-top: 40px" />
      <n-timeline v-else style="margin-top: 8px">
        <n-timeline-item
          v-for="(h, i) in entries"
          :key="h.ts + String(i)"
          :type="h.ok ? (isEnv(h) ? 'warning' : 'success') : 'error'"
          :title="`${KIND_LABEL[h.kind] ?? h.kind}${h.ok ? '' : ' ✗ 失败'}`"
          :time="when(h.ts)"
        >
          <div class="hist-detail">
            <span class="mono" style="font-size: 12px">{{ summary(h) }}</span>
            <span v-if="h.durationMs > 0" class="muted" style="margin-left: 10px">{{ dur(h.durationMs) }}</span>
            <template v-if="isEnv(h) && h.backupFile">
              <span class="muted mono" style="margin-left: 10px; font-size: 11px">快照:{{ h.backupFile.split(/[\\/]/).pop() }}</span>
              <n-popconfirm @positive-click="rollback(h)">
                <template #trigger>
                  <n-button size="tiny" style="margin-left: 10px">回滚到变更前</n-button>
                </template>
                将把用户环境变量恢复到本条操作<b>之前</b>的快照({{ when(h.ts) }})。确认?
              </n-popconfirm>
            </template>
          </div>
        </n-timeline-item>
      </n-timeline>
    </n-spin>
  </div>
</template>

<style scoped>
.hist-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
</style>
