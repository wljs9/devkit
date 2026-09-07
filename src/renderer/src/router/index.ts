import { createRouter, createWebHashHistory } from 'vue-router';
import Setup from '../views/Setup.vue';
import Store from '../views/Store.vue';
import Installed from '../views/Installed.vue';
import Placeholder from '../views/Placeholder.vue';

/**
 * hash 路由(Electron file:// 加载无需 history API)。
 * M2 实装:首跑向导 / 商店 / 已安装;环境·历史·设置为 §13 M3 占位,导航常驻(产品 §4 框架)。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/setup', name: 'setup', component: Setup, meta: { title: '首跑向导' } },
    { path: '/', name: 'store', component: Store, meta: { title: '软件商店' } },
    { path: '/installed', name: 'installed', component: Installed, meta: { title: '已安装' } },
    { path: '/env', name: 'env', component: Placeholder, meta: { title: '环境', milestone: 'M3' } },
    { path: '/history', name: 'history', component: Placeholder, meta: { title: '历史', milestone: 'M3' } },
    { path: '/settings', name: 'settings', component: Placeholder, meta: { title: '设置', milestone: 'M3' } },
  ],
});
