# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.4,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- **README:`README.md`(用户视角简介 + `pnpm dist` 出包 + SmartScreen 说明 + 装/卸语义)—— M4 交付,面向终端用户**
- **待办清单:`BACKLOG.md`(新会话唯一入口:S1-S3/R1 已归档〔R1 节=下一版发布配方〕;活待办=P2 用户 bug/功能/改进清单,含标准接单流程与每轮验收模板)——新会话开工先读它**
- 当前阶段:**F4 一星工具批量收录已完成并推送(2026-09-17,v0.3.0,主进程/catalog 动过,`pnpm dist` 四段全绿出 `devkit-setup-0.3.0.exe` 81.2MB)**。F4 范围:在 Node/JDK/Maven 之上新增 **Git(MinGit)/VS Code/Python/IntelliJ IDEA CE/PyCharm CE/DBeaver** 六工具(浏览器与 Postman 用户决定延后);核心已泛化(`catalog.ts`:jsonApi/latestRedirect 发现、rawVersion 自然序、模板别名、maxVersions、versionPolicy.exclude、pinnedHash/discoveredSidecar 校验、binName 布局、空 rootDir 平铺;**`install.ts` 解压改 PowerShell Expand-Archive**,extract-zip 已摘除)。门禁:`pnpm test` **166/166**(基线 154 只增不减)。**已 push**(远端正=本地 `fef8a39`)。剩余待办 = `BACKLOG.md` P2 走查收尾 + 新清单(推后由用户走查项驱动)。版本:v0.3.0。
- **F4 关键事实(下会话勿踩)**:①解压**只能**走 Expand-Archive(append script 内同口径),extract-zip/yauzl 对部分真包静默截断;②Git/VS Code 镜像只留最新稳定版(多版本切换待镜像收录历史 tag);VS Code 新 CDN 包=扁平根+`{commit}/` 运行时目录(rootDir 空);③pinned 校验工具(git/vscode/python/dbeaver)发新版要**例行回填哈希**:`pnpm bin:electron` 补齐后 `scripts/f4-e2e.mts --pin` 取真哈希写回 catalog,未回填版本会被 `checksum-unpinned` 拒装(这是特性不是 bug);④python `versionPolicy.exclude` 里的 `3.15.0` 是临时排除(官方目录被 α 占用),正式发布后删;⑤商店五页全数据驱动,新 catalog 即自动出现,UI 零改动。
- M3 已定决策(用户选 A,2026-09-07):首跑向导**保留固定 3 条 PATH + JAVA_HOME 无条件写入**(§6 不变);由此产生的"装了 Maven 没装 JDK → JAVA_HOME 悬空 → mvn 报错"不靠少写条目规避,而**由 M3 环境页体检逐条标 `✓正常/⚠失效`** 来暴露(见 §4.4)。core 弹药已就位:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`(固定条目 present ✓/✗),M3 主要是接成页面 + 清理/回滚 UI,勿重写这两个原语
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `BACKLOG.md`(待修项唯一入口)→ `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**F4 一星工具批量收录已完成并推送(2026-09-17,v0.3.0,提交 `da25fe3`→`685b49a`→`6c0070c`→`d6244a7`→`fef8a39`,四工具真机 e2e 已过;python pinned 与官方整包哈希逐一比对一致)**。流程规范不变:每收到一项先复述范围 → 改前 commit 存档 → 实现+补测试(§11 门禁)→ `pnpm test`/`pnpm typecheck` 绿 → 若动打包链再跑 `pnpm dist` → 小结等确认;安全类改动可复跑 `/security-review`。里程碑产物现状:`release/devkit-setup-0.3.0.exe`(F4 版,`pnpm dist` 随时重出);五页 UI + 首跑向导 + NSIS 安装器全可用;`src/main/core/` 模块数不变(adopt 逻辑落在 `install.ts`)+ arch.test 铁律守卫不变。**开工先跑** `pnpm bin:electron`(若 electron.exe 缺失)→ `pnpm dev`。**待办入口**:`BACKLOG.md` P2 —— F4 走查收尾(商店九工具可见/真装 Python·Git/接管真实 VS Code·IDEA/pinned 表外版本拒装)与后续新清单;涉及 pinned 哈希新版本回填的方法见上方「F4 关键事实」③。
3. 仓库事实:**远端 = `https://github.com/wljs9/devkit`(2026-09-09 经用户指示转 public;"开发工具管理器"名因 GitHub slug 不支持中文留在 description;正式版尚未定,发布走 Release v1.0.1 非正式标记)**。git 身份已改真实账号 `wljs9 <231853886+wljs9@users.noreply.github.com>`(v1.0.0 前历史仍是占位符,未改写);GitHub 连通性**取决于用户加速器开关**(2026-09-08 实测):加速器**关**→ github.com 直连可达(git 不设代理,现状即此);加速器**开**→ 直连断、须走 `http://127.0.0.1:65532`(`git -c http.proxy=... push` 临时用,勿常驻配置)。push 报网络错时按此互换排查;PAT 存 Windows 凭据管理器,有效至 ~2026-11-07(详见 AI 记忆 `github-push-wljs9`)。**同步约定:每轮改动经用户验收后 `git push origin main && git push origin --tags`**(用户要求"后续改动一并同步";2026-09-09 实测坑:`--follow-tags` 推不到本仓库的轻量 tag)。工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
