# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.4,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- **README:`README.md`(用户视角简介 + `pnpm dist` 出包 + SmartScreen 说明 + 装/卸语义)—— M4 交付,面向终端用户**
- **待办清单:`BACKLOG.md`(v1.0.0 后所有待修复项的唯一入口:安全审查 S1-S3 + 用户后续 bug/功能占位 + 修复轮验收模板)——新会话开工先读它**
- 当前阶段:**MVP 完成(v1.0.0,M0–M4 全过用户验收)+ 发布前安全审查已做。待办全部收录 `BACKLOG.md`:S1 Node 校验和同源(High,必修)、S2 openPath 收口、S3 env:restore 路径限定;用户 bug/功能清单待补(P2 节)**。新任务 = 按 BACKLOG 逐项修,或用户提出的新功能(新里程碑另立章节)
- M3 已定决策(用户选 A,2026-09-07):首跑向导**保留固定 3 条 PATH + JAVA_HOME 无条件写入**(§6 不变);由此产生的"装了 Maven 没装 JDK → JAVA_HOME 悬空 → mvn 报错"不靠少写条目规避,而**由 M3 环境页体检逐条标 `✓正常/⚠失效`** 来暴露(见 §4.4)。core 弹药已就位:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`(固定条目 present ✓/✗),M3 主要是接成页面 + 清理/回滚 UI,勿重写这两个原语
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `BACKLOG.md`(待修项唯一入口)→ `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**读 `BACKLOG.md` 按序处理**。安全审查(2026-09-08)已落三项待修:S1(P0,Node `checksum.urls` 官方域前置,`catalog/node.json:32-36`,一行+测试)、S2(`shell:open-path` 契约改 installId 查表 + DevRoot 前缀校验)、S3(`env:restore` file 参数限定 backupDir);用户的 bug/功能清单到手后追加为 P2 编号项再逐项修。流程规范不变:每收到一项先复述范围 → 改前 commit 存档 → 实现+补测试(§11 门禁,基线 100 例只增不减)→ `pnpm test`/`pnpm typecheck` 绿 → 若动打包链再跑 `pnpm dist` → 小结等确认;安全项修完可复跑 `/security-review`。里程碑产物现状:`release/devkit-setup-0.1.0.exe`(81.2MB,目录可选版,`pnpm dist` 随时重出);五页 UI + 首跑向导 + NSIS 安装器全可用;`src/main/core/` 十模块 + arch.test 铁律守卫不变。**开工先跑** `pnpm bin:electron`(若 electron.exe 缺失)→ `pnpm dev`。
3. 仓库事实:git 身份为仓库内占位符 `wljs@local`(推送到远端前需改为真实邮箱);尚无远端;工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
