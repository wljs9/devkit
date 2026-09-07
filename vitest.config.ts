import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * §11 分层测试:
 * - core 项目:node 环境,直接 import core/*,零 Electron(arch.test 亦在此把关铁律);
 * - renderer 项目:happy-dom,@vue/test-utils 冒烟(组件哑、逻辑在 pinia store,重点测 store)。
 * 两项目 include 互斥,避免 renderer 测试误入 node 环境。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['tests/**/*.test.ts', '!tests/renderer/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        plugins: [vue()], // renderer 冒烟会 import App.vue(SFC),需 vue 插件转换
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['tests/renderer/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
