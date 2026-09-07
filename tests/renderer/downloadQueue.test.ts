/**
 * §11 renderer 重点测 store(组件哑):downloadQueue 进度聚合。
 * 跑在 vitest renderer 项目(happy-dom 环境)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDownloadQueue } from '../../src/renderer/src/stores/downloadQueue';
import type { DownloadProgressEvent } from '../../src/shared/ipc';

const ev = (over: Partial<DownloadProgressEvent>): DownloadProgressEvent => ({
  id: 'node-22.17.1', tool: 'node', version: '22.17.1', status: 'downloading', received: 0, total: 100, speed: 0, ...over,
});

describe('downloadQueue store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('downloading 事件计入 activeCount,同 id 覆盖不重复', () => {
    const q = useDownloadQueue();
    q.ingest(ev({ received: 10 }));
    q.ingest(ev({ received: 20 })); // 同 id 进度刷新
    expect(Object.keys(q.tasks)).toHaveLength(1);
    expect(q.tasks['node-22.17.1']!.received).toBe(20);
    expect(q.activeCount).toBe(1);
  });

  it('done 使 activeCount 归零并自增 doneTick(仅一次)', () => {
    const q = useDownloadQueue();
    q.ingest(ev({ status: 'downloading' }));
    const t0 = q.doneTick;
    q.ingest(ev({ status: 'done' }));
    expect(q.activeCount).toBe(0);
    expect(q.doneTick).toBe(t0 + 1);
    q.ingest(ev({ status: 'done' })); // 重复 done 不再自增
    expect(q.doneTick).toBe(t0 + 1);
  });

  it('queued 也算 active;failed/cancelled 不算', () => {
    const q = useDownloadQueue();
    q.ingest(ev({ id: 'a', status: 'queued' }));
    q.ingest(ev({ id: 'b', status: 'failed', error: { code: 'x', message: 'y' } }));
    q.ingest(ev({ id: 'c', status: 'cancelled' }));
    expect(q.activeCount).toBe(1);
  });

  it('clearFinished 只清终态任务,保留进行中', () => {
    const q = useDownloadQueue();
    q.ingest(ev({ id: 'd', status: 'done' }));
    q.ingest(ev({ id: 'r', status: 'downloading' }));
    q.clearFinished();
    expect(q.tasks['d']).toBeUndefined();
    expect(q.tasks['r']).toBeDefined();
  });
});
