/**
 * IPC 契约守卫(§8):通道对账 + Result 判别联合 + 线上 DTO 与 core 记录不漂移。
 * 纯 node 项目运行;import shared 与 core 皆"仅类型/常量",不触发 electron。
 */
import { describe, expect, it } from 'vitest';
import { Channel, PushChannel } from '../src/shared/ipc';
import type { DevkitApi, DownloadProgressEvent, EnvAuditView, InstallView } from '../src/shared/ipc';
import type { InstallRecord } from '../src/main/core/store';

// 以 (keyof T)[] 标注:字段名漂移/笔误会在【编译期】报错 —— 这才是"防契约漂移"的门禁本意。
const RECORD_FIELDS: (keyof InstallRecord)[] = [
  'id', 'tool', 'version', 'path', 'sourceId', 'sourceUrl', 'sha256', 'size', 'installedAt', 'isCurrent',
];
const VIEW_FIELDS: (keyof InstallView)[] = [
  'id', 'tool', 'version', 'path', 'sourceId', 'sourceUrl', 'size', 'installedAt', 'isCurrent',
];

describe('§8 通道全集', () => {
  it('§8 点名的通道全部在册', () => {
    const required = [
      'catalog:list', 'catalog:versions', 'download:start', 'download:cancel',
      'install:list', 'install:switch', 'install:uninstall',
      'env:state', 'env:audit', 'env:prune', 'env:restore',
      'history:list', 'settings:get', 'settings:set', 'setup:run',
    ];
    const present = Object.values(Channel);
    for (const r of required) expect(present, `缺通道 ${r}`).toContain(r);
  });

  it('通道名唯一,无重复字面量', () => {
    const vals = Object.values(Channel);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('M2/M3 在 §8 全集之外新增的通道全部在册(集中定义防散落)', () => {
    for (const c of ['setup:preview', 'setup:defaults', 'setup:check', 'shell:open-path', 'cache:clear']) {
      expect(Object.values(Channel), `缺通道 ${c}`).toContain(c);
    }
  });

  it('M3 体检/清理 DTO 可 JSON 往返(§8 判别联合前提)', () => {
    const audit: EnvAuditView = {
      devRoot: 'D:\\dev',
      managed: [{ label: '%JAVA_HOME%\\bin', kind: 'path', value: '%JAVA_HOME%\\bin', present: true, targetOk: false }],
      rows: [
        { raw: 'C:\\ghost\\bin', expanded: 'C:\\ghost\\bin', scope: 'user', missing: true, duplicated: false, managed: false },
        { raw: 'C:\\Windows\\system32', expanded: 'C:\\Windows\\system32', scope: 'system', missing: false, duplicated: true, managed: false },
      ],
      systemReadable: true,
      summary: { total: 23, missing: 2, duplicates: 1 },
    };
    const back = JSON.parse(JSON.stringify(audit)) as EnvAuditView;
    expect(back).toEqual(audit); // 决策 A 语义:present=true 且 targetOk=false = "⚠ 失效/悬空"
  });

  it('invoke 通道与 push 通道不冲突(§8:请求-响应 vs webContents.send 分轨)', () => {
    for (const p of Object.values(PushChannel)) {
      expect(Object.values(Channel)).not.toContain(p);
    }
  });

  it('S2 收口:openPath 契约签名为 (installId: string) → Result<null>(任意路径不进契约)', () => {
    // 编译期守卫:把 openPath 钉成"收 installId 出 Result"的形状 —— 参数改回路径对象/多参会在此行类型报错
    const impl: DevkitApi['openPath'] = (_installId: string) => Promise.resolve({ ok: true as const, data: null });
    expect(impl.length).toBe(1);
    return impl('node-22.20.0').then((r) => expect(r).toEqual({ ok: true, data: null }));
  });
});

describe('Result 判别联合可 JSON 往返(IPC 结构化克隆前置条件)', () => {
  it('成功与失败两支都能无损序列化', () => {
    const ok = { ok: true as const, data: [{ id: 'n', tool: 'node', version: '22.0.0', path: 'p', sourceId: 'huawei', sourceUrl: 'u', size: 1, installedAt: 't', isCurrent: true } satisfies InstallView] };
    const fail = { ok: false as const, code: 'no-devroot', message: '请先完成首跑向导' };
    for (const r of [ok, fail]) {
      const back = JSON.parse(JSON.stringify(r)) as typeof r;
      expect(back).toEqual(r);
    }
  });

  it('进度事件不携带函数/Error 实例(§8:异常不跨进程裸抛)', () => {
    const ev: DownloadProgressEvent = {
      id: 'node-22.0.0', tool: 'node', version: '22.0.0', status: 'failed',
      received: 0, total: -1, speed: 0, error: { code: 'download-net-timeout', message: '超时', switchable: true },
    };
    const s = JSON.stringify(ev);
    expect(s).not.toMatch(/function|\[object Error\]/);
    expect(JSON.parse(s)).toEqual(ev);
  });
});

describe('DTO 与 core 记录字段对齐(防契约漂移)', () => {
  it('InstallView 覆盖 core InstallRecord 全部字段(仅 sha256 有意不上行)', () => {
    const viewKeys = new Set<string>(VIEW_FIELDS);
    const missing = RECORD_FIELDS.filter((k) => !viewKeys.has(k));
    expect(missing).toEqual(['sha256']); // 唯一刻意省略项
    // 反向:DTO 不得凭空多字段(多者会让 ipc.ts 的 map 编译通过但 core 无源,视为漂移)
    const recKeys = new Set<string>(RECORD_FIELDS);
    expect(VIEW_FIELDS.filter((k) => !recKeys.has(k))).toEqual([]);
  });
});
