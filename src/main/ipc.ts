/**
 * ipcMain.handle 注册表(技术手册 §4/§8):"仅参数转发,无逻辑"——业务全在 core/*,
 * 本层只做三件事:①通道 ⇔ core 调用装配;②core 结果 → 线上 DTO;③异常 → Result 判别联合。
 * §8 铁律:异常不许跨进程裸抛,故每个 handler 经 wrap() 兜底。
 */
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import {
  Channel, PushChannel,
  type Result, type SettingsView, type DownloadProgressEvent, type DownloadTaskStatus,
  type EnvAuditView, type EnvStateView, type ManagedEntryView,
} from '../shared/ipc';
import type { EnvVar } from './core/env';
import { CoreError, isCoreError } from './core/errors';
import { applyCatalogPrefs, preferByPriority, type CatalogEntry, type CatalogPrefs, type DiscoveredVersion } from './core/catalog';
import { install, setCurrent, uninstall, ensureDevRoot, type InstallContext } from './core/install';
import { cacheStats, clearDownloadCache, DownloadError } from './core/download';
import { classifyPathEntries, envPlan, checkDevRoot, expandPathVars, splitPathList, pathEntryEquals, mergePathEntries } from './core/paths';
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

  /** §4.6 目录偏好(源优先级 + 代理前缀覆盖)作用到条目 —— "JDK/Maven catalog 接真"的装配半边 */
  const prefsFor = (tool: string): CatalogPrefs => {
    const st = s.store.load().settings as Record<string, unknown>;
    const prio = st['sourcePriority'] as Record<string, string[]> | undefined;
    const prefixes = st['sourcePrefixes'] as Record<string, string> | undefined;
    return { priority: prio?.[tool], proxyPrefixes: prefixes };
  };
  const entryOf = (tool: string): CatalogEntry => {
    const e = s.catalogs().get(tool);
    if (!e) throw new CoreError('unknown-tool', `目录中无工具:${tool}`);
    return applyCatalogPrefs(e, prefsFor(tool));
  };
  /** 首选源按"偏好序 ∧ 覆盖范围"重决(latestOnly 只兜该 major 最新版) */
  const preferredOf = (v: DiscoveredVersion, entry: CatalogEntry): string =>
    preferByPriority(v, entry.sources) || v.preferredSourceId || entry.sources[0]!.id;
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
        sourceIds: c.sources.map((x) => x.id),
      }));
    }),
  );

  ipcMain.handle(Channel.CatalogVersions, (_e, req: { tool: string; force?: boolean }) =>
    wrap(async () => {
      const entry = entryOf(req.tool);
      const vs = await versionsOf(s, entry, Boolean(req.force));
      const sourceIds = entry.sources.map((x) => x.id); // 已按 §4.6 优先级重排(entryOf)
      return vs.map((v) => ({
        tool: v.tool,
        version: v.version,
        size: v.size ?? null,
        sourceIds,
        preferredSourceId: preferredOf(v, entry),
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
      const sourceId = req.sourceId ?? preferredOf(ver, entry); // 未显式换源 → 按 §4.6 优先级重决
      const send = (status: DownloadTaskStatus, extra: Partial<DownloadProgressEvent> = {}): void => {
        if (e.sender.isDestroyed()) return;
        const ev: DownloadProgressEvent = { id: taskId, tool: entry.id, version: ver.version, status, received: 0, total: -1, speed: 0, ...extra };
        e.sender.send(PushChannel.DownloadProgress, ev);
      };
      send('queued');
      // fire-and-forget:invoke 立即返回,整包下载/解压完成再推终态(否则 IPC 卡住,§8)
      void install(entry, ver, { sourceId, onProgress: (p) => send('downloading', { received: p.received, total: p.total, speed: p.speed }) }, ctx())
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

  // —— §4.4 环境体检:M3 补实(复用 core paths.classifyPathEntries/auditPathEntries,不重写原语)
  ipcMain.handle(Channel.EnvAudit, () =>
    wrap(async (): Promise<EnvAuditView> => {
      const devRoot = s.getDevRoot();
      const rows = await s.env.readAll();
      const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
      const javaRow = rows.find((r) => r.name.toLowerCase() === 'java_home');
      const systemValue = await s.env.readSystemPath();
      // 展开口径:%JAVA_HOME% 按注册表现值(非 process.env 的陈旧值),其余变量走进程环境
      const envMap: NodeJS.ProcessEnv = { ...process.env };
      if (javaRow?.value) envMap['JAVA_HOME'] = javaRow.value;
      const cls = classifyPathEntries({
        userValue: pathRow?.value ?? '',
        systemValue,
        managedEntries: devRoot ? envPlan(devRoot).pathEntries : [],
        expand: (x) => expandPathVars(x, envMap),
      });
      return {
        devRoot,
        managed: devRoot ? managedEntries(devRoot, rows) : [],
        rows: cls.rows,
        systemReadable: systemValue !== null, // HKLM 读不到 → UI 注明"仅覆盖用户 PATH"
        summary: cls.summary,
      };
    }),
  );

  // —— §4.4 清理所选:仅删用户 PATH 精确命中项;红线守卫集中在这一层(core applyRemoval 保持通用)
  ipcMain.handle(Channel.EnvPrune, (_e, req: { entries: string[] }) =>
    wrap(async () => {
      const devRoot = requireDevRoot(s);
      const plan = envPlan(devRoot);
      const hit = req.entries.filter((x) => plan.pathEntries.some((m) => pathEntryEquals(m, x) || pathEntryEquals(m, expandPathVars(x))));
      if (hit.length > 0) throw new CoreError('prune-protected', `拒删本工具受管条目(接入/重连只走向导):${hit.join(' ; ')}`);
      const t0 = Date.now();
      const r = await s.env.applyRemoval(req.entries); // §7.2 快照→删→广播→失败还原
      if (r.removed.length > 0) {
        s.history.append({ kind: 'env_write', ok: true, durationMs: Date.now() - t0, detail: { via: 'prune', removed: r.removed }, backupFile: r.backupFile ?? undefined });
      }
      return { removed: r.removed, backupFile: r.backupFile, broadcast: r.broadcast };
    }),
  );

  ipcMain.handle(Channel.EnvRestore, (_e, req: { file: string }) =>
    wrap(async () => {
      const t0 = Date.now();
      const r = await s.env.restoreBackup(req.file);
      s.history.append({ kind: 'env_restore', ok: true, durationMs: Date.now() - t0, detail: { changed: r.changed, from: req.file } });
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

  // —— 设置(§4.6):入口边界清洗(§12),非法值经 Result 归一,不裸抛
  ipcMain.handle(Channel.SettingsGet, () => wrap(() => settingsView(s)));
  ipcMain.handle(Channel.SettingsSet, (_e, patch: Partial<SettingsView>) =>
    wrap(() => {
      const clean = sanitizeSettingsPatch(patch);
      s.store.update((d) => ({ ...d, settings: { ...d.settings, ...clean } }));
      if (typeof clean['devRoot'] === 'string') {
        ensureDevRoot(clean['devRoot']); // 新根即建骨架(§5);"不迁移已有"由页面文案承担(§4.6)
        s.setDevRoot(clean['devRoot']);
      }
      if (clean['proxy'] !== undefined) s.applyNetwork(); // 代理 URL → 全局 undici dispatcher
      return settingsView(s);
    }),
  );

  // —— §4.6 [清理缓存]:活动下载期间拒绝(断点文件可能正被写)
  ipcMain.handle(Channel.CacheClear, () =>
    wrap(() => {
      const devRoot = requireDevRoot(s);
      const active = s.downloader().activeIds;
      if (active.length > 0) throw new CoreError('cache-busy', `有 ${active.length} 个下载进行中,完成后再清理缓存`);
      return clearDownloadCache(devRoot);
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

async function envState(s: Services): Promise<EnvStateView> {
  const devRoot = s.getDevRoot();
  const backups = s.env.listBackups().map((b) => ({ ts: b.ts, file: b.file, names: b.names }));
  if (!devRoot) return { devRoot: null, wired: false, entries: [], backups };
  const rows = await s.env.readAll();
  const entries = managedEntries(devRoot, rows);
  return { devRoot, wired: entries.every((e) => e.present), entries, backups };
}

/**
 * 受管区装配(env:state 与 env:audit 共用):
 * present = 用户 PATH 等值含该项 / JAVA_HOME 值等于 plan;
 * targetOk = 目标目录存在(%VAR% 按注册表 JAVA_HOME 现值展开)——
 * 决策 A:present✓ 而 targetOk✗ 即"⚠ 失效/悬空"(装了 Maven 未装 JDK 等),只暴露不规避。
 */
function managedEntries(devRoot: string, rows: EnvVar[]): ManagedEntryView[] {
  const plan = envPlan(devRoot);
  const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
  const javaRow = rows.find((r) => r.name.toLowerCase() === 'java_home');
  const parts = splitPathList(pathRow?.value ?? '');
  const envMap: NodeJS.ProcessEnv = { ...process.env };
  if (javaRow?.value) envMap['JAVA_HOME'] = javaRow.value;
  const entries: ManagedEntryView[] = plan.pathEntries.map((pe) => ({
    label: pe,
    kind: 'path',
    value: pe,
    present: parts.some((p) => pathEntryEquals(p, pe)),
    targetOk: existsSync(expandPathVars(pe, envMap)),
  }));
  entries.push({
    label: 'JAVA_HOME',
    kind: 'java_home',
    value: plan.javaHome,
    present: (javaRow?.value ?? '') === plan.javaHome,
    targetOk: existsSync(plan.javaHome), // 悬空 JDK 链:junction 不存在 → false
  });
  return entries;
}

/** §4.6 设置写入边界清洗:只放行可编辑键(cache/appVersion/catalogVersion 是派生值,拒收) */
function sanitizeSettingsPatch(patch: Partial<SettingsView>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isHttpUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s);
  if (patch.devRoot !== undefined) {
    if (typeof patch.devRoot !== 'string') throw new CoreError('bad-devroot', 'DevRoot 不能为空');
    const r = checkDevRoot(patch.devRoot);
    if (!r.ok) throw new CoreError('bad-devroot', r.reasons.join(';'));
    out.devRoot = patch.devRoot;
  }
  if (patch.proxy !== undefined) {
    const p = patch.proxy.trim();
    if (p && !isHttpUrl(p)) throw new CoreError('bad-proxy', '代理须为 http(s):// 开头的 URL(留空=跟随系统)');
    out.proxy = p;
  }
  if (patch.concurrency !== undefined) {
    const c = Math.floor(patch.concurrency);
    if (!(c >= 1 && c <= 6)) throw new CoreError('bad-concurrency', '并发数须为 1~6 的整数');
    out.concurrency = c;
  }
  if (patch.sourcePriority !== undefined) {
    const clean: Record<string, string[]> = {};
    for (const [tool, ids] of Object.entries(patch.sourcePriority)) {
      if (Array.isArray(ids)) clean[tool] = ids.filter((x) => typeof x === 'string');
    }
    out.sourcePriority = clean;
  }
  if (patch.sourcePrefixes !== undefined) {
    const clean: Record<string, string> = {};
    for (const [id, v] of Object.entries(patch.sourcePrefixes)) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t && !isHttpUrl(t)) throw new CoreError('bad-prefix', `源 ${id} 的代理前缀须为 http(s):// URL(留空=直连)`);
      clean[id] = t;
    }
    out.sourcePrefixes = clean;
  }
  return out;
}

function settingsView(s: Services): SettingsView {
  const st = s.store.load().settings as Record<string, unknown>;
  const devRoot = typeof st['devRoot'] === 'string' && st['devRoot'].length > 0 ? (st['devRoot'] as string) : null;
  return {
    devRoot,
    sourcePriority: (st['sourcePriority'] as Record<string, string[]>) ?? {},
    proxy: typeof st['proxy'] === 'string' ? (st['proxy'] as string) : '',
    concurrency: typeof st['concurrency'] === 'number' ? (st['concurrency'] as number) : 2,
    sourcePrefixes: (st['sourcePrefixes'] as Record<string, string>) ?? {},
    cache: devRoot ? cacheStats(devRoot) : null,
    appVersion: app.getVersion(),
    catalogVersion: s.catalogVersion(),
  };
}
