# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.3,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- 当前阶段:**M3 代码完成,待用户手动验收**(2026-09-08,环境/历史/设置三页(§4.4/4.5/4.6)+ `env:audit/prune` 补实(体检 ✓/⚠失效、勾选清理、快照回滚)+ catalog 偏好接真(源优先级/ghproxy 前缀,含 install 走 fileUrlFor 的代理接线修复)+ `cache:clear` + undici 代理;typecheck 干净、test **100/100** 绿、build 三段齐、dev 启动无异常;**走查通过前不开 M4**,通过后打 tag `v0.4-m3` 再进入 M4(NSIS 打包/README,§13)——详见技术手册 §13 M3 行与 §7.6 M3 三条实测)
- M3 已定决策(用户选 A,2026-09-07):首跑向导**保留固定 3 条 PATH + JAVA_HOME 无条件写入**(§6 不变);由此产生的"装了 Maven 没装 JDK → JAVA_HOME 悬空 → mvn 报错"不靠少写条目规避,而**由 M3 环境页体检逐条标 `✓正常/⚠失效`** 来暴露(见 §4.4)。core 弹药已就位:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`(固定条目 present ✓/✗),M3 主要是接成页面 + 清理/回滚 UI,勿重写这两个原语
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**等用户对 M3 手动验收**(走查清单见本里程碑交付 commit / 下方 M3 验收点)。M3 代码已完成:环境页(受管 ✓/⚠失效/✗未接入 三态+重新接入、外部区勾选清理[系统项只读]、快照区[恢复此状态]、体检汇总)、历史页(时间线+过滤+[回滚])、设置页(DevRoot/源优先级上移下移/ghproxy 前缀三态/代理/并发/缓存清理/关于),`env:audit/prune` 与 `cache:clear` 已补实。M0 探测(`catalog/`、`m0-results.json`)、M1 core(`src/main/core/`,§4 铁律有 arch.test 把关)、M2 壳层/契约/页面、M3 三页与装配原语(`paths.classifyPathEntries`/`env.applyRemoval`/`env.readSystemPath`/`catalog.applyCatalogPrefs`+`preferByPriority`/`download.cacheStats`+`clearDownloadCache`)均已定稿,直接复用勿重写。**验收通过后进入 M4**(electron-builder NSIS、README/SmartScreen 说明、`pnpm dist` 口径;§13)。M3 验收参考点:①环境页体检汇总+受管三态(悬空 JAVA_HOME 显 ⚠);②手动往用户 PATH 塞一条假目录 → 体检标红 → 勾选清理 → 历史/快照页回滚还原;③商店装任一 JDK 版本(ghproxy 走代理、API 校验和)→ `java -version`;④设置页换源序/改并发生效、清理缓存数字归零。**开工先跑** `pnpm bin:electron`(若 `node_modules/electron/dist/electron.exe` 缺失)→ `pnpm dev`。
3. 仓库事实:git 身份为仓库内占位符 `wljs@local`(推送到远端前需改为真实邮箱);尚无远端;工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
