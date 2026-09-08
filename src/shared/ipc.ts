/**
 * IPC 契约唯一事实源(技术手册 §8)。main / preload / renderer 三侧同 import 本文件:
 * - Channel 常量:通道名不散落字符串;
 * - Result<T> 判别联合:§8 "返回值统一 { ok:true,data } | { ok:false,code,message },异常不许跨进程裸抛";
 * - 线上 DTO:刻意【不 import core】——core 经 import type 会把它文件级的 node:fs 带进 renderer 类型图,
 *   破坏 web 侧编译;IPC 边界处显式转可序列化 DTO,顺带成为"进程缝"的文档(§14 迁移缝同理)。
 */

// ---------------------------------------------------------------- 通道

export const Channel = {
  CatalogList: 'catalog:list',
  CatalogVersions: 'catalog:versions',
  DownloadStart: 'download:start',
  DownloadCancel: 'download:cancel',
  InstallList: 'install:list',
  InstallSwitch: 'install:switch',
  InstallUninstall: 'install:uninstall',
  EnvState: 'env:state',
  EnvAudit: 'env:audit',
  EnvPrune: 'env:prune',
  EnvRestore: 'env:restore',
  HistoryList: 'history:list',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  CacheClear: 'cache:clear', // §4.6 [清理缓存](§8 全集之外新增,集中于此)
  SetupRun: 'setup:run',
  // §4.0 向导辅助(§8 通道全集之外新增者集中于此,仍全部定义在本文件)
  SetupPreview: 'setup:preview',
  SetupDefaults: 'setup:defaults',
  SetupCheck: 'setup:check', // 纯路径校验,不碰注册表(输入时实时用)
  ShellOpenPath: 'shell:open-path',
} as const;

export type ChannelName = (typeof Channel)[keyof typeof Channel];

/** 推送通道(main → renderer,§8):下载进度 */
export const PushChannel = {
  DownloadProgress: 'download:progress',
} as const;

// ---------------------------------------------------------------- Result

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

// ---------------------------------------------------------------- 线上 DTO

/** 商店工具卡片(§4.1) */
export interface ToolCardView {
  id: string;
  displayName: string;
  /** 已装版本数 */
  installedCount: number;
  /** current junction 指向的版本号;未装/未建链为 null */
  currentVersion: string | null;
  /** 源 id 列表(按 catalog 优先级;设置页排源池用,§4.6) */
  sourceIds: string[];
}

/** 版本行(§4.1 详情页;catalog.DiscoveredVersion 的可序列化子集) */
export interface VersionRowView {
  tool: string;
  version: string;
  size: number | null;
  /** 可选下载源 id 列表(按 catalog 优先级排序;每行可展开换源,§4.1) */
  sourceIds: string[];
  preferredSourceId: string;
  /** 资产文件名(展示用) */
  asset: string;
}

/** 已安装记录(§4.3;与 core InstallRecord 字段一致但独立声明) */
export interface InstallView {
  id: string;
  tool: string;
  version: string;
  path: string;
  sourceId: string;
  sourceUrl: string;
  size: number;
  installedAt: string;
  isCurrent: boolean;
}

/** 下载任务入参(renderer 只知道 tool+version+sourceId,URL 拼装留在 main) */
export interface DownloadStartReq {
  tool: string;
  version: string;
  sourceId?: string;
}

export type DownloadTaskStatus = 'queued' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed' | 'cancelled';

/** download:progress 推送体(§8);done/failed/cancelled 为终态事件(同通道发全量,renderer 覆盖) */
export interface DownloadProgressEvent {
  id: string;
  tool: string;
  version: string;
  status: DownloadTaskStatus;
  /** received/total:-1 表示未知总长(§7.4) */
  received: number;
  total: number;
  speed: number;
  error?: { code: string; message: string; switchable?: boolean };
}

/** 环境页/向导用:受管条目状态(§4.0/§4.4) */
export interface ManagedEntryView {
  /** 条目原文(PATH 项)或变量名(JAVA_HOME) */
  label: string;
  /** 'path' | 'java_home' */
  kind: 'path' | 'java_home';
  value: string;
  /** 当前用户态里是否已存在 */
  present: boolean;
  /** 目标目录是否存在(%VAR% 按注册表现值展开后判定)——
   *  决策 A(2026-09-07):present✓ 但 targetOk✗ = "⚠ 失效/悬空"(如装了 Maven 未装 JDK),由环境页体检暴露 */
  targetOk: boolean;
}

export interface EnvStateView {
  devRoot: string | null;
  /** DevRoot 未定/目录缺失时 false —— 顶栏黄色"环境未接入"提示依据(§4.0) */
  wired: boolean;
  entries: ManagedEntryView[];
  /** 快照摘要(§4.4 状态备份区;M3 完整,本期只透出列表) */
  backups: { ts: string; file: string; names: string[] }[];
}

/** Setup 向导第 2 步:PATH diff 预览(§4.0 "展示改前/改后") */
export interface SetupPlanView {
  devRoot: string;
  warnings: string[];
  /** 将新增的 PATH 条目 */
  willAdd: string[];
  javaHome: string;
  /** 现状已一致 → 无需写(幂等,零副作用) */
  noop: boolean;
}

export interface SetupRunResult {
  applied: string[];
  broadcast: 'ok' | 'timeout' | null;
  backupFile: string | null;
}

/** 历史条目(§4.5;M3 页消费,契约本期定义) */
export interface HistoryViewEntry {
  ts: string;
  kind: string;
  ok: boolean;
  durationMs: number;
  detail: Record<string, unknown>;
  backupFile?: string;
}

/** 外部 PATH 条目体检行(§4.4;core paths.ts PathAuditRow 的线上镜像) */
export interface EnvPathRowView {
  raw: string;
  expanded: string;
  scope: 'user' | 'system';
  /** 指向不存在的目录(%VAR% 展开后判定;仍含 % 的不判) */
  missing: boolean;
  /** 有效 PATH(系统→用户拼接)中出现 ≥2 次 */
  duplicated: boolean;
  /** 命中本工具 envPlan 固定条目 → 归"受管条目"区展示,外部区仅留非受管 */
  managed: boolean;
}

/** env:audit 返回(§4.4 体检页) */
export interface EnvAuditView {
  devRoot: string | null;
  /** 受管条目状态(同 env:state.entries,含 targetOk —— 决策 A 的 ✓/⚠失效 来源) */
  managed: ManagedEntryView[];
  /** 全部条目(user+system 有效序);UI 按 managed 分区、按 scope 定可删性 */
  rows: EnvPathRowView[];
  /** 系统 PATH 读取失败(HKCU 读不到时 false;体检仅覆盖用户 PATH) */
  systemReadable: boolean;
  /** "PATH 共 23 条,失效 2,重复 1"(§4.4 底部汇总;total=用户+系统有效条目数) */
  summary: { total: number; missing: number; duplicates: number };
}

/** env:prune 返回(§4.4 清理所选;backupFile=§7.2① 快照,历史页/环境页可回滚) */
export interface EnvPruneResult {
  removed: string[];
  backupFile: string | null;
  broadcast: 'ok' | 'timeout' | null;
}

/** cache:clear 返回(§4.6 清理缓存) */
export interface CacheClearResult {
  files: number;
  bytes: number;
}

/** settings:get 返回(UI 需要的子集;存 core JsonRepository.settings) */
export interface SettingsView {
  devRoot: string | null;
  sourcePriority: Record<string, string[]>;
  proxy: string;
  concurrency: number;
  /** §4.6:源代理前缀覆盖(ghfast.top 等第三方加速器可换,风险登记 §12);'' = 去代理直连 */
  sourcePrefixes: Record<string, string>;
  /** §4.6 缓存区:下载缓存占用(DevRoot 未定/不可读为 null) */
  cache: { dir: string; files: number; bytes: number } | null;
  /** §4.6 关于 */
  appVersion: string;
  catalogVersion: string;
}

// ---------------------------------------------------------------- API 形状(preload 暴露 / renderer api.ts 消费)

export interface DevkitApi {
  catalogList(): Promise<Result<ToolCardView[]>>;
  catalogVersions(req: { tool: string; force?: boolean }): Promise<Result<VersionRowView[]>>;
  downloadStart(req: DownloadStartReq): Promise<Result<{ taskId: string }>>;
  downloadCancel(taskId: string): Promise<Result<{ cancelled: boolean }>>;
  onDownloadProgress(cb: (ev: DownloadProgressEvent) => void): () => void;

  installList(): Promise<Result<InstallView[]>>;
  installSwitch(req: { tool: string; version: string }): Promise<Result<null>>;
  installUninstall(req: { tool: string; version: string }): Promise<Result<null>>;

  envState(): Promise<Result<EnvStateView>>;
  envAudit(): Promise<Result<EnvAuditView>>;
  envPrune(req: { entries: string[] }): Promise<Result<EnvPruneResult>>;
  envRestore(req: { file: string }): Promise<Result<null>>;

  historyList(req?: { kind?: string; limit?: number }): Promise<Result<HistoryViewEntry[]>>;

  settingsGet(): Promise<Result<SettingsView>>;
  settingsSet(patch: Partial<SettingsView>): Promise<Result<SettingsView>>;
  /** §4.6 [清理缓存]:只回收 cache\ 下断点与解压暂存;有活动下载时拒绝 */
  cacheClear(): Promise<Result<CacheClearResult>>;

  setupPreview(req: { devRoot: string }): Promise<Result<SetupPlanView>>;
  setupRun(req: { devRoot: string }): Promise<Result<SetupRunResult>>;
  /** 轻量:仅 checkDevRoot(不读注册表),向导输入时实时校验用 */
  setupCheck(req: { devRoot: string }): Promise<Result<{ ok: boolean; reasons: string[]; warnings: string[] }>>;
  /** 原生能力:在资源管理器打开目录(§4.3 [打开目录]) */
  openPath(p: string): Promise<Result<null>>;
  /** 首启探测默认 DevRoot + 校验结果(§4.0 步骤 1) */
  setupDefaults(): Promise<Result<{ devRoot: string; check: { ok: boolean; reasons: string[]; warnings: string[] } }>>;
}
