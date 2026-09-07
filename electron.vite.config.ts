import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

/**
 * electron-vite 三入口(技术手册 §2/§4)。仓库根即工程根(§2),不另起子工程。
 * - main / preload:Node 侧,externalizeDepsPlugin 把依赖留外部(尤其 electron),core 打进产物;
 * - renderer:Vite + Vue,`@shared` 别名让 IPC 契约与 main/preload 同源(§8 单一事实源)。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [vue()],
  },
});
