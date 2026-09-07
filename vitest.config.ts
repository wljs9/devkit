import { defineConfig } from 'vitest/config';

// §11 分层:core 测试跑 node 环境(直接 import core/*,零 Electron)。
// renderer 项目(happy-dom)在 M2 脚手架落地后加入 projects。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // core 铁律检查依赖显式 import 顺序,单进程串行更稳(带真实文件/端口)
    pool: 'forks',
  },
});
