/**
 * contextBridge 白名单(技术手册 §8):只暴露 DevkitApi 声明的方法,
 * 不透传 ipcRenderer/node 能力。通道名与返回形状全部以 shared/ipc 为契约。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel, PushChannel, type DevkitApi, type DownloadProgressEvent } from '../shared/ipc';

const api: DevkitApi = {
  catalogList: () => ipcRenderer.invoke(Channel.CatalogList),
  catalogVersions: (req) => ipcRenderer.invoke(Channel.CatalogVersions, req),
  downloadStart: (req) => ipcRenderer.invoke(Channel.DownloadStart, req),
  downloadCancel: (taskId) => ipcRenderer.invoke(Channel.DownloadCancel, taskId),
  onDownloadProgress(cb) {
    const handler = (_e: IpcRendererEvent, ev: DownloadProgressEvent): void => cb(ev);
    ipcRenderer.on(PushChannel.DownloadProgress, handler);
    return () => ipcRenderer.removeListener(PushChannel.DownloadProgress, handler);
  },

  installList: () => ipcRenderer.invoke(Channel.InstallList),
  installSwitch: (req) => ipcRenderer.invoke(Channel.InstallSwitch, req),
  installUninstall: (req) => ipcRenderer.invoke(Channel.InstallUninstall, req),

  envState: () => ipcRenderer.invoke(Channel.EnvState),
  envAudit: () => ipcRenderer.invoke(Channel.EnvAudit),
  envPrune: (req) => ipcRenderer.invoke(Channel.EnvPrune, req),
  envRestore: (req) => ipcRenderer.invoke(Channel.EnvRestore),

  historyList: (req) => ipcRenderer.invoke(Channel.HistoryList, req),

  settingsGet: () => ipcRenderer.invoke(Channel.SettingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(Channel.SettingsSet, patch),

  setupPreview: (req) => ipcRenderer.invoke(Channel.SetupPreview, req),
  setupRun: (req) => ipcRenderer.invoke(Channel.SetupRun, req),
  setupCheck: (req) => ipcRenderer.invoke(Channel.SetupCheck, req),
  openPath: (p) => ipcRenderer.invoke(Channel.ShellOpenPath, p),
  setupDefaults: () => ipcRenderer.invoke(Channel.SetupDefaults),
};

contextBridge.exposeInMainWorld('devkit', api);
