/**
 * window.devkit 的类型化包装(技术手册 §4:组件只碰这层)。
 * 存在性防御:纯 Node 测试(vitest projects 的 renderer 用 happy-dom,window.devkit 不存在)
 * 与 Electron 真环境共用一份代码,故缺失时抛带内码的 ApiUnavailable。
 */
import type { DevkitApi } from '../../shared/ipc';

export class ApiUnavailable extends Error {
  constructor() {
    super('DevKit 主进程 IPC 不可用(非 Electron 运行环境)');
    this.name = 'ApiUnavailable';
  }
}

function api(): DevkitApi {
  if (typeof window === 'undefined' || !window.devkit) throw new ApiUnavailable();
  return window.devkit;
}

/** 统一解包 §8 判别联合:成功取 data,失败抛结构化错误(仅在本包装层内,不跨进程) */
async function unwrap<T>(p: Promise<{ ok: boolean; data?: T; code?: string; message?: string }>): Promise<T> {
  const r = (await p) as { ok: true; data: T } | { ok: false; code: string; message: string };
  if (r.ok) return r.data;
  throw new DevkitError(r.code, r.message);
}

export class DevkitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DevkitError';
    this.code = code;
  }
}

export const api$ = {
  catalogList: () => unwrap(api().catalogList()),
  catalogVersions: (tool: string, force = false) => unwrap(api().catalogVersions({ tool, force })),
  downloadStart: (tool: string, version: string, sourceId?: string) => unwrap(api().downloadStart({ tool, version, sourceId })),
  downloadCancel: (taskId: string) => unwrap(api().downloadCancel(taskId)),
  onDownloadProgress: (cb: Parameters<DevkitApi['onDownloadProgress']>[0]) => api().onDownloadProgress(cb),
  installList: () => unwrap(api().installList()),
  installSwitch: (tool: string, version: string) => unwrap(api().installSwitch({ tool, version })),
  installUninstall: (tool: string, version: string) => unwrap(api().installUninstall({ tool, version })),
  envState: () => unwrap(api().envState()),
  envAudit: () => unwrap(api().envAudit()),
  envPrune: (entries: string[]) => unwrap(api().envPrune({ entries })),
  envRestore: (file: string) => unwrap(api().envRestore({ file })),
  historyList: (kind?: string, limit?: number) => unwrap(api().historyList({ kind, limit })),
  settingsGet: () => unwrap(api().settingsGet()),
  settingsSet: (patch: Parameters<DevkitApi['settingsSet']>[0]) => unwrap(api().settingsSet(patch)),
  cacheClear: () => unwrap(api().cacheClear()),
  setupDefaults: () => unwrap(api().setupDefaults()),
  setupCheck: (devRoot: string) => unwrap(api().setupCheck({ devRoot })),
  setupPreview: (devRoot: string) => unwrap(api().setupPreview({ devRoot })),
  setupRun: (devRoot: string) => unwrap(api().setupRun({ devRoot })),
  openPath: (p: string) => unwrap(api().openPath(p)),
};
