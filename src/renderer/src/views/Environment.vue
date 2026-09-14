<script setup lang="ts">
/**
 * 环境页(产品 §4.4):受管区(固定 3 条 + JAVA_HOME,✓正常/⚠失效/✗未接入 —— 决策 A 的暴露面)、
 * PATH 条目体检表(用户 + 系统 + ★F2 并入的本工具受管条目;仅用户级非受管项可勾删,默认不勾选,§3 红线 3)、
 * ★F3 系统环境变量区(HKLM;默认只读,设置开关打开 + 管理员才可增改删非内置变量)、
 * 状态备份区([恢复此状态]→env:restore,标用户/系统)、底部 [重新体检] + 汇总。
 * 数据 = env:audit/env:state/env:system-list,全部判定复用 core 原语(shell 装配),组件只展示。
 */
import { computed, onMounted, ref } from 'vue';
import {
  NButton, NSpace, NAlert, NTag, NCheckbox, NPopconfirm, NSpin, NEmpty, NModal, NInput, NSelect, useMessage, useDialog,
} from 'naive-ui';
import { api$, DevkitError } from '../api';
import type { EnvAuditView, EnvPathRowView, EnvStateView, ManagedEntryView, SystemEnvView, SystemVarView } from '../../../shared/ipc';

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
    const [a, st] = await Promise.all([api$.envAudit(), api$.envState().catch(() => null), loadSystem()]);
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

// —— PATH 检测表(§4.4 外部条目区 → ★F2 升格为全量表:本工具受管条目也入列并打「受管」标签)
//    可勾删的只有"用户级 ∧ 非受管"两类;系统项只读(写只碰 HKCU,红线 §3.1),受管项由向导维护。
const rows = computed(() => audit.value?.rows ?? []);
const selectable = (r: EnvPathRowView): boolean => r.scope === 'user' && !r.managed;
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(r.raw) && selectable(r)));
const boxTitle = (r: EnvPathRowView): string => {
  if (r.managed) return '本工具受管条目:由向导「接入环境」维护,不在此清理(防误删自己的入口)';
  if (r.scope === 'system') return '系统级(HKLM)条目:本工具只读,不代删 —— 请到 设置→系统环境变量 处理';
  return '勾选后可清理(需确认)';
};

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

// —— ★F3 系统环境变量(HKLM):默认只读;设置页开关打开且进程为管理员才可增/改/删非内置变量
const sys = ref<SystemEnvView | null>(null);
const sysBusy = ref(false);
const sysForm = ref<{ name: string; value: string; kind: string; isNew: boolean } | null>(null);
/** 弹窗可见性 = sysForm 是否存在(表单即状态,省一个开关变量) */
const sysFormOpen = computed({
  get: () => sysForm.value !== null,
  set: (v: boolean) => {
    if (!v) sysForm.value = null;
  },
});

async function loadSystem(): Promise<void> {
  try {
    sys.value = await api$.envSystemList();
  } catch {
    sys.value = null; // 读不到(HKLM 不可达/桥未接)按"不可读"降级,不影响用户 PATH 体检
  }
}
function startAdd(): void {
  sysForm.value = { name: '', value: '', kind: 'ExpandString', isNew: true };
}
function startEdit(r: SystemVarView): void {
  sysForm.value = { name: r.name, value: r.value, kind: r.kind === 'String' ? 'String' : 'ExpandString', isNew: false };
}
async function saveSystem(): Promise<void> {
  const f = sysForm.value;
  if (!f) return;
  if (!f.name.trim()) {
    msg.warning('变量名不能为空');
    return;
  }
  sysBusy.value = true;
  try {
    await api$.envSystemSet(f.name.trim(), f.value, f.kind);
    msg.success(`已写入系统变量 ${f.name.trim()}(快照已存,可在下方或历史页回滚)`);
    sysForm.value = null;
    await Promise.all([loadSystem(), reload()]);
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    sysBusy.value = false;
  }
}
async function removeSystem(r: SystemVarView): Promise<void> {
  sysBusy.value = true;
  try {
    await api$.envSystemRemove(r.name);
    msg.success(`已删除系统变量 ${r.name}(快照已存)`);
    await Promise.all([loadSystem(), reload()]);
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    sysBusy.value = false;
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

      <!-- ★F2 PATH 检测表:全量(user + system + 本工具受管);仅「用户级 ∧ 非受管」可勾删 -->
      <div class="sec-title" style="margin-top: 26px">
        PATH 条目体检(用户 + 系统)
        <n-popconfirm v-if="selectedRows.length > 0" @positive-click="prune">
          <template #trigger>
            <n-button size="tiny" type="error" :loading="pruning">清理所选({{ selectedRows.length }})</n-button>
          </template>
          将从<b>用户</b> PATH 删除以下条目(写前自动备份,可回滚):<br />
          <span v-for="r in selectedRows.slice(0, 8)" :key="r.raw" class="mono" style="font-size: 12px">{{ r.raw }}<br /></span>
          <span v-if="selectedRows.length > 8">…等 {{ selectedRows.length }} 条</span>
        </n-popconfirm>
      </div>
      <table v-if="rows.length > 0" class="env-table">
        <thead>
          <tr><th style="width: 34px"></th><th>条目</th><th>区</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.scope + '|' + r.raw" :class="{ bad: r.missing }">
            <td>
              <n-checkbox
                :checked="selected.has(r.raw)"
                :disabled="!selectable(r)"
                :title="boxTitle(r)"
                @update:checked="(v: boolean) => toggle(r.raw, v)"
              />
            </td>
            <td class="mono" :title="r.expanded === r.raw ? r.raw : r.raw + ' → ' + r.expanded">
              {{ r.expanded }}
              <n-tag v-if="r.managed" size="tiny" type="info" :bordered="false" style="margin-left: 6px">受管</n-tag>
            </td>
            <td><n-tag size="tiny" :bordered="false">{{ r.scope === 'user' ? '用户' : '系统(只读)' }}</n-tag></td>
            <td>
              <span v-if="r.missing" style="color: #d03050">⚠ 指向不存在的目录</span>
              <span v-else-if="r.duplicated" style="color: #d98320">疑似重复(有效 PATH 中出现多次)</span>
              <span v-else class="muted">正常</span>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else description="PATH 为空" style="margin: 18px 0" />

      <!-- ★F3 系统环境变量(HKLM):默认只读;开关打开且管理员才可增改删【非内置】变量 -->
      <div class="sec-title" style="margin-top: 26px">
        系统环境变量(HKLM)
        <n-tag size="tiny" :bordered="false" :type="sys?.enabled ? 'warning' : 'default'">
          {{ sys?.enabled ? '写入已开启' : '写入已关闭(默认)' }}
        </n-tag>
        <n-tag v-if="sys?.enabled" size="tiny" :bordered="false" :type="sys.elevated ? 'success' : 'error'">
          {{ sys.elevated ? '管理员' : '非管理员' }}
        </n-tag>
        <n-button v-if="sys?.enabled" size="tiny" type="primary" @click="startAdd">＋ 新增系统变量</n-button>
      </div>
      <n-alert v-if="sys && !sys.enabled" type="default" :bordered="false" style="font-size: 12px; margin-bottom: 8px">
        系统级写入默认关闭。到 <router-link to="/settings">设置 → 系统环境变量</router-link> 打开后,可新增 / 修改 / 删除
        <b>非内置</b>的系统变量;Windows 内置变量(Path、SystemRoot、TEMP…)与系统 Path 任何情况下都只读。
      </n-alert>
      <n-alert v-else-if="sys?.enabled && !sys.elevated" type="warning" :bordered="false" style="font-size: 12px; margin-bottom: 8px">
        当前进程不是管理员:可以查看,但写入会被系统拒绝 —— 请以<b>管理员身份</b>重新运行 DevKit。
      </n-alert>
      <n-alert v-if="sys && sys.rows === null" type="warning" :bordered="false" style="font-size: 12px">
        系统环境变量读取失败(注册表不可达或权限受限),本次不展示。
      </n-alert>
      <table v-else-if="(sys?.rows?.length ?? 0) > 0" class="env-table">
        <thead>
          <tr><th>名称</th><th>类型</th><th>值</th><th style="text-align: right">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in sys!.rows!" :key="r.name">
            <td class="mono">
              {{ r.name }}
              <n-tag v-if="r.protected" size="tiny" :bordered="false" style="margin-left: 6px" title="Windows 内置变量:本工具不修改、不删除">内置·只读</n-tag>
            </td>
            <td class="muted">{{ r.kind === 'ExpandString' ? 'REG_EXPAND_SZ' : 'REG_SZ' }}</td>
            <td class="mono muted" :title="r.value">{{ r.value }}</td>
            <td style="text-align: right">
              <n-space justify="end" size="small">
                <n-button size="tiny" :disabled="r.protected || !sys?.enabled || !sys?.elevated" @click="startEdit(r)">改</n-button>
                <n-popconfirm v-if="!r.protected && sys?.enabled" @positive-click="removeSystem(r)">
                  <template #trigger>
                    <n-button size="tiny" type="error" :disabled="!sys?.elevated">删</n-button>
                  </template>
                  将从<b>系统</b>(HKLM)删除变量 <b class="mono">{{ r.name }}</b>(写前自动快照,可回滚)。确认?
                </n-popconfirm>
              </n-space>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else-if="sys" description="系统环境变量为空" style="margin: 18px 0" />

      <!-- 状态备份区(§4.4) -->
      <div class="sec-title" style="margin-top: 26px">状态备份(每次写入前的全量快照)</div>
      <table v-if="(state?.backups.length ?? 0) > 0" class="env-table">
        <thead>
          <tr><th>时间</th><th>区</th><th>包含键</th><th style="text-align: right">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="b in state!.backups" :key="b.file">
            <td class="mono">{{ when(b.ts) }}</td>
            <td><n-tag size="tiny" :bordered="false">{{ b.scope === 'system' ? '系统' : '用户' }}</n-tag></td>
            <td class="muted">{{ b.names.join(', ') || '(空环境 = 接入前)' }}</td>
            <td style="text-align: right">
              <n-popconfirm @positive-click="restore(b.file)">
                <template #trigger>
                  <n-button size="tiny">恢复此状态</n-button>
                </template>
                将把{{ b.scope === 'system' ? '系统(HKLM)' : '用户' }}环境变量<b>全量</b>恢复到 {{ when(b.ts) }} 时刻(当前值先不留档)。确认?
              </n-popconfirm>
            </td>
          </tr>
        </tbody>
      </table>
      <n-empty v-else description="还没有备份 —— 每次环境写入前都会自动存一份" style="margin: 18px 0" />

      <!-- ★F3 系统变量 新增/修改 面板 -->
      <n-modal v-model:show="sysFormOpen" preset="card" :title="sysForm?.isNew ? '新增系统变量' : '修改系统变量'" style="width: 560px" :mask-closable="false">
        <n-space vertical size="medium">
          <div>
            <div class="fld">变量名</div>
            <n-input v-model:value="sysForm!.name" size="small" :disabled="!sysForm?.isNew" placeholder="例如 JAVA_HOME" style="width: 320px" />
          </div>
          <div>
            <div class="fld">值</div>
            <n-input v-model:value="sysForm!.value" size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" placeholder="例如 C:\Program Files\Java\jdk-21" />
          </div>
          <div>
            <div class="fld">类型</div>
            <n-select
              v-model:value="sysForm!.kind"
              size="small"
              style="width: 320px"
              :options="[
                { label: 'REG_EXPAND_SZ(推荐:保留 %VAR% 引用)', value: 'ExpandString' },
                { label: 'REG_SZ(纯字符串)', value: 'String' },
              ]"
            />
          </div>
          <n-alert type="warning" :bordered="false" style="font-size: 12px">
            这是<b>系统级</b>写入(HKLM,影响本机所有用户),写入前会自动存快照。Windows 内置变量名与系统 Path 会被拒绝。
          </n-alert>
          <n-space justify="end">
            <n-button size="small" @click="sysForm = null">取消</n-button>
            <n-button size="small" type="primary" :loading="sysBusy" @click="saveSystem">写入系统变量</n-button>
          </n-space>
        </n-space>
      </n-modal>
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
.fld {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
</style>
