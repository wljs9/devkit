# 项目:开发环境管理器(暂定名)

一个 Windows 工具:从国内镜像(华为云、清华 TUNA 等)高速下载开发工具(JDK/Node/Python/Maven/数据库),可携化安装、多版本切换,并以"单入口 PATH + Junction + 历史回滚"的方式保持环境变量干净。

- 需求分析:`需求分析.md`(v0.1 讨论稿,含同类方案对比、技术候选、MVP 建议、可行性调研)
- **产品文档:`产品文档.md`(现行 **v1.7**,§5 镜像规则已按 M0 实测定稿 —— 产品层以此为指导)**
- **技术手册:`技术手册.md`(现行 **v2.0**,最终技术栈 Electron+Vue+全栈TS、工程结构、系统层细则、测试门禁 —— 编码以此为准;技术冲突处以技术手册覆盖产品文档)**
- **README:`README.md`(用户视角简介 + `pnpm dist` 出包 + SmartScreen 说明 + 装/卸语义)—— M4 交付,面向终端用户;收录工具现 18 个**
- **待办清单:`BACKLOG.md`(新会话唯一入口:S1-S3/R1 已归档〔R1 节=下一版发布配方〕;F1-F8 全部完成〔F5/F6/F7/F8 节含"未收录/不收"评估归档与实现成本分档〕;活待办=P2 用户 bug/功能/改进清单,含标准接单流程与每轮验收模板)——新会话开工先读它**
- 当前阶段:**F8-impl 收录 Groovy + Flutter 已完成并发布(2026-10-17:评估「语言运行时/SDK 类」→ 用户拍板"都收" → 门禁 196/196 → Groovy 真机安装闭环 → 走查通过 → push → **Release v1.7.0**;远端 main = `b975cf9`,tag `v1.7.0` = `b7dd576`)。** 核心 = 两份 catalog(`groovy`=dirIndex + officialSidecar sha256,与 Maven/Ant 同范式**零核心改动**;`flutter`=jsonApi **map** 形 + discoveredInline sha256,镜像无侧车故走 JSON 内嵌哈希)+ `catalog.ts` **一处向后兼容增强**(map 形 `pick` 按条目字段过滤 + `checksumPath` 内嵌哈希/URL 分派 + `discoveredInline` 缺哈希版本不列);**商店现 18 工具,门禁基线 196**。**口径已立(技术手册 §14):镜像无侧车但官方 API/JSON 内嵌哈希者优先走 `discoveredInline`,不用 pinned 回填。** 前序要点:C3 动态受管 PATH(`e33a892`,**`install.ts envPlanForInstalls` 是受管计划唯一权威,勿回退固定三条**;装了 jdk 才写 JAVA_HOME);C1/C2(v1.4.0 `3509542`,**`readSystemVars` fail-closed 是 §7.1.1 铁律勿回退**);F4 六工具(`fef8a39`,**Expand-Archive 勿回退 extract-zip**,pinned 工具发新版例行回填);F5 三工具(Gradle/Go/SQLite);F6 四工具(JMeter/Ant/Tomcat/.NET SDK);未收录清单见 BACKLOG「F5 未收录工具」+ F6/F7/F8 各节。
- ⚠ **凭据与推送(2026-10-17 更新,新会话必看)**:GitHub 凭据走 **Windows 凭据管理器**条目 `git:https://github.com`(user=wljs9),**用户 2026-10-17 新加、有效期 2 个月 → 约 2026-12-17 到期**(旧的 2026-11-07/11-19 均已作废)。**坑**:本仓库 `credential.https://github.com.helper` 被指向 **GitHub CLI**(`gh auth git-credential`),而 **gh 未登录** → 直接 `git push` 报 *could not read Username*。**解法(勿改全局配置,命令上临时覆盖 URL 级 helper)**:
  `git -c credential.https://github.com.helper= -c credential.https://github.com.helper=manager push origin main && …--tags`
  取令牌同理加同前缀:`printf "protocol=https\nhost=github.com\n\n" | git -c … credential fill`(只进 shell 变量、整行遮蔽回显,绝不入库/入对话)。另一条正路 = 让用户跑 `gh auth login`。
- ⚠ **本机没有 esbuild**(devDependencies 里没有,`pnpm exec esbuild` 报 not found)—— f4/f6-e2e 文档里写的 esbuild 打包路径**已不可用**;e2e 一律用仓库已有的 jiti 直跑:`node_modules/.bin/jiti scripts/f<N>-e2e.mts --discover|--install <tool>`。
- ⚠ **探测一律走 curl,不用 Node 原生 `fetch`**:本机 fetch 被沙箱代理污染(同一 URL 报 403/501/魔数错乱,dl.k8s.io 的 .sha256 报 501、kafka tgz 魔数报 `1ffd0800`),curl 才对;且 **TUNA 对 `Mozilla/5.0` UA 返回 403 假阴性**(默认 UA 正常)。验真判据见 F5 关键事实。
- **F5 关键事实(下会话勿踩)**:①华为云镜像 2026 年已 SPA 改版,`/cmake/`、`/sqlite/`、`/nginx/download/` 等目录**名存实亡**(文件 URL 返回 12KB HTML 兜底页、HTTP 200 但非文件)——收录新源必须用 **PK 魔数/Range 206** 验真,不能只看状态码;②Go 走 `golang.google.cn`(官方中国站,1.6MB/s)+ 阿里云兜底,华为云 `/golang/` 401;③sqlite 官方只有 SHA3-256 汇总页(非 SHA-256),走 pinnedHash;发新版例行回填(`scripts/f4-e2e.mts --pin sqlite`);④Gradle adopt 探测链 fileGlob(lib\gradle-core-*.jar)/dirName 零依赖先行,exec 兜底依赖 JAVA_HOME;⑤regexPage 的 dirRegex 是**行正则**(sqlite 的 `{path}` 组须把 `.zip` 吸进去,fileUrl 模板=`https://www.sqlite.org/{path}`),dirIndex 与 regexPage 两套语义勿混。
- (F4 历史)一星工具批量收录 6 工具(Git/VS Code/Python/IDEA/PyCharm/DBeaver)已于 2026-09-17 推送(`fef8a39`,v0.3.0):解压 PowerShell Expand-Archive 勿回退 extract-zip;pinned 工具(git/vscode/python/dbeaver)发新版例行回填哈希;python 3.15.0 临时排除待官方正式发布后删;商店五页全数据驱动,新 catalog 自动出现。
- ~~M3 已定决策(用户选 A,2026-09-07):首跑向导保留固定 3 条 PATH + JAVA_HOME 无条件写入~~ —— **⛔ 该口径已被 C3(2026-09-21 用户新提,`e33a892`)推翻**:受管 PATH 条目改为**随在管工具动态生成**,JAVA_HOME 只在装/接管了 jdk 时才写。**勿再按"固定 3 条"理解或实现**(§7.2.1 为现行权威)。保留的两个原语仍在用:M1 `paths.auditPathEntries`(失效项+重复项)、M2 `env:state`,勿重写
- Electron 二进制:`pnpm install` 时官方 install.js 解 ~130MB 包易静默卡住(技术手册 §7.6);补二进制用 **`pnpm bin:electron`**(已固化镜像下载 + Expand-Archive 解压),或先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。注意这与"GitHub 直连"是两码事:github.com 本身直连可达(见开工指引 3)
- 语言:交流与文档均用中文
- 目标平台:Windows 11 x64 优先

## 新会话开工指引

1. 阅读顺序:本文件 → `BACKLOG.md`(待修项唯一入口)→ `技术手册.md`(编码为准)→ `产品文档.md`(功能为准);需要背景/理由再翻 `需求分析.md`;
2. 当前动作:**F8 评估 + 实现已完成并发布(2026-10-17:语言运行时/SDK 类评估 → 用户拍板收 Groovy + Flutter → 门禁 196/196 → Groovy 真机安装闭环 → 走查通过 → push → **Release v1.7.0**,实况见 BACKLOG「F8 实况」)。**下一轮待办 = **①JDK 同族发行版(Zulu/Corretto/Microsoft OpenJDK)—— 用户已拍板接受"官方单源 + pinned 回填"例外,列为后续候选**;②F7 分档遗留(Elasticsearch 是否并入 v1.2 服务/数据库路线);③pinned 发新版例行回填(F4 ③条);④P2 用户新清单(**空**:用户"后续再来")。** **开工三步(2026-10-17 加固)**:⓪`git status` 应干净、`git log -1` 见到 `b975cf9` 或更新 → ①`pnpm bin:electron`(electron.exe 缺失时才跑)→ `pnpm dev` 跑起来 → ②要推送/发版时**先读上方「⚠ 凭据与推送」那条**(helper 需临时覆盖 + 凭据约 2026-12-17 到期,过期就让用户重存)。** 流程规范不变:每收到一项先复述范围 → 改前 commit 存档 → 实现+补测试(§11 门禁)→ `pnpm test`/`pnpm typecheck` 绿 → 若动打包链再跑 `pnpm dist` → 小结等确认;安全类改动可复跑 `/security-review`;每轮验收后 `git push origin main && git push origin --tags`(要发版则照抄 **BACKLOG 的 R1 配方**:bump → 文档回写 → `pnpm dist` → tag → push → Release API 挂包 + 正文附 SHA-256)。里程碑产物现状:`release/devkit-setup-0.6.0.exe`(85,196,359 B,`pnpm dist` 随时重出);五页 UI + 首跑向导 + NSIS 安装器全可用,商店 18 工具全数据驱动;**受管 PATH = 在管工具动态计划(`install.ts envPlanForInstalls`,勿回退固定三条)**;**`src/main/core/` 模块数不变 + arch.test 铁律守卫不变。** **待办入口**:`BACKLOG.md` P2 + F7/F8 实况剩余发落;pinned 新版本回填方法同 F4(③条)。
3. 仓库事实:**远端 = `https://github.com/wljs9/devkit`(2026-09-09 经用户指示转 public;"开发工具管理器"名因 GitHub slug 不支持中文留在 description;正式版尚未定,发布走 Release v1.0.1 非正式标记)**。git 身份已改真实账号 `wljs9 <231853886+wljs9@users.noreply.github.com>`(v1.0.0 前历史仍是占位符,未改写);GitHub 连通性**取决于用户加速器开关**(2026-09-08 实测):加速器**关**→ github.com 直连可达(git 不设代理,现状即此);加速器**开**→ 直连断、须走 `http://127.0.0.1:65532`(`git -c http.proxy=... push` 临时用,勿常驻配置)。push 报网络错时按此互换排查;凭据存 Windows 凭据管理器(条目 `git:https://github.com`,user=wljs9,**约 2026-12-17 到期**),**但本仓库的 github.com helper 指向未登录的 gh → 必须按上方「⚠ 凭据与推送」临时覆盖 helper 才能 push**(详见 AI 记忆 `github-push-wljs9`)。**同步约定:每轮改动经用户验收后 `git push origin main && git push origin --tags`**(用户要求"后续改动一并同步";2026-09-09 实测坑:`--follow-tags` 推不到本仓库的轻量 tag)。工程根=仓库根(§2);electron-vite 自 M2 起**合入根目录**(main/preload/renderer 三入口 + `out/` 产物;`pnpm dev/build/typecheck/test` 就绪),M3 沿用同一套配置未再起工程;tsconfig 三段式与 vitest projects(core/node + renderer/happy-dom)见技术手册 §7.6;运行时依赖新增 **undici**(全局 dispatcher 接代理,§7.6);M3 起侧边栏五页全部实装(`Placeholder.vue` 已删),新增通道 `cache:clear`;
4. 遵守下方强制执行规范。


下面这段文字不许更改：
强制执行规范：
阶段性执行：每次仅执行当前指定的里程碑（如 M0），所有验收标准达成后必须立即停止，输出阶段性总结并等待用户确认，严禁自动跨入下一个里程碑。
改前必存：修改代码前必须先 Git commit 存档，确保可回退。
交前必测：交付前必须自写程序测试，通过后方可提交验收。
