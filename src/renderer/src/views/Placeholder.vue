<script setup lang="ts">
// 环境/历史/设置三页属 M3(技术手册 §13);M2 仅占位保证侧边栏 4 页框架完整、导航不炸。
import { NEmpty } from 'naive-ui';
import { useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <div class="page">
    <n-empty
      :description="`「${route.meta.title}」页面将在 ${route.meta.milestone ?? '后续'} 里程碑实现`"
      style="margin-top: 80px"
    />
  </div>
</template>
