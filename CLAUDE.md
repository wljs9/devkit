# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.2,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- 当前阶段:M2 已完成(2026-09-07,electron-vite 合入根 + shared IPC 契约 + preload 白名单 + 主进程壳 + Setup/商店/已安装三页 + 顶栏下载指示;typecheck/test 77 全绿/build 三段产物齐/dev 启动无异常,tag `v0.3-m2`);**M2 尚差一步用户手动验收:`pnpm dev` 跑 §10 Node 全链路 UI 走查**;下一任务 M3(环境/历史/设置三页 + JDK/Maven catalog 接真 + 体检/回滚 UI,§13)
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 第一个任务:**M3 环境/历史/设置页 + JDK/Maven catalog 接真 + 体检/回滚 UI**(技术手册 §13)。开工前先补 M2 的用户手动验收(`pnpm dev` Node 全链路走查,§10);M0 探测(`catalog/`、`m0-results.json`)、M1 core(`src/main/core/`,§4 铁律有 arch.test 把关)、M2 壳层/契约/页面(`src/{shared,main,preload,renderer}`,IPC 契约在 `src/shared/ipc.ts`)均已定稿,直接复用勿重写;
3. 仓库事实:git 身份为仓库内占位符 `wljs@local`(推送到远端前需改为真实邮箱);尚无远端;工程根=仓库根(§2);M2 已把 electron-vite **合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置勿再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
