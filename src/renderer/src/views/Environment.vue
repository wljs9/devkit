<script setup lang="ts">
/**
 * 环境页(产品 §4.4):受管区(固定 3 条 + JAVA_HOME,✓正常/⚠失效/✗未接入 —— 决策 A 的暴露面)、
 * 外部条目区(用户可勾删,系统只读;默认不勾选任何项,§3 红线 3)、状态备份区([恢复此状态]→env:restore)、
 * 底部 [重新体检] + 汇总。数据 = env:audit(含 rows)+ env:state(备份),全部判定复用 core 原语(shell 装配),组件只展示。
 */
import { computed, onMounted, ref } from 'vue';
import {
  NButton, NSpace, NAlert, NTag, NCheckbox, NPopconfirm, NSpin, NEmpty, useMessage, useDialog,
} from 'naive-ui';
import { api$, DevkitError } from '../api';
import type { EnvAuditView, EnvStateView, ManagedEntryView } from '../../../shared/ipc';

const msg = useMessage();
const dialog = useDialog();
const audit = ref<EnvAuditView | null>(null);
const state = ref<EnvStateView | null>(null);
const loading = ref(false);
const selected = ref<Set<string>>(new Set()); // 勾选项 raw(默认空,§4.4)
const pruning = ref(false);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    // 体检并发取两路:audit(条目表)+ state(备份区);各自失败独立降级
    const [a, st] = await Promise.all([api$.envAudit(), api$.envState().catch(() => null)]);
    audit.value = a;
    state.value = st;
    selected.value = new Set(); // 数据变了,勾选作废(防拿旧 raw 删错项)
  } catch (e) {
    msg.error(`体检失败:${(e as DevkitError).message}`);
  } finally {
    loading.value = false;
  }
}

// —— 受管区状态(决策 A:present✓ 而 targetOk✗ = ⚠ 失效,如装了 Maven 未装 JDK → JAVA_HOME 悬空)
type ManagedState = 'ok' | 'dangling' | 'absent';
const managedState = (m: ManagedEntryView): ManagedState => (!m.present ? 'absent' : m.targetOk ? 'ok' : 'dangling');
const managedTag = (m: ManagedEntryView) => {
  const s = managedState(m);
  return s === 'ok'
    ? { type: 'success' as const, text: '✓ 正常' }
    : s === 'dangling'
      ? { type: 'warning' as const, text: '⚠ 失效(目标不存在)' }
      : { type: 'error' as const, text: '✗ 未接入' };
};
const anyAbsent = computed(() => (audit.value?.managed ?? []).some((m) => !m.present));

/** [重新接入环境]:预览 diff(§4.0 同款展示)→ 确认 → setup:run(幂等 merge,零重复条目) */
async function reconnect(): Promise<void> {
  const devRoot = audit.value?.devRoot;
  if (!devRoot) return;
  try {
    const plan = await api$.setupPreview(devRoot);
    if (plan.noop) {
      msg.info('环境条目已全部就位,无需接入');
      return;
    }
    dialog.warning({
      title: '将写入用户环境变量(HKCU,写前自动备份)',
      content: `新增 PATH:${plan.willAdd.join(' ; ') || '(无)'}\nJAVA_HOME = ${plan.javaHome}`,
      positiveText: '接入',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          const r = await api$.setupRun(devRoot);
          msg.success(`已接入 ${r.applied.length} 项,新开的终端立即生效${r.broadcast === 'timeout' ? '(广播超时:请重开终端)' : ''}`);
          await reload();
        } catch (e) {
          msg.error((e as DevkitError).message);
        }
      },
    });
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

// —— 外部区:非受管行;系统项只读(写只碰 HKCU,红线 §3.1)
const externals = computed(() => (audit.value?.rows ?? []).filter((r) => !r.managed));
const selectedRows = computed(() => externals.value.filter((r) => selected.value.has(r.raw) && r.scope === 'user'));
const selectable = (raw: string): boolean => externals.value.find((r) => r.raw === raw)?.scope === 'user';

function toggle(raw: string, on: boolean): void {
  const next = new Set(selected.value);
  if (on) next.add(raw);
  else next.delete(raw);
  selected.value = next;
}

async function prune(): Promise<void> {
  const entries = selectedRows.value.map((r) => r.raw);
  if (entries.length === 0) return;
  pruning.value = true;
  try {
    const r = await api$.envPrune(entries);
    msg.success(r.removed.length > 0 ? `已清理 ${r.removed.length} 条(快照已存,可在本页或历史页回滚)` : '选中项已不在用户 PATH 中,无改动');
    await reload();
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    pruning.value = false;
  }
}

// —— 备份区
async function restore(file: string): Promise<void> {
  try {
    await api$.envRestore(file);
    msg.success('已恢复该快照,新开的终端立即生效');
    await reload();
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

const when = (iso: string): string => iso.replace('T', ' ').slice(0, 19);

onMounted(reload);
</script>

<template>
  <div class="page">
    <n-space align="center" justify="space-between" style="margin-bottom: 12px">
      <h3 style="margin: 0">环境</h3>
      <n-button size="small" :loading="loading" @click="reload">↻ 重新体检</n-button>
    </n-space>

    <n-alert
      v-if="audit"
      :type="audit.summary.missing > 0 || audit.managed.some((m) => !m.present || !m.targetOk) ? 'warning' : 'info'"
      style="margin-bottom: 16px"
    >
      PATH 共 {{ audit.summary.total }} 条,失效 {{ audit.summary.missing }},重复 {{ audit.summary.duplicates }}
      <template v-if="!audit.systemReadable">(系统 PATH 不可读,本次仅覆盖用户 PATH)</template>
    </n-alert>

    <n-spin :show="loading">
      <!-- 受管区(§4.4) -->
      <div class="sec-title">
        本工具管理的条目
        <n-button v-if="audit?.devRoot && anyAbsent" size="tiny" type="primary" @click="reconnect">重新接入环境</n-button>
      </div>
      <n-empty v-if="!audit?.devRoot" description="尚未选择 DevRoot —— 先完成首跑向导" style="margin: 18px 0" />
      <table v-else class="env-table">
        <thead>
          <tr><th>条目</th><th>状态</th><th>值</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in audit!.managed" :key="m.label" :class="{ bad: managedState(m) !== 'ok' }">
            <td class="mono">{{ m.label }}</td>
            <td><n-tag size="small" :type="managedTag(m).type" :bordered="false">{{ managedTag(m).text }}</n-tag></td>
            <td class="mono muted" :title="m.value">{{ m.value }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 外部条目区(§4.4):仅用户项可勾删;系统项只读 -->
      <div class="sec-title" style="margin-top: 26px">
        外部 PATH 条目(非本工具创建)
        <n-popconfirm v-if="selectedRows.length > 0" @positive-click="prune">
          <template #trigger>
            <n-button size="tiny" type="error" :loading="pruning">清理所选({{ selectedRows.length }})</n-button>
          </template>
          将从<b>用户</b> PATH 删除以下条目(写前自动备份,可回滚):<br />
          <span v-for="r in selectedRows.slice(0, 8)" :key="r.raw" class="mono" style="font-size: 12px">{{ r.raw }}<br /></span>
          <span v-if="selectedRows.length > 8">…等 {{ selectedRows.length }} 条</span>
        </n-popconfirm>
      </div>
      <table v-if="externals.length > 0" class="env-table">
        <thead>
          <tr><th style="width: 34px"></th><th>条目</th><th>区</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in externals" :key="r.scope + '|' + r.raw" :class="{ bad: r.missing }">
            <td>
              <n-checkbox
                :checked="selected.has(r.raw)"
                :disabled="r.scope !== 'user'"
                :title="r.scope === 'system' ? '系统级(HKLM)条目:本工具只读,不代删 —— 请到 设置→环境变量 手动处理' : '勾选后可清理(需确认)'"
                @update:checked="(v: boolean) => toggle(r.raw, v)"
              />
            </td>
            <td class="mono" :title="r.expanded === r.raw ? r.raw : r.raw + ' → ' + r.expanded">{{ r.expanded }}</td>
            <td><n-tag size="tiny" :bordered="false">{{ r.scope === 'user' ? '用户' : '系统(只读)' }}</n-tag></td>
            <td>
              <span v-if="r.missing" style="color: #d03050">⚠ 指向不存在的目录</span>
              <span v-else-if="r.duplicated" style="color: #d98320">疑似重复(有效 PATH 中出现多次)</span>
              <span v-else class="muted">正常</span>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else description="无外部条目" style="margin: 18px 0" />

      <!-- 状态备份区(§4.4) -->
      <div class="sec-title" style="margin-top: 26px">状态备份(每次写入前的全量快照)</div>
      <table v-if="(state?.backups.length ?? 0) > 0" class="env-table">
        <thead>
          <tr><th>时间</th><th>包含键</th><th style="text-align: right">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="b in state!.backups" :key="b.file">
            <td class="mono">{{ when(b.ts) }}</td>
            <td class="muted">{{ b.names.join(', ') || '(空环境 = 接入前)' }}</td>
            <td style="text-align: right">
              <n-popconfirm @positive-click="restore(b.file)">
                <template #trigger>
                  <n-button size="tiny">恢复此状态</n-button>
                </template>
                将把用户环境变量<b>全量</b>恢复到 {{ when(b.ts) }} 时刻(当前值先不留档)。确认?
              </n-popconfirm>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else description="还没有备份 —— 每次环境写入前都会自动存一份" style="margin: 18px 0" />
    </n-spin>
  </div>
</template>

<style scoped>
.sec-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.env-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.env-table th,
.env-table td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid #efefef;
}
.env-table td:nth-child(2) {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.env-table tr.bad {
  background: #fdf3f3;
}
</style>
