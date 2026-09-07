/**
 * 下载队列 store(§4.2 / §8 推送):聚合 main 的 download:progress 事件。
 * §11 renderer 约定:逻辑都在 pinia,组件只读——本 store 是唯一持有进度状态的地方,冒烟测试重点。
 */
import { defineStore } from 'pinia';
import type { DownloadProgressEvent, DownloadTaskStatus } from '../../../shared/ipc';

export interface TaskRow {
  id: string;
  tool: string;
  version: string;
  status: DownloadTaskStatus;
  received: number;
  total: number;
  speed: number;
  error?: DownloadProgressEvent['error'];
}

export const useDownloadQueue = defineStore('downloadQueue', {
  state: () => ({
    tasks: {} as Record<string, TaskRow>,
    /** 安装完成事件通知(已安装页/商店页监听刷新) */
    doneTick: 0,
  }),
  getters: {
    /** 终态(done/failed/cancelled)之外的任务 = "进行中",顶栏角标依据(§4.2) */
    activeCount(state): number {
      return Object.values(state.tasks).filter((t) => t.status === 'queued' || t.status === 'downloading').length;
    },
    list(state): TaskRow[] {
      return Object.values(state.tasks).sort((a, b) => b.id.localeCompare(a.id));
    },
  },
  actions: {
    ingest(ev: DownloadProgressEvent): void {
      const prev = this.tasks[ev.id];
      this.tasks[ev.id] = {
        id: ev.id,
        tool: ev.tool,
        version: ev.version,
        status: ev.status,
        received: ev.received,
        total: ev.total,
        speed: ev.speed,
        error: ev.error,
      };
      if (ev.status === 'done' && prev?.status !== 'done') this.doneTick++;
    },
    clearFinished(): void {
      for (const [id, t] of Object.entries(this.tasks)) {
        if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') delete this.tasks[id];
      }
    },
  },
});
