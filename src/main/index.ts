/**
 * Electron 主进程壳(技术手册 §4:"越薄越好"):只管窗口 + 生命周期 + IPC 注册。
 * 全部业务在 core/,全部通道装配在 ipc.ts —— 本文件不该出现 if/else 业务分支。
 */
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';

/** 单实例锁:二次启动聚焦既有窗口(面板类软件的常识行为) */
if (!app.requestSingleInstanceLock()) app.quit();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'DevKit',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false, // §8:contextBridge 白名单自行收敛能力
      contextIsolation: true,
    },
  });
  win.on('ready-to-show', () => win.show());
  // 外链一律走系统浏览器(产品红线:纯本地软件,不在应用内导航外部页)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  app.setName('DevKit');
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit(); // Windows 目标:关窗即退(§1 非常驻)
});
