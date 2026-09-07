/**
 * ipcMain.handle 注册表(技术手册 §4/§8):"仅参数转发,无逻辑"——业务全在 core/*,
 * 本层只做三件事:①通道 ⇔ core 调用装配;②core 结果 → 线上 DTO;③异常 → Result 判别联合。
 * §8 铁律:异常不许跨进程裸抛,故每个 handler 经 wrap() 兜底。
 */
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  Channel, PushChannel,
  type Result, type SettingsView, type DownloadProgressEvent, type DownloadTaskStatus, type ManagedEntryView,
} from '../shared/ipc';
import { CoreError, isCoreError } from './core/errors';
import type { CatalogEntry, DiscoveredVersion } from './core/catalog';
import { install, setCurrent, uninstall, ensureDevRoot, type InstallContext } from './core/install';
import { DownloadError } from './core/download';
import { envPlan, checkDevRoot, splitPathList, pathEntryEquals, mergePathEntries } from './core/paths';
import { initServices, suggestDevRoot, versionsOf, type Services } from './services';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
function fail(code: string, message: string): Result<never> {
  return { ok: false, code, message };
}

/** core 异常归一:code 机器可读(§8);DownloadError 带 switchable(§7.4 [换源]) */
function errInfo(e: unknown): { code: string; message: string; switchable: boolean } {
  if (e instanceof DownloadError) return { code: e.code, message: e.message, switchable: e.switchable };
  if (isCoreError(e)) return { code: e.code, message: e.message, switchable: false };
  return { code: 'internal', message: e instanceof Error ? e.message : String(e), switchable: false };
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    const { code, message } = errInfo(e);
    return fail(code, message);
  }
}

export function registerIpc(): void {
  const s = initServices();

  const entryOf = (tool: string): CatalogEntry => {
    const e = s.catalogs().get(tool);
    if (!e) throw new CoreError('unknown-tool', `目录中无工具:${tool}`);
    return e;
  };
  const ctx = (): InstallContext => ({ devRoot: requireDevRoot(s), downloader: s.downloader(), store: s.store, history: s.history });
  const findVersion = async (entry: CatalogEntry, version: string): Promise<DiscoveredVersion> => {
    const vs = await versionsOf(s, entry, false);
    const v = vs.find((x) => x.version === version);
    if (!v) throw new CoreError('version-unavailable', `目录中无版本 ${entry.id} ${version}(试试刷新)`);
    return v;
  };

  // —— 商店:清单 + 版本发现
  ipcMain.handle(Channel.CatalogList, () =>
    wrap(() => {
      const devRoot = s.getDevRoot();
      const installs = devRoot ? s.store.load().installs : [];
      return [...s.catalogs().values()].map((c) => ({
        id: c.id,
        displayName: c.displayName,
        installedCount: installs.filter((i) => i.tool === c.id).length,
        currentVersion: installs.find((i) => i.tool === c.id && i.isCurrent)?.version ?? null,
      }));
    }),
  );

  ipcMain.handle(Channel.CatalogVersions, (_e, req: { tool: string; force?: boolean }) =>
    wrap(async () => {
      const entry = entryOf(req.tool);
      const vs = await versionsOf(s, entry, Boolean(req.force));
      const sourceIds = entry.sources.map((x) => x.id);
      return vs.map((v) => ({
        tool: v.tool,
        version: v.version,
        size: v.size ?? null,
        sourceIds,
        preferredSourceId: v.preferredSourceId || sourceIds[0] || '',
        asset: v.asset,
      }));
    }),
  );

  // —— 下载(§4.2):install() 后台跑,进度经 sender 推送;返回 taskId = core 内部 spec.id
  ipcMain.handle(Channel.DownloadStart, (e: IpcMainInvokeEvent, req: { tool: string; version: string; sourceId?: string }) =>
    wrap(async () => {
      const entry = entryOf(req.tool);
      const ver = await findVersion(entry, req.version);
      const taskId = `${entry.id}-${ver.version}`;
      const send = (status: DownloadTaskStatus, extra: Partial<DownloadProgressEvent> = {}): void => {
        if (e.sender.isDestroyed()) return;
        const ev: DownloadProgressEvent = { id: taskId, tool: entry.id, version: ver.version, status, received: 0, total: -1, speed: 0, ...extra };
        e.sender.send(PushChannel.DownloadProgress, ev);
      };
      send('queued');
      // fire-and-forget:invoke 立即返回,整包下载/解压完成再推终态(否则 IPC 卡住,§8)
      void install(entry, ver, { sourceId: req.sourceId, onProgress: (p) => send('downloading', { received: p.received, total: p.total, speed: p.speed }) }, ctx())
        .then(() => send('done', { received: 1, total: 1, speed: 0 }))
        .catch((err: unknown) => {
          const info = errInfo(err);
          const cancelled = err instanceof DownloadError && err.kind === 'aborted';
          send(cancelled ? 'cancelled' : 'failed', { error: { code: info.code, message: info.message, switchable: info.switchable } });
        });
      return { taskId };
    }),
  );

  ipcMain.handle(Channel.DownloadCancel, (_e, taskId: string) => wrap(() => ({ cancelled: s.downloader().cancel(taskId) })));

  // —— 已安装:列表 / 切换 / 卸载
  ipcMain.handle(Channel.InstallList, () =>
    wrap(() => {
      if (!s.getDevRoot()) return [];
      return s.store.load().installs.map((i) => ({
        id: i.id, tool: i.tool, version: i.version, path: i.path, sourceId: i.sourceId,
        sourceUrl: i.sourceUrl, size: i.size, installedAt: i.installedAt, isCurrent: i.isCurrent,
      }));
    }),
  );

  ipcMain.handle(Channel.InstallSwitch, (_e, req: { tool: string; version: string }) =>
    wrap(async () => {
      await setCurrent(entryOf(req.tool), req.version, ctx());
      return null;
    }),
  );

  ipcMain.handle(Channel.InstallUninstall, (_e, req: { tool: string; version: string }) =>
    wrap(async () => {
      await uninstall(entryOf(req.tool), req.version, ctx());
      return null;
    }),
  );

  // —— 环境状态(受管条目是否已接入;顶栏黄条 + 向导 diff 依据)
  ipcMain.handle(Channel.EnvState, () => wrap(() => envState(s)));
  ipcMain.handle(Channel.EnvAudit, () => Promise.resolve(fail('not-implemented', 'PATH 体检属 M3(技术手册 §13)')));
  ipcMain.handle(Channel.EnvPrune, () => Promise.resolve(fail('not-implemented', 'PATH 清理属 M3(技术手册 §13)')));
  ipcMain.handle(Channel.EnvRestore, (_e, req: { file: string }) =>
    wrap(async () => {
      const r = await s.env.restoreBackup(req.file);
      s.history.append({ kind: 'env_restore', ok: true, durationMs: 0, detail: { changed: r.changed } });
      return null;
    }),
  );

  ipcMain.handle(Channel.HistoryList, (_e, req?: { kind?: string; limit?: number }) =>
    wrap(() =>
      s.history.list({ kind: req?.kind as never, limit: req?.limit }).map((h) => ({
        ts: h.ts, kind: h.kind, ok: h.ok, durationMs: h.durationMs, detail: h.detail, backupFile: h.backupFile,
      })),
    ),
  );

  // —— 设置
  ipcMain.handle(Channel.SettingsGet, () => wrap(() => settingsView(s)));
  ipcMain.handle(Channel.SettingsSet, (_e, patch: Partial<SettingsView>) =>
    wrap(() => {
      s.store.update((d) => ({ ...d, settings: { ...d.settings, ...(patch as Record<string, unknown>) } }));
      if (typeof patch.devRoot === 'string') s.setDevRoot(patch.devRoot);
      return settingsView(s);
    }),
  );

  // —— 首跑向导(§4.0)
  ipcMain.handle(Channel.SetupDefaults, () =>
    wrap(() => {
      const devRoot = suggestDevRoot();
      return { devRoot, check: checkDevRoot(devRoot) };
    }),
  );

  // 轻量路径校验:纯 checkDevRoot(§5),不读注册表 → 向导输入时实时调用无副作用
  ipcMain.handle(Channel.SetupCheck, (_e, req: { devRoot: string }) => wrap(() => checkDevRoot(req.devRoot)));

  ipcMain.handle(Channel.SetupPreview, (_e, req: { devRoot: string }) =>
    wrap(async () => {
      const check = checkDevRoot(req.devRoot);
      if (!check.ok) throw new CoreError('bad-devroot', check.reasons.join(';'));
      const plan = envPlan(req.devRoot);
      const rows = await s.env.readAll();
      const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
      const javaRow = rows.find((r) => r.name.toLowerCase() === 'java_home');
      const merged = mergePathEntries(pathRow?.value ?? '', plan.pathEntries);
      const javaChanged = (javaRow?.value ?? '') !== plan.javaHome;
      return { devRoot: req.devRoot, warnings: check.warnings, willAdd: merged.appended, javaHome: plan.javaHome, noop: !merged.changed && !javaChanged };
    }),
  );

  ipcMain.handle(Channel.SetupRun, (_e, req: { devRoot: string }) =>
    wrap(async () => {
      const check = checkDevRoot(req.devRoot);
      if (!check.ok) throw new CoreError('bad-devroot', check.reasons.join(';'));
      ensureDevRoot(req.devRoot); // 建 tools/current/cache(§5)
      s.setDevRoot(req.devRoot); // 先落盘,使后续 downloader()/ctx() 可用
      const t0 = Date.now();
      const r = await s.env.applyPlan(envPlan(req.devRoot)); // §7.2 四步
      s.history.append({ kind: 'env_write', ok: true, durationMs: Date.now() - t0, detail: { changed: r.changed, devRoot: req.devRoot }, backupFile: r.backupFile ?? undefined });
      return { applied: r.changed, broadcast: r.broadcast, backupFile: r.backupFile };
    }),
  );

  // —— 原生:资源管理器打开(§4.3)
  ipcMain.handle(Channel.ShellOpenPath, async (_e, p: string) => {
    const err = await shell.openPath(p);
    return err ? fail('open-path', err) : ok(null);
  });
}

// ---------------------------------------------------------------- 共享小工具

function requireDevRoot(s: Services): string {
  const d = s.getDevRoot();
  if (!d) throw new CoreError('no-devroot', '请先完成首跑向导选择 DevRoot');
  return d;
}

async function envState(s: Services) {
  const devRoot = s.getDevRoot();
  const backups = s.env.listBackups().map((b) => ({ ts: b.ts, file: b.file, names: b.names }));
  if (!devRoot) return { devRoot: null, wired: false, entries: [], backups };
  const plan = envPlan(devRoot);
  const rows = await s.env.readAll();
  const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
  const javaRow = rows.find((r) => r.name.toLowerCase() === 'java_home');
  const parts = splitPathList(pathRow?.value ?? '');
  const entries: ManagedEntryView[] = plan.pathEntries.map((pe) => ({ label: pe, kind: 'path', value: pe, present: parts.some((p) => pathEntryEquals(p, pe)) }));
  entries.push({ label: 'JAVA_HOME', kind: 'java_home', value: plan.javaHome, present: (javaRow?.value ?? '') === plan.javaHome });
  return { devRoot, wired: entries.every((e) => e.present), entries, backups };
}

function settingsView(s: Services): SettingsView {
  const st = s.store.load().settings as Record<string, unknown>;
  return {
    devRoot: typeof st['devRoot'] === 'string' ? (st['devRoot'] as string) : null,
    sourcePriority: (st['sourcePriority'] as Record<string, string[]>) ?? {},
    proxy: typeof st['proxy'] === 'string' ? (st['proxy'] as string) : '',
    concurrency: typeof st['concurrency'] === 'number' ? (st['concurrency'] as number) : 2,
  };
}
