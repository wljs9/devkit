import { createRouter, createWebHashHistory } from 'vue-router';
import Setup from '../views/Setup.vue';
import Store from '../views/Store.vue';
import Installed from '../views/Installed.vue';
import Environment from '../views/Environment.vue';
import History from '../views/History.vue';
import Settings from '../views/Settings.vue';

/**
 * hash 路由(Electron file:// 加载无需 history API)。
 * M2 实装首跑向导/商店/已安装;M3 补齐 环境/历史/设置 —— §4 侧边栏五页全真。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/setup', name: 'setup', component: Setup, meta: { title: '首跑向导' } },
    { path: '/', name: 'store', component: Store, meta: { title: '软件商店' } },
    { path: '/installed', name: 'installed', component: Installed, meta: { title: '已安装' } },
    { path: '/env', name: 'env', component: Environment, meta: { title: '环境' } },
    { path: '/history', name: 'history', component: History, meta: { title: '历史' } },
    { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置' } },
  ],
});
