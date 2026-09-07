/**
 * 壳层服务装配(技术手册 §4:index.ts 越薄越好,组装逻辑集中于此)。
 * core 九模块是纯 TS 单例的宿主:userData 定 DevkitData/history/缓存位置,devRoot 存 settings。
 * 全模块零 electron import(§4 铁律)——本文件在 main 侧完成注入,core 保持可 vitest 直测。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CatalogEntry, loadCatalogDir, getVersions, FileCachePort, type DiscoveredVersion } from './core/catalog';
import { Downloader } from './core/download';
import { EnvService } from './core/env';
import { HistoryLog } from './core/history';
import { JsonRepository, type DevkitData } from './core/store';
import { defaultDevRoot } from './core/paths';
import { CoreError } from './core/errors';

export interface Services {
  userDataDir: string;
  store: JsonRepository;
  history: HistoryLog;
  env: EnvService;
  catalogCache: FileCachePort;
  /** catalog 文件懒加载(devRoot 未定前也可列清单) */
  catalogs(): Map<string, CatalogEntry>;
  /** 全应用共享单一 Downloader(并发上限 2 与 cancel 跨任务生效);devRoot 变更则重建 */
  downloader(): Downloader;
  getDevRoot(): string | null;
  setDevRoot(p: string): void;
}

let svc: Services | null = null;

export function initServices(): Services {
  if (svc) return svc;
  const userDataDir = app.getPath('userData'); // %APPDATA%/devkit
  fs.mkdirSync(userDataDir, { recursive: true });

  const store = new JsonRepository(path.join(userDataDir, 'devkit.json'));
  const history = new HistoryLog(path.join(userDataDir, 'history.jsonl'));
  // env.ps1 定位交给壳层(core 的 import.meta.url 相对路径在打包进 out/ 后会错位,§4:路径知识属壳层):
  //   dev → app 根 resources/;打包 → process.resourcesPath/env.ps1(electron-builder.yml extraResources 落此)。
  const psPath = app.isPackaged ? path.join(process.resourcesPath, 'env.ps1') : path.join(app.getAppPath(), 'resources', 'env.ps1');
  const psScript = fs.existsSync(psPath) ? fs.readFileSync(psPath, 'utf8') : undefined;
  const env = new EnvService({ userDataDir, ...(psScript ? { psScript } : {}) }); // 真实键 HKCU\Environment(§11:UI 走查用真实键;自动化测试另注沙盒键)
  const catalogCache = new FileCachePort(path.join(userDataDir, 'catalog_cache.json'));

  // catalog/*.json 随包发布:dev 期在仓库根,打包后在 resources/(electron-builder extraResources)
  const catalogDir = app.isPackaged ? path.join(process.resourcesPath, 'catalog') : path.join(app.getAppPath(), 'catalog');
  let catalogs: Map<string, CatalogEntry> | null = null;
  let cachedMtime = 0;

  const current = (): DevkitData => store.load();

  let dl: Downloader | null = null;
  let dlRoot: string | null = null;

  const s: Services = {
    userDataDir,
    store,
    history,
    env,
    catalogCache,
    catalogs() {
      const mtime = fs.existsSync(catalogDir) ? fs.statSync(catalogDir).mtimeMs : 0;
      if (!catalogs || mtime !== cachedMtime) {
        catalogs = new Map(loadCatalogDir(catalogDir).map((c) => [c.id, c]));
        cachedMtime = mtime;
      }
      return catalogs;
    },
    downloader() {
      const devRoot = s.getDevRoot();
      if (!devRoot) throw new CoreError('no-devroot', '尚未选择 DevRoot(请先完成首跑向导)');
      // 记忆化:同一 devRoot 复用同一实例 → 并发上限与取消跨任务生效(§7.4);换根才重建
      if (!dl || dlRoot !== devRoot) {
        dl = new Downloader({ devRoot });
        dlRoot = devRoot;
      }
      return dl;
    },
    getDevRoot() {
      const v = current().settings['devRoot'];
      return typeof v === 'string' && v.length > 0 ? v : null;
    },
    setDevRoot(p: string) {
      store.update((d) => ({ ...d, settings: { ...d.settings, devRoot: p } }));
    },
  };
  svc = s;
  return s;
}

/** 默认 DevRoot 探测(§5);core/paths 的唯一消费者之一,UI 首跑步骤 1 用 */
export function suggestDevRoot(): string {
  return defaultDevRoot();
}

export async function versionsOf(s: Services, entry: CatalogEntry, force: boolean): Promise<DiscoveredVersion[]> {
  return getVersions(entry, { force, cache: s.catalogCache, now: () => new Date() });
}
