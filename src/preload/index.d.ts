import type { DevkitApi } from '../shared/ipc';

declare global {
  interface Window {
    /** preload contextBridge 注入(§8);renderer 只经 api.ts 包装层触碰 */
    devkit: DevkitApi;
  }
}

export {};
