import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { api$ } from './api';
import { useDownloadQueue } from './stores/downloadQueue';
import './assets/base.css';

const pinia = createPinia();
setActivePinia(pinia); // 让 subscribeProgress 在 app 挂载前即可取到 store

/** §8 推送汇聚:全局订阅一次,进度写 downloadQueue store,组件只读(§11 逻辑在 pinia) */
function subscribeProgress(): void {
  const q = useDownloadQueue(pinia);
  try {
    api$.onDownloadProgress((ev) => q.ingest(ev));
  } catch {
    /* 非 Electron 环境(冒烟测试无 bridge)→ 跳过,不阻断挂载 */
  }
}
subscribeProgress();

createApp(App).use(pinia).use(router).mount('#app');
