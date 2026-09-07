import 'vue-router';

// 路由 meta 类型声明(router/index.ts 用 title/milestone)。
// 文件名刻意不叫 router.d.ts——那会遮蔽 `./router` 目录导入(命中此 .d.ts 而非 index.ts)。
declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    /** 占位页标注其归属里程碑 */
    milestone?: string;
  }
}
