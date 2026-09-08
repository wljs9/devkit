# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.4,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- **README:`README.md`(用户视角简介 + `pnpm dist` 出包 + SmartScreen 说明 + 装/卸语义)—— M4 交付,面向终端用户**
- 当前阶段:**M3 已通过用户验收并打 tag `v0.4-m3`;M4 配置+README 完成,待用户"装→用→卸"手动走查**(2026-09-08,electron-builder NSIS:per-user/lzma/asar/`afterPack` locales 裁剪/无签名;`pnpm dist` 四段一脚本 + npmmirror 内置;出包 `devkit-setup-0.1.0.exe` **81.2MB**(DoD ≤120MB)、win-unpacked 启动冒烟过;tag `v1.0.0` 留走查通过后打 —— 详见技术手册 §13 M4 行、§10 实测修订)
- M3 已定决策(用户选 A,2026-09-07):首跑向导**保留固定 3 条 PATH + JAVA_HOME 无条件写入**(§6 不变);由此产生的"装了 Maven 没装 JDK → JAVA_HOME 悬空 → mvn 报错"不靠少写条目规避,而**由 M3 环境页体检逐条标 `✓正常/⚠失效`** 来暴露(见 §4.4)。core 弹药已就位:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`(固定条目 present ✓/✗),M3 主要是接成页面 + 清理/回滚 UI,勿重写这两个原语
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**等用户对 M4 做"干净目录 装→用→卸无残留"走查**(M3 已验收+tag `v0.4-m3`)。M4 配置与 README 已完成:`electron-builder.yml`(NSIS per-user、lzma、asar、`afterPack` locales 裁剪、无签名链)、`scripts/dist.mjs`(`pnpm dist` = typecheck+test+build+pack 四段一脚本,内置 npmmirror 镜像,任一失败不出包)、`README.md`。已产出 `release/devkit-setup-0.1.0.exe`(81.2MB,DoD ≤120MB 达标)+ win-unpacked 启动冒烟通过。**走查判据**(§13 M4):用安装器在正常用户目录装→启动→(可选跑一次装工具/切版本)→从"应用和功能"卸载 → **程序本体 `%LOCALAPPDATA%\Programs\DevKit` 与开始菜单/桌面快捷方式无残留**;注意 DevRoot、`%APPDATA%\DevKit`、用户 PATH 条目**有意不随卸载清除**(环境属机器状态,README 已写明),故"残留"仅指程序本体。走查通过后打 tag `v1.0.0`,MVP 收口。**开工先跑** `pnpm bin:electron`(若 electron.exe 缺失)→ `pnpm dev`;出包 `pnpm dist`。
3. 仓库事实:git 身份为仓库内占位符 `wljs@local`(推送到远端前需改为真实邮箱);尚无远端;工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
