<script setup lang="ts">
/**
 * 设置页(产品 §4.6):DevRoot / 网络(代理+并发+GitHub 加速器前缀)/
 * ★C2 系统 PATH(HKLM)写开关(默认关,开启需二次确认)/ 缓存目录 + [清理缓存] / 关于。
 * ★C1(2026-09-20):「镜像源优先级」区块整段移除 —— 源切换在商店版本行完成,
 * 且工具数增长后此区挤占页面空间;ghproxy 前缀设置挪入独立卡保留(风险登记 §12)。
 * 数据 api$.settingsGet;写全部走 settings:set(§8 判别联合,main 侧清洗)。
 */
import { computed, onMounted, ref } from 'vue';
import {
  NButton, NSpace, NInput, NInputNumber, NCard, NSelect, NPopconfirm, NAlert, NSwitch, useMessage, useDialog,
} from 'naive-ui';
import { api$, DevkitError } from '../api';
import type { SettingsView } from '../../../shared/ipc';

const msg = useMessage();
const dialog = useDialog();
const settings = ref<SettingsView | null>(null);
const devRootDraft = ref('');
const proxyDraft = ref('');
const concDraft = ref(2);
const saving = ref<Record<string, boolean>>({});

async function load(): Promise<void> {
  try {
    settings.value = await api$.settingsGet();
    devRootDraft.value = settings.value?.devRoot ?? '';
    proxyDraft.value = settings.value?.proxy ?? '';
    concDraft.value = settings.value?.concurrency ?? 2;
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}

async function patch(label: string, p: Partial<SettingsView>): Promise<void> {
  if (!settings.value) return;
  saving.value[label] = true;
  try {
    settings.value = await api$.settingsSet(p);
    msg.success('已保存');
  } catch (e) {
    msg.error((e as DevkitError).message);
  } finally {
    saving.value[label] = false;
  }
}

// —— ghproxy 加速器前缀(风险登记 §12:第三方代理可换/可关)。三态:目录默认 / 直连 / 自定义
type PrefixMode = 'default' | 'direct' | 'custom';
const prefixMode = computed<PrefixMode>(() => {
  const v = settings.value?.sourcePrefixes['ghproxy'];
  return v === undefined ? 'default' : v === '' ? 'direct' : 'custom';
});
const prefixDraft = ref('');
const PREFIX_OPTIONS = [
  { label: '目录默认(ghfast.top)', value: 'default' },
  { label: '不用代理(直连 GitHub)', value: 'direct' },
  { label: '自定义前缀…', value: 'custom' },
];
async function setPrefixMode(mode: PrefixMode): Promise<void> {
  const sp = { ...(settings.value?.sourcePrefixes ?? {}) };
  if (mode === 'default') delete sp['ghproxy'];
  else sp['ghproxy'] = mode === 'direct' ? '' : prefixDraft.value.trim();
  await patch('prefix', { sourcePrefixes: sp });
}
async function applyCustomPrefix(): Promise<void> {
  const v = prefixDraft.value.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) {
    msg.error('前缀须为 http(s):// 开头的 URL(以 / 结尾,如 https://gh-proxy.com/)');
    return;
  }
  await patch('prefix', { sourcePrefixes: { ...(settings.value?.sourcePrefixes ?? {}), ghproxy: v } });
}

// —— ★C2 系统 PATH 写开关(F3 开关收窄):默认关;开启走二次确认(产品文档 §3.1"动系统级必须显式二次确认")
async function toggleSystem(v: boolean): Promise<void> {
  if (!v) {
    await patch('allowSystem', { allowSystemEnv: false });
    msg.success('已关闭系统 PATH 写入');
    return;
  }
  dialog.warning({
    title: '开启系统 PATH 写入?',
    content: '开启后,「环境」页可以向本机【系统级】PATH(注册表 HKLM)追加条目。\n\n· 只支持"追加一条":修改与删除本工具不提供(请到 Windows 设置 → 系统环境变量 手动处理);\n· 每次写入前自动存快照,可在环境页/历史页回滚;\n· 真正写入需要以【管理员身份】运行 DevKit。',
    positiveText: '我明白,开启',
    negativeText: '取消',
    onPositiveClick: () => {
      void patch('allowSystem', { allowSystemEnv: true });
    },
  });
}

// —— 缓存 / 关于
const mb = (n: number): string => (n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function clearCache(): Promise<void> {
  try {
    const r = await api$.cacheClear();
    msg.success(`已清理 ${r.files} 个缓存文件(${mb(r.bytes)})`);
    await load();
  } catch (e) {
    msg.error((e as DevkitError).message);
  }
}
function checkUpdate(): void {
  msg.info(`当前 v${settings.value?.appVersion ?? '?'};更新渠道在发布(M4)后接入,此处为手动检查占位`);
}

onMounted(load);</script>

<template>
  <div class="page" style="max-width: 760px">
    <h3 style="margin: 0 0 14px">设置</h3>

    <n-card title="DevRoot(安装根目录)" size="small" style="margin-bottom: 16px">
      <n-space align="center">
        <n-input v-model:value="devRootDraft" size="small" style="width: 320px" placeholder="D:\dev" />
        <n-button
          size="small"
          type="primary"
          :loading="saving['devRoot']"
          :disabled="devRootDraft === (settings?.devRoot ?? '')"
          @click="patch('devRoot', { devRoot: devRootDraft })"
        >应用</n-button>
      </n-space>
      <n-alert type="info" :bordered="false" style="margin-top: 10px; font-size: 12px">
        改动仅影响<b>后续安装</b>,已有安装与 current\ 不迁移;若 PATH 固定条目需指向新根,请到「环境」页重新接入。
      </n-alert>
    </n-card>

    <n-card title="网络" size="small" style="margin-bottom: 16px">
      <n-space align="center" style="margin-bottom: 10px">
        <span class="sec-title" style="margin: 0">代理 URL</span>
        <n-input v-model:value="proxyDraft" size="small" style="width: 300px" placeholder="http://127.0.0.1:7890(留空=跟随系统)" />
        <n-button size="small" :loading="saving['proxy']" @click="patch('proxy', { proxy: proxyDraft })">保存</n-button>
      </n-space>
      <n-space align="center" style="margin-bottom: 10px">
        <span class="sec-title" style="margin: 0">下载并发</span>
        <n-input-number v-model:value="concDraft" size="small" :min="1" :max="6" style="width: 110px" />
        <n-button size="small" :loading="saving['conc']" @click="patch('conc', { concurrency: concDraft ?? 2 })">保存</n-button>
      </n-space>
      <div class="sec-title">GitHub 加速器前缀(JDK 历史版本 ghproxy 源)</div>
      <n-space align="center">
        <n-select :value="prefixMode" size="small" style="width: 220px" :options="PREFIX_OPTIONS" @update:value="(v: PrefixMode) => setPrefixMode(v)" />
        <template v-if="prefixMode === 'custom'">
          <n-input v-model:value="prefixDraft" size="small" style="width: 260px" placeholder="https://gh-proxy.com/" />
          <n-button size="small" type="primary" @click="applyCustomPrefix">应用前缀</n-button>
        </template>
      </n-space>
    </n-card>

    <n-card title="系统 PATH(HKLM,高级,默认关闭)" size="small" style="margin-bottom: 16px">
      <n-space align="center" justify="space-between" :wrap="false">
        <div style="font-size: 13px; max-width: 520px">
          ★C2 口径:打开后仅可在「环境」页向<b>系统 PATH</b> <b>追加条目</b>。
          修改与删除本工具不提供(请到 Windows 设置 → 系统环境变量 手动处理);每次写入前自动快照,可回滚;写入需要<b>管理员权限</b>。
        </div>
        <n-switch
          :value="settings?.allowSystemEnv ?? false"
          :loading="saving['allowSystem']"
          @update:value="(v: boolean) => toggleSystem(v)"
        />
      </n-space>
    </n-card>

    <n-card title="下载缓存" size="small" style="margin-bottom: 16px">
      <n-space align="center" justify="space-between">
        <div style="font-size: 13px">
          <template v-if="settings?.cache">
            <div class="mono muted">{{ settings.cache.dir }}</div>
            <div>{{ settings.cache.files }} 个断点/暂存文件 · {{ mb(settings.cache.bytes) }}</div>
          </template>
          <span v-else class="muted">DevRoot 未选择</span>
        </div>
        <n-popconfirm v-if="settings?.cache" @positive-click="clearCache">
          <template #trigger>
            <n-button size="small" type="warning" :disabled="(settings.cache?.files ?? 0) === 0">清理缓存</n-button>
          </template>
          将删除 cache\ 下的下载断点与解压暂存(不影响已安装工具与进行中任务)。确认?
        </n-popconfirm>
      </n-space>
    </n-card>

    <n-card title="关于" size="small">
      <n-space align="center" justify="space-between">
        <div style="font-size: 13px">
          DevKit v{{ settings?.appVersion ?? '?' }} · 目录清单 {{ settings?.catalogVersion ?? '?' }}
        </div>
        <n-button size="small" @click="checkUpdate">检查更新</n-button>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.sec-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
</style>
