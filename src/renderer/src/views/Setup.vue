<script setup lang="ts">
/**
 * 首跑向导(产品 §4.0),两步:
 *   步骤1 DevRoot:默认探测值 + 校验(reasons 拦截/warnings 提示)+ 将建目录结构预览;
 *   步骤2 PATH diff:setupPreview 展示"改前/改后"→ 确认才 setupRun(§7.2 写入协议在 main 侧)。
 * 逻辑全在 api$/store,组件哑(§11)。完成/拒绝写 PATH 均可进主界面(黄条常驻)。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NSteps, NStep, NCard, NInput, NButton, NSpace, NAlert, NResult, NCheckbox, NDescriptions, NDescriptionsItem, useMessage,
} from 'naive-ui';
import { api$, DevkitError } from '../api';

const router = useRouter();
const msg = useMessage();

const step = ref(1);
const devRoot = ref('');
const check = ref<{ ok: boolean; reasons: string[]; warnings: string[] } | null>(null);
const preview = ref<{ willAdd: string[]; javaHome: string; noop: boolean; warnings: string[] } | null>(null);
const confirmWrite = ref(false);
const submitting = ref(false);
const done = ref<{ applied: string[]; broadcast: string | null } | null>(null);

const rootCheckOk = computed(() => check.value?.ok === true && devRoot.value.trim().length > 0);

// 目录结构预览:字符串在脚本里拼,避免模板把 <tool>/<version> 当 HTML 标签解析(§5)
const treeText = computed(() => {
  const r = devRoot.value.trim() || '<DevRoot>';
  return `${r}\\\n├─ tools\\<tool>\\<version>\\   # 真实文件,多版本并存\n├─ current\\<tool>           # 联接(切换 = 只改指向)\n└─ cache\\                   # 下载缓存与断点`;
});

async function loadDefaults(): Promise<void> {
  const r = await api$.setupDefaults();
  devRoot.value = r.devRoot;
  check.value = r.check;
}
onMounted(() => void loadDefaults());

// 输入时实时校验:走 setupCheck(纯 checkDevRoot,不读注册表);diff 只在进第 2 步时算一次
async function onRootInput(): Promise<void> {
  const root = devRoot.value.trim();
  if (!root) {
    check.value = { ok: false, reasons: ['请输入 DevRoot 路径'], warnings: [] };
    return;
  }
  const r = await api$.setupCheck(root).catch(() => null);
  if (r) check.value = r;
}

async function toStep2(): Promise<void> {
  if (!rootCheckOk.value) return;
  submitting.value = true;
  try {
    preview.value = await api$.setupPreview(devRoot.value);
    if (preview.value.noop && preview.value.willAdd.length === 0) {
      msg.info('PATH 已包含全部条目,无需改动');
    }
    step.value = 2;
  } catch (e) {
    msg.error((e as DevkitError).message ?? String(e));
  } finally {
    submitting.value = false;
  }
}

async function finishSetup(): Promise<void> {
  if (!confirmWrite.value || !preview.value) return;
  submitting.value = true;
  try {
    const r = await api$.setupRun(devRoot.value);
    done.value = { applied: r.applied, broadcast: r.broadcast };
  } catch (e) {
    msg.error(`写入失败(已自动回滚):${(e as DevkitError).message ?? String(e)}`);
  } finally {
    submitting.value = false;
  }
}

function skipPath(): void {
  void api$.settingsSet({ devRoot: devRoot.value }).catch(() => undefined); // 拒绝写 PATH 仍可装/切(§4.0)
  void router.push({ name: 'store' });
}
</script>

<template>
  <div class="page" style="max-width: 720px; margin: 0 auto">
    <h2>欢迎使用 DevKit</h2>
    <n-steps :current="step" style="margin: 20px 0">
      <n-step title="选择安装根目录 DevRoot" />
      <n-step title="接入环境变量" />
    </n-steps>

    <n-card v-if="step === 1" :bordered="false" class="setup-card">
      <p>DevKit 会把工具解压到 DevRoot 下,并只向用户 PATH 添加固定的几条目(终身不变,切换版本零改 PATH)。</p>
      <n-space vertical>
        <div>
          <label>DevRoot 路径:</label>
          <n-input v-model:value="devRoot" placeholder="如 D:\dev" @update:value="onRootInput" />
        </div>
        <n-alert v-if="check && !check.ok" type="error" title="该路径不可用">
          <ul style="margin: 4px 0 0; padding-left: 18px">
            <li v-for="r in check.reasons" :key="r">{{ r }}</li>
          </ul>
        </n-alert>
        <n-alert v-for="w in check?.warnings ?? []" :key="w" type="warning" :show-icon="true">{{ w }}</n-alert>
        <pre class="tree">{{ treeText }}</pre>
        <n-space justify="end">
          <n-button type="primary" :disabled="!rootCheckOk" :loading="submitting" @click="toStep2">下一步</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card v-else-if="step === 2 && preview" :bordered="false">
      <p>DevKit 将对<b>用户级</b>环境变量做如下改动(写入前自动全量备份,失败自动回滚):</p>
      <n-descriptions :column="1" bordered>
        <n-descriptions-item label="JAVA_HOME">{{ preview.javaHome }}</n-descriptions-item>
        <n-descriptions-item label="PATH 新增">
          <div v-for="e in preview.willAdd" :key="e" class="mono diff-add">+ {{ e }}</div>
          <span v-if="preview.willAdd.length === 0" class="muted">(已存在,无新增)</span>
        </n-descriptions-item>
      </n-descriptions>
      <n-alert v-for="w in preview.warnings" :key="w" type="warning" style="margin-top: 10px">{{ w }}</n-alert>
      <p v-if="preview.noop" class="muted">现状已完全一致,点击完成不会做任何写入(幂等)。</p>
      <n-checkbox v-model:checked="confirmWrite" style="margin-top: 14px">我确认将以上条目写入用户 PATH(仅 HKCU,不动系统级)</n-checkbox>
      <n-space justify="space-between" style="margin-top: 18px">
        <n-button @click="skipPath">暂不接入,直接用</n-button>
        <n-button type="primary" :disabled="!confirmWrite" :loading="submitting" @click="finishSetup">确认并接入</n-button>
      </n-space>
    </n-card>

    <n-result v-if="done" status="success" title="环境已接入">
      <template #footer>
        <n-alert v-if="done.broadcast === 'timeout'" type="warning" style="text-align: left">
          广播超时:新开终端将立即生效,已开终端需重开(§6)。
        </n-alert>
        <n-button type="primary" @click="router.push({ name: 'store' })">进入软件商店</n-button>
      </template>
    </n-result>
  </div>
</template>

<style scoped>
.tree {
  background: #fafafa;
  border: 1px solid #efefef;
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
  overflow: auto;
}
.setup-card label {
  display: block;
  margin-bottom: 4px;
}
</style>
