# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(v1.2,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(v1.4,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- **README:`README.md`(用户视角简介 + `pnpm dist` 出包 + SmartScreen 说明 + 装/卸语义)—— M4 交付,面向终端用户**
- **待办清单:`BACKLOG.md`(新会话唯一入口:S1-S3/R1 已归档〔R1 节=下一版发布配方〕;F1-F5 已完成〔F5 节含未收录工具评估归档〕;活待办=P2 用户 bug/功能/改进清单,含标准接单流程与每轮验收模板)——新会话开工先读它**
- 当前阶段:**F5 已全部收尾(2026-09-20 用户确认走查通过;push 与 Release 上一会话已完成:远端 main = 轻量 tag `v1.3.0` = `e5bd6c5`,GitHub Release `v1.3.0`(prerelease)附件 `devkit-setup-0.4.0.exe` 85,185,215 B,SHA-256 `BA0682E6…FA089` 与本地 `Get-FileHash` 复核一致,本地 9 个 tag 与远端全同步)**。历史实现记录(F5 范围与门禁):F5 范围:在 F4 九工具之上新增 **Gradle/Go/SQLite** 三工具(评估自《功能改进建议.md》"二星"节;Tomcat/Nginx/CMake/Rust 评估结论归档于 BACKLOG「F5 未收录工具」节,待用户发落)。核心扩展(`catalog.ts`):`listScan.shape` += `array`(Go dl API:versionRegex 剥 go 前缀 + pick 选 win-amd64 资产)、`checksum.kind` += `discoveredInline`(API 内嵌 sha256)、`listKind` += `regexPage`(sqlite.org download.html PRODUCT 数据行);源:Gradle=华为云/腾讯云 + 官方 sha256 侧车,Go=golang.google.cn + 阿里云,SQLite=官方单源 + pinnedHash(3.53.4 真哈希已回填)。门禁:`pnpm test` **170/170**(基线 166 只增不减)。三工具真机 e2e 全过(gradle 需 JAVA_HOME 属工具常识;go 1.27.1/sqlite 3.53.4 --version 实测)。**待用户走查后 push**(推送前等用户开 VPN,见 BACKLOG F5 实况)。版本:v0.4.0。
- **F5 关键事实(下会话勿踩)**:①华为云镜像 2026 年已 SPA 改版,`/cmake/`、`/sqlite/`、`/nginx/download/` 等目录**名存实亡**(文件 URL 返回 12KB HTML 兜底页、HTTP 200 但非文件)——收录新源必须用 **PK 魔数/Range 206** 验真,不能只看状态码;②Go 走 `golang.google.cn`(官方中国站,1.6MB/s)+ 阿里云兜底,华为云 `/golang/` 401;③sqlite 官方只有 SHA3-256 汇总页(非 SHA-256),走 pinnedHash;发新版例行回填(`scripts/f4-e2e.mts --pin sqlite`);④Gradle adopt 探测链 fileGlob(lib\gradle-core-*.jar)/dirName 零依赖先行,exec 兜底依赖 JAVA_HOME;⑤regexPage 的 dirRegex 是**行正则**(sqlite 的 `{path}` 组须把 `.zip` 吸进去,fileUrl 模板=`https://www.sqlite.org/{path}`),dirIndex 与 regexPage 两套语义勿混。
- (F4 历史)一星工具批量收录 6 工具(Git/VS Code/Python/IDEA/PyCharm/DBeaver)已于 2026-09-17 推送(`fef8a39`,v0.3.0):解压 PowerShell Expand-Archive 勿回退 extract-zip;pinned 工具(git/vscode/python/dbeaver)发新版例行回填哈希;python 3.15.0 临时排除待官方正式发布后删;商店五页全数据驱动,新 catalog 自动出现。
- M3 已定决策(用户选 A,2026-09-07):首跑向导**保留固定 3 条 PATH + JAVA_HOME 无条件写入**(§6 不变);由此产生的"装了 Maven 没装 JDK → JAVA_HOME 悬空 → mvn 报错"不靠少写条目规避,而**由 M3 环境页体检逐条标 `✓正常/⚠失效`** 来暴露(见 §4.4)。core 弹药已就位:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`(固定条目 present ✓/✗),M3 主要是接成页面 + 清理/回滚 UI,勿重写这两个原语
- Electron 二进制:本机 GitHub 不可直连 → `pnpm install` 官方 install.js 解 ~130MB 包会静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `BACKLOG.md`(待修项唯一入口)→ `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**F5 已收尾关闭(走查通过 + 已 push + Release v1.3.0 已发,2026-09-20 文档回写)。下一轮 = BACKLOG P2 的 C1(设置页移除「镜像源优先级」区块)/ C2(环境页系统环境变量区只留系统 Path——边界与 F3 现口径冲突,接单前须与用户确认)。** 流程规范不变:每收到一项先复述范围 → 改前 commit 存档 → 实现+补测试(§11 门禁)→ `pnpm test`/`pnpm typecheck` 绿 → 若动打包链再跑 `pnpm dist` → 小结等确认;安全类改动可复跑 `/security-review`。里程碑产物现状:`release/devkit-setup-0.4.0.exe`(F5 版,`pnpm dist` 随时重出);五页 UI + 首跑向导 + NSIS 安装器全可用,商店 12 工具全数据驱动;`src/main/core/` 模块数不变 + arch.test 铁律守卫不变。**开工先跑** `pnpm bin:electron`(若 electron.exe 缺失)→ `pnpm dev`。**待办入口**:`BACKLOG.md` P2(F5 走查收尾 + 未收录工具发落 + 新清单);pinned 新版本回填方法同 F4(③条)。
3. 仓库事实:**远端 = `https://github.com/wljs9/devkit`(2026-09-09 经用户指示转 public;"开发工具管理器"名因 GitHub slug 不支持中文留在 description;正式版尚未定,发布走 Release v1.0.1 非正式标记)**。git 身份已改真实账号 `wljs9 <231853886+wljs9@users.noreply.github.com>`(v1.0.0 前历史仍是占位符,未改写);GitHub 连通性**取决于用户加速器开关**(2026-09-08 实测):加速器**关**→ github.com 直连可达(git 不设代理,现状即此);加速器**开**→ 直连断、须走 `http://127.0.0.1:65532`(`git -c http.proxy=... push` 临时用,勿常驻配置)。push 报网络错时按此互换排查;PAT 存 Windows 凭据管理器,有效至 ~2026-11-07(详见 AI 记忆 `github-push-wljs9`)。**同步约定:每轮改动经用户验收后 `git push origin main && git push origin --tags`**(用户要求"后续改动一并同步";2026-09-09 实测坑:`--follow-tags` 推不到本仓库的轻量 tag)。工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
