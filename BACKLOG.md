# DevKit — 待办与流程清单(新会话按此继续)

> 建立:2026-09-08;改版:2026-09-09(安全修复轮 + R1 发布完成后重组);2026-09-14(P2 首批三项 F1/F2/F3 完成并回写);2026-09-16(F4 一星工具批量收录登记);2026-09-19(F5 二星第一批收录登记);2026-09-20(F5 收尾关闭 + 登记 C1/C2);2026-09-21(C3 登记待接单);2026-10-17(F7 ★4 档 + 《开发工具(全)》未评估项评估轮完成)。
> 用法:新会话开场读 `CLAUDE.md` → 本文件。
> **当前状态:S1/S2/S3 + R1 已发布;F1–F5 全部完成;C1–C3 全部完成;**F6 评估 + 实现轮已全部完成并发布
> (2026-09-24:评估 ★3 档 + 收录 4 工具 JMeter/Ant/Tomcat/.NET SDK → 走查通过 → push → **Release v1.6.0**;
> 商店 16 工具,门禁 192/192;详见文末「F6 实况」)。**
> **F7 评估轮已完成(2026-10-17:★4 档 9 个 + 《开发工具(全)》未评估 12 项全量实测 → **无一进入可收录档**,
> 详见文末「F7 实况」;不动 catalog/门禁,商店仍 16 工具 / 192 例)。**
> **当前活待办 = P2 用户清单(空)+ B 档剩余发落(.NET 镜像例外接受与否 / Eclipse 收录价值)+ pinned 发新版例行回填(F4 ③条)**;
> **F8 评估 + 实现已完成并发布(2026-10-17:语言运行时/SDK 类评估 → 用户拍板收 Groovy + Flutter → 门禁 196/196
> + Groovy 真机安装闭环 → 走查通过 → push → **Release v1.7.0**;商店现 **18 工具**;见文末「F8 实况」)。**
> F7 结论待用户拍板是否扩范围;**实现成本分档已登记**(2026-10-17,见「F7 · 实现成本分档」节:
> 零 core 改动即可加入者仅 **Elasticsearch / Eclipse** 两个,其余需共通改动或单项特化;是否进实现轮待拍板)。
> 新会话先读 `CLAUDE.md` 启动指引,再回本表。

## ✅ 归档:安全修复轮 + 发布(2026-09-09 完成;R1 节可复用为下一版发布配方)

### P0 安全(2026-09-08 安全审查正式发现,置信 8/10 High)

### S1. Node 校验和与包体同源,镜像自洽投毒可绕过 §3.5 红线 → PATH 持久化 RCE ✅ 已修(2026-09-09,必做+选配2 都做)
- **位置**:`catalog/node.json:32-36`(`checksum.urls` 顺序:huawei→tuna→nodejs.org)+ `src/main/core/install.ts:43-57`(`resolveExpectedChecksum` 对 URL 列表 first-success-wins)
- **根因**:下载源序与校验源序相同,默认华为云既供 zip 又供 `SHASUMS256.txt`;单镜像沦陷即可自证清白。maven(哈希强制取 Apache 官方域)与 jdk(API 响应携带哈希)都做了域分离,node 是唯一漏点。`jdk.json` 的 `sidecarUrl` 字段无代码消费(死配置),与本漏洞无关。
- **修法(一行起)**:
  1. 必做:`checksum.urls` 首位改为 `https://nodejs.org/dist/v{ver}/SHASUMS256.txt`(M0 实测境内可直连,见 `node.json:26` note),镜像条目降为兜底;
  2. 选配(更稳):`resolveExpectedChecksum` 跳过与所选下载源同 host 的 sidecar URL,保证跨域背书——做这条需把所选 sourceId 的 host 传进校验函数。
- **测试**:catalog 定稿门禁测试里断言 `node.checksum.urls[0]` 主机为 `nodejs.org`;若做选配 2,补"同主机会被跳过、跨主机命中"单测(`tests/install.test.ts` 现有 sidecar 桩可扩)。
- **验收**:`pnpm test` 全绿 + UI 走查装一次 Node 成功。

### P1 边界加固(审查候选,置信 7/10,建议随下轮改动顺手做)

### S2. `shell:open-path` 收口:契约从任意路径改 installId 查表 ✅ 已修(2026-09-09,core 抽 `resolveOpenableInstallDir` 直测)
- **位置**:`src/main/ipc.ts:280-283`(renderer 字符串零校验直达 `shell.openPath` = ShellExecute,可启动 exe/UNC 触发 SMB)+ `src/preload/index.ts:37` + `src/shared/ipc.ts`(`openPath(p: string)`) + 调用方 `src/renderer/src/views/Installed.vue:68,108`
- **修法**:契约改 `openPath(installId: string)`;main 端 `s.store.load().installs` 查表取 `path`,校验 `path.resolve` 以 DevRoot+sep 为前缀且 `statSync().isDirectory()` 才放行(复用 `requireDevRoot`);未知 id 抛 `CoreError('unknown-install')`。渲染层只传 id,任意路径字符串彻底消失。
- **测试**:`ipc-contract.test.ts` 更新 API 形状;`tests/renderer/*` 桥 mock 同步;main 端校验逻辑可在 `Installed.vue` 冒烟桥间接覆盖(或抽纯函数入 core 直测)。
- **注意**:M5 若加"打开 cache/备份文件目录"类需求,再评估是否需要受限白名单目录参数——别回到任意路径。

### S3. `env:restore` 的 `file` 参数限定备份目录(4 行加固,审查判 2/10 非漏洞,但值得做)✅ 已修(2026-09-09,`EnvService.isBackupFile` 入口闸)
- **位置**:`src/main/ipc.ts:199-206` → `src/main/core/env.ts:190`(`fs.readFileSync(file)` 无路径约束)
- **修法**:`EnvService` 加 `isBackupFile(file)`:`path.resolve(file)` 必须落在 `this.backupDir` 下且 basename 匹配 `writeBackup` 命名(`env.ts:245`,形如 `2026-09-08T06-31-12-345.json`);`restoreBackup` 入口拒绝并抛 `CoreError('env-backup-path', …)`。
- **测试**:`tests/env.test.ts` 补两例——目录外路径拒绝、伪造名拒绝、真备份照常成功。

### P0.5 发布动作(2026-09-08 与用户口头定序,做 S1 时一并执行)

### R1. 修复轮收尾后发 GitHub pre-release + 安装包附件
- **顺序**:S1(必须)→ [S3 顺手] → `pnpm dist` 重出包 → 用户确认 → **发 Release**(否则 81MB 传两遍)。
- **版本**:发布前把 `package.json` 的 `version` 从 `0.1.0` bump 到 `0.1.1`(§10 单一来源;产物名自动变 `devkit-setup-0.1.1.exe`),commit 随修复轮一起;tag `v1.0.1` 打在 bump 提交上(MVP 系列延续 v1.0.x)。
- **做法**(凭据/API 细节见 AI 记忆 `github-push-wljs9` 与 CLAUDE.md 仓库事实):
  1. `curl -X POST https://api.github.com/repos/wljs9/devkit/releases -H "Authorization: Bearer <PAT>" -d '{"tag_name":"v1.0.1","name":"DevKit MVP v1.0.1(非正式版)","prerelease":true,"body":"…修复摘要,见 BACKLOG S1…"}'`;
  2. 用上一步返回的 `upload_url` 上传 `release/devkit-setup-0.1.1.exe`(Content-Type: application/octet-stream,81MB 需耐心/断点重传);
  3. README 的 SHA-256 口径:发布说明里附上 `Get-FileHash` 值,供用户核对。
- **注意**:~~仓库是私有库,Release 也私有~~ **已执行(2026-09-09)**:用户指示"私人仓库等于没发布",经全历史敏感信息扫描(无 token/私钥/个人信息,PAT 仅存 Windows 凭据管理器)后转 public,Release 随之公开。
- **状态**:✅ 完成(2026-09-09)。实况:仓库已转 **public**(全历史扫描无敏感信息后执行);Release id 385207716 = `https://github.com/wljs9/devkit/releases/tag/v1.0.1`(prerelease);附件 `devkit-setup-0.1.1.exe` 85,183,417 B,SHA-256 `92837c564f2feb468e1d73e3dbbf1ca97b733b1332271235d0131348856ce9eb`,匿名下载实测 206;S1 验收中"UI 走查装一次 Node"仍待用户亲测(自动化 111 例 + dist 四段 + 冒烟已绿)。

## P2 用户后续清单(bug / 功能 / 改进 —— 唯一活待办,等清单到手)
> 用户已明示"bug 修改和功能添加后续再来"。**清单到手后的标准流程(勿自动扩权,一次只做一项)**:
> 1. **复述范围**:向用户复述该项理解,边界不清先问;
> 2. **登记**:追加进下表并编号 —— bug=`B#`、功能=`F#`、改进=`C#`,写清"现象/期望、涉及文件(猜的也行,开工先核)、验收标准";
> 3. **改前必存**:工作树干净(或先 commit 在制品)才动代码;
> 4. **实现 + 补测试**:门禁基线 **170 例只增不减**(§11);纯逻辑入 `src/main/core/`(arch.test 十模块铁律,渲染层组件保持哑);
> 5. **绿了才交**:`pnpm typecheck && pnpm test`;动到 catalog/主进程/打包链再 `pnpm dist`;
> 6. **单独 commit**:信息注明 `B#/F#/C#`,本节该条打勾 + 记 commit 号;
> 7. **小结等确认**(CLAUDE.md 阶段性执行铁律,严禁连做下一项);
> 8. **验收后同步**:`git push origin main && git push origin --tags`;若要出新版,整段照抄上方 **R1 配方**(bump → tag → dist → Release API,含安装包 SHA-256)。

| # | 类型 | 项 | 状态 |
|---|---|---|---|
| F1 | 功能 | **添加已有安装(接管)** —— 能把本机已存在的 JDK/Node/Maven 目录登记进 DevKit(建 current 链接、纳入切换),且机制必须清单驱动,后续加 Python/Git/MySQL/SQL Server/MinGW 只需补 catalog 的 `adopt` 段。验收:接管后「已安装」可见、可设为当前、可移出登记且**不删原文件**;非本工具目录/UNC/DevRoot 内目录一律拒。 | ✅ 完成 2026-09-14 · commit `717748d` |
| F2 | 功能 | **受管条目并入 PATH 检测表** —— 环境页「外部条目区」不再过滤掉本工具 3 条受管条目,改为同表展示并打「受管」标签(不可勾删),让检测列表一条不漏。 | ✅ 完成 2026-09-14 · commit `ff6cc50` |
| F3 | 功能 | **系统环境变量开关(默认关)** —— 设置页新增开关,开启(二次确认)后环境页出现「系统环境变量(HKLM)」区:可**增/改/删非 Windows 内置**的系统变量;内置变量(含系统 `Path`)一律只读拒改拒删;全部写入走 §7.2 四步 + 系统级快照可回滚。 | ✅ 完成 2026-09-14 · commit `8793ecb` |
| F4 | 功能 | **一星工具批量收录**(《常用工具列表.md》★ 档去重后 6 个):Git(MinGit)/VS Code/Python(embed)/IDEA CE/PyCharm CE/DBeaver。范围 2026-09-16 已与用户拍板:①校验和缺口工具(Python/DBeaver等)走 **pinned 固定哈希**方案(S1 红线不动摇);②**浏览器本批跳过**(Chrome 备选方案=f官方 Chrome for Testing,Firefox 官方无 zip,均延后);③Postman 版本 API 残缺(下载 URL 404/列表空)→ 延后。核心含 `catalog.ts` 泛化:jsonApi/latestRedirect 发现、rawVersion 自然序、aliases、maxVersions、pinned/discoveredSidecar 校验、binName 布局、空 rootDir 平铺。验收:六个工具商店可见、安装(校验不缺口)、切换/卸载/接管齐,门禁全绿 + **四个 pinned 工具真下载 e2e(已过:python/git/dbeaver/vscode)**。 | ✅ 完成并推送 2026-09-17 · commit `fef8a39` |
| F5 | 功能 | **二星工具第一批收录**(《功能改进建议.md》2026-09-19:评估 ★★☆☆☆ 两节后用户拍板按"轻松档"先收 3 个):**Gradle / Go / SQLite**。核心扩展:`listScan.shape` 增 `array`(Go dl API:versionRegex 剥 `go` 前缀 + pick 键选 win-amd64 资产)+ checksum kind 增 `discoveredInline`(API 内嵌 sha256,adoptiumApi 同范式)+ listKind 增 `regexPage`(sqlite.org download.html 的 PRODUCT 数据行)。源:Gradle=华为云(170 版)/腾讯云 + 官方 sha256 侧车(跨域);Go=golang.google.cn(1.6MB/s)+ 阿里云镜像(171 版);SQLite=官方单源 ~6MB + pinnedHash(3.53.4 真哈希已回填)。**真机 e2e 三工具全过**(gradle 9.7.1 需 JAVA_HOME 属工具常识;go `go version go1.27.1`、sqlite `3.53.4` 实测)。验收:三工具商店可见/版本列表/安装/切换/接管齐 + 门禁全绿(170/170)。**未收录的评估结论见下方「F5 未收录工具」节,Tomcat/Nginx/CMake/Rust 延后待用户发落。** | ✅ 完成并 Release 2026-09-20(走查通过;远端 `e5bd6c5` + tag `v1.3.0` + Release prerelease,详见 F5 实况收尾段) |
| C1 | 改进 | **设置页移除「镜像源优先级」区块**(《功能改进建议.md》2026-09-20 第 1 条):用户已可在商店版本行自选源,此区随工具增多挤压设置页空间。范围(实现时定):UI 整段移除 + `SettingsView.sourcePriority`/`ToolCardView.sourceIds` 契约删除 + prefsFor 停读;**ghproxy 加速器前缀保留**(挪入网络卡,风险登记 §12 要求可换/可关);catalog.ts 的 priority 通用原语与单测不动。 | ✅ 已发布 2026-09-20 · commit `3509542` → v1.4.0(见 C 轮实况) |
| C2 | 改进 | **环境页「系统环境变量(HKLM)」区 → 方向 A 已拍板(2026-09-20 用户)**:区改名「系统 PATH(HKLM)」,只列系统 PATH 条目(可看);**可追加一条**(开关开+管理员);**不提供修改/删除**(用户到 Windows 系统设置手动做);F3 的自定义变量表与增删改、`env:system-set/remove` 通道、core `applySystemVarSet/Remove` 全下线,新增 `applySystemPathAdd` + `env:system-path-add`;安全复查发现并修复 1 Medium(readSystemVars 降级空表可致单条覆写整个 PATH → fail-closed)。 | ✅ 已发布 2026-09-20 · commit `3509542` → v1.4.0(见 C 轮实况) |
| C3 | 改进 | **"装什么管什么"——受管 PATH 条目随安装动态化**(《功能改进建议.md》2026-09-21 第 1 条,推翻 M3 决策 A"固定 3 条"口径):凡本软件下载安装或接管的工具,其 PATH 入口(`current<tool>` 或 `current<tool><bin|binName>` 按 catalog 布局)由软件**接入**,装后可直接在新终端使用;**卸载/移出登记自动断开**;环境页受管区=全部实际在管工具逐条 ✓/⚠;**装了 jdk 才写 JAVA_HOME(悬空根治)**。边界已全部确认(接单时):①装完自动接入;②接管同权自动接入;③JAVA_HOME 装 jdk 才写;④快照全量恢复照旧。**验收:安装/接管即自动接入(新终端直接用)、卸载/移出登记自动断开、环境页受管区随在管工具逐条展示、JAVA_HOME 不再悬空、切换版本依旧零 PATH 变动。** | ✅ 完成并推送 2026-09-22 · commit `e33a892`(见 C3 实况) |
| F6 | 评估轮 | **评估可继续收录的工具**(《功能改进建议.md》2026-09-24 新条;输入=《常用工具列表(分星级)》《开发工具(全)》):对候选工具分档评估 —— ①国内镜像可用性(**PK 魔数/Range 206 验真**);②校验和可获得性(官方 sidecar / API 内嵌 / pinned 回填负担);③单 zip 解压即用模型适配(含 adopt);④配置/初始化成本。**产出:分档评估归档 + 建议收录优先级清单,回写 BACKLOG/F6 实况,待用户拍板后再进实现轮。本轮不收录、不动 catalog/门禁。** | ✅ 评估完成 2026-09-24(结论见 F6 实况,待用户拍板) |
| F6-impl | 功能 | **实现收录 4 个工具**(用户 2026-09-24 拍板"四个都做"):**JMeter / Ant / Tomcat / .NET SDK**。实际实现比评估预估更省:**Tomcat 无需两级扫描**(dirIndex 的 fileUrl 模板静态拼 `v{ver}/bin/`,同 Maven 的 `{ver}/binaries/` 形态,F5 归档前提作废);唯一 core 改动 = **catalog.ts jsonApi array 增强**(root 取对象内嵌数组、assetNamePath 取 url 末段、fileRegex 过滤同 rid 的 exe、哈希长度分派 128hex→sha512),Go 形态完全兼容回归。四工具:jmeter/ant/tomcat=officialSidecar sha512(官方 archive 跨域,同 Maven),dotnet=discoveredInline sha512(官方 releases.json 内嵌,同 Go)。**验收:四工具版本发现真机全过 + 三工具真机安装闭环(ant/jmeter/tomcat)+ 门禁 192/192(基线 188 + 4)+ typecheck + dist 四段全绿。dotnet 200MB 大包未真装,由走查覆盖。** | ✅ 已发布 2026-09-24 · commit `cde3342` → Release **v1.6.0**(见 F6 实现段发布实况) |
| F7 | 评估轮 | **评估 ★4 档工具可否收录**(《功能改进建议.md》2026-10-17 单条"评估一些 4 星的工具是否可收录,与《开发工具(全)》参考"):候选池 = 《常用工具列表(分星级)》★4 档 9 个 + 《开发工具(全)》同难度未评估 12 项;判据沿用 F5/F6(镜像 PK 魔数/Range 206 验真 + 校验侧车 + 单 zip 解压即用 + 初始化成本);F6 已归档的镜像缺项不复测。**产出:分档实测结论 + 建议优先级(见 F7 实况)。本轮不收录、不动 catalog/门禁。** | ✅ 评估完成 2026-10-17(结论:★4 全档无一可收,见 F7 实况;待用户拍板) |
| F8 | 评估轮 | **评估「语言运行时 / SDK 类」工具可否收录**(2026-10-17 用户口径:"先考虑类似 jdk、python 这种的工具",Eclipse 这类官网单源/IDE 先搁置):候选池 = 《开发工具(全)》§1 语言运行时/SDK 全档 + JDK 同族发行版 + C/C++ 工具链(约 40 项);判据沿用 F5–F7。 | ✅ 评估完成 2026-10-17(结论:仅 Groovy 零改动可收、Flutter 需一处小增强;见 F8 实况) |
| F8-impl | 功能 | **收录 Groovy + Flutter**(用户 2026-10-17 拍板"都收"):Groovy = Apache 同范式**零核心改动**;Flutter = 一份 catalog + **catalog.ts jsonApi 一处向后兼容增强**(map 形支持 `pick` 字段过滤 + `checksumPath` 内嵌哈希/URL 分派)。 | ✅ 已发布 2026-10-17 · commit `8d72431` → Release **v1.7.0**(见 F8 实现段发布实况) |

### F 轮实况(2026-09-14,三项一次交付 —— 用户要求"修完后上传 GitHub",故合并为一轮)

- **范围已与用户确认两处边界**(开工前问过):①F3 系统级**只开放自定义变量增删改**,系统 `Path` 与 Windows
  内置变量保持只读;②F2 按**最小口径**做(只把受管 PATH 条目并入检测表,不新增"全部环境变量"表)。
- **F1 接管已有安装**:清单驱动(`catalog/*.json` 的 `adopt` 段 + 技术手册 §6.1 四型探测);接管登记 `origin:'adopt'`
  —— 不复制/不移动/不删除,`[移出登记]` 只删记录 + 断链;`uninstall` 对接管项抛 `adopt-unregister-only`;
  `openPath` 对接管项改守"本机绝对路径 + 非 UNC"(S2 收口语义不变)。
- **F2**:环境页 PATH 表去 `!managed` 过滤 + 「受管」标签 + 勾选禁用;`env:audit.rows` 本就含受管行,只解禁展示。
- **F3**:core 侧 `allowSystem` 闸门(**缺省一律拒**)+ `PROTECTED_SYSTEM_VARS`(34 个内置名含 `path`);
  `env.ps1` 新增 System 三函数 + `Get-Elevated`;快照多 `scope` 字段(老备份按 user),系统级回滚**永不删除内置变量**;
  未提权 → `system-need-admin`。
- **门禁**:`pnpm typecheck` 两段干净;`pnpm test` **154/154**(基线 111 只增不减:adopt 22 + env 10 + catalog 2 +
  契约 2 + 渲染 4 + 拆分重排);`pnpm dist` 四段全绿 → `release/devkit-setup-0.2.0.exe`(**81.2 MB**)。
- **待用户走查(人工项)**:①接管一个真实既有安装(如 `C:\Program Files\nodejs` 或 `C:\Program Files\Java\jdk-*`)
  → 设为当前 → 新开终端验 `node -v`;再 [移出登记] 确认目录文件原样。②以**管理员身份**运行 → 设置页开 F3 开关
  → 环境页新增一个自定义系统变量(如 `DEVKIT_TEST`)→ 改值 → 删除;同时试改 `Path`/`SystemRoot` 应被拒。
- **已定旧账**:S1 遗留的"UI 走查装一次 Node"仍未亲测(自动化与 dist 已绿)—— 可并入本轮走查一并过掉。

### F4 实况(2026-09-16:登记 → 实现 → 真机 e2e 全过;等待用户走查)

- **输入文档**:用户 2026-09-16 新增《常用工具列表.md》(★ 级难度划分)+ 改写《功能改进建议.md》为新需求;F1-F3 人工走查已确认通过。
- **范围(已拍板)**:Node/JDK 已在;浏览器本批跳过;Postman 延后。**F4 = 6 个:Git/VS Code/Python/IDEA CE/PyCharm CE/DBeaver**;校验缺口工具走 pinned。
- **已实现(commit:`685b49a` 核心泛化 → `6c0070c` 六 catalog → `d6244a7` e2e 定稿)**:
  - 核心:`listKind` += `jsonApi`(JetBrains 键控对象,发现时携带 sidecar URL)/`latestRedirect`(VS Code 只给最新);`rawVersion` 自然序(非 semver tag);`aliases` 模板别名(`{gitver}`);`maxVersions` 截断;`versionPolicy.exclude`(python 3.15 α 占用);`checksum.kind` += `discoveredSidecar`/`pinnedHash`;`binName` 布局;空 `rootDir`=平铺根;门禁 154→**166 只增不减**。
  - **解压改 PowerShell Expand-Archive**(§7.5):extract-zip/yauzl 对 python.org embed 真包静默截断(95,994/106,208 字节无 end/error),Expand-Archive 完整解出;`extract-zip` 依赖已摘除。
  - e2e 真机:python(3.14.7, adopt exec ✓, `python --version` 实测)/ git(2.55.0.windows.5, ✓)/ dbeaver(26.2.0, `dbeaver.exe --version` 实测 ✓)/ vscode(1.138.0, adopt `bin\code.cmd --version` ✓);idea/pycharm 发现+checksumLink 已验,完整 1.5GB 安装未做;**python 四个 pinned 与官方整包 sha256 逐一比对一致**。
  - 已知边界(如实):Git/VS Code 镜像只留最新稳定版;VS Code 新 CDN 包=扁平根+{commit}/ 运行时目录(安装按 flat 整树);python embed 无 pip/tkinter(可 `python -m ensurepip`);IDEA/PyCharm adopt 走 build.txt 的 IC-/PC- build(≠版本号,仅标签);`--version` 仅对 GUI exe 直接 spawn 不可用(本工具用 openPath)。
- **待用户走查(人工项)**:①商店页六个工具均可见、版本列表不爆表;②真装一次 Python 或 Git → 设为当前 → 新开终端验 `python`/`git`;③接管真实既有 VS Code/IDEA 目录→ 版本识别;④安装一个 unpinned 版本(如 python 3.14.3)→ 应被 `checksum-unpinned` 拒装并有可读提示。**走查通过后才可推送**;走查前保持"已实现"状态,推前等用户开 VPN。

### F5 实况(2026-09-19:评估 → 实现 → 三工具真机 e2e 全过;2026-09-20 走查通过,收尾关闭)

- **输入文档**:用户 2026-09-19 《功能改进建议.md》"评估二星的工具哪一些合适装上去";评估结论已口头汇报(轻松档=Gradle/SQLite/Go,困难档=Tomcat/Nginx/CMake/Rust),用户拍板"按你的建议执行,先做第一批,未收录的也记录回写文档,完工推 GitHub(连带 release),推送前等开 VPN"。
- **已实现(commit:`bcfd2be` 核心+三 catalog+测试)**:
  - 核心:`listScan.shape` += `array`(Go dl API 是版本对象平数组,每版本内 `pick` 键选目标资产 os=windows/arch=amd64/kind=archive,`versionRegex` 剥 `go` 前缀,内嵌 sha256 随发现携带)+ `checksum.kind` += `discoveredInline`(API 内嵌哈希,adoptiumApi 同范式)+ `listKind` += `regexPage`(数据行嵌在页面里,dirRegex 复用为行正则;sqlite.org download.html 的常规 `<a>` 是 JS 注入,只有 HTML 注释里的 PRODUCT CSV 行带全字段);门禁 166→**170 只增不减**。
  - 源定稿(2026-09-19 实测):**Gradle**=华为云 dirIndex 直链(170 版,PK 魔数 + Range 206)/腾讯云同形 + 官方 `services.gradle.org/.sha256` 裸哈希(华为云同名 sidecar 与官方 9.7.1 抽验一致;install.ts orderChecksumUrls 自动跨域背书);**Go**=`golang.google.cn/dl/?mode=json&include=all`(365 版全带 win-amd64 sha256+size,zip Range 206、1MB 采样 1.6MB/s)+ 阿里云镜像(171 版直链;华为云 /golang/ 401 已弃);**SQLite**=官方 download.html 单源(华为云 /sqlite/ 已下架为 SPA 兜底页、TUNA/阿里/腾讯无)+ pinnedHash。
  - e2e 真机:sqlite(3.53.4,pinned 校验命中,平铺根,`sqlite3 --version` 实测 3.53.4)/ go(1.27.1,75MB 真下载,API 内嵌 sha256 校验命中,VERSION 文件探测 via=releaseFile,`go version` 实测 go1.27.1 windows/amd64)/ gradle(9.7.1,151MB 真下载,官方 sha256 侧车校验命中,lib\gradle-core-*.jar 探测 via=fileGlob,`gradle --version` 实测 Gradle 9.7.1 —— 需本机 JAVA_HOME 属工具常识非收录缺陷)。
  - 已知边界:Go 下载走官方中国站 + 阿里云,无华为云;SQLite 仅官方源(~130KB/s,包小可接受)且 pinned 只留最新数版,发新版例行回填;Gradle adopt 探测的 exec 兜底依赖 JAVA_HOME(链路上 fileGlob/dirName 两档零依赖先行);e2e 脚本对 .bat 直接 spawn 的 `--version` 展示会失败(spawn EINVAL),install.ts adopt 探测走 cmd /c 才是权威路径。
- **走查项(人工)**:①商店页 12 工具(gradle/go/sqlite 新增)可见、版本列表不爆表;②真装一次 Gradle 或 Go → 设为当前 → 新开终端验 `gradle -v`(需 JAVA_HOME)/`go version`;③接管一个既有 Go/SQLite 目录 → 版本识别;④SQLite 安装 3.52.x(表外)→ 应被 `checksum-unpinned` 拒装。
- **✅ 收尾实况(2026-09-20)**:用户确认走查通过。核对发现 push 与 Release 上一会话已完成:远端 `main` = 轻量 tag `v1.3.0` = `e5bd6c5`;GitHub Release **v1.3.0(prerelease)** 附件 `devkit-setup-0.4.0.exe` 85,185,215 B,正文 SHA-256 `BA0682E6…FA089` 与本机 `Get-FileHash` 一致;本地 9 个 tag 与远端全同步。**F5 关闭,本轮提交 = 纯文档回写。** 另登记 C1/C2(《功能改进建议.md》2026-09-20 两条,C2 边界待用户拍板)。

### C 轮实况(2026-09-20:C1+C2 一轮交付 —— 用户指示"两项都做,C2 选方向 A;自测通过后停下等开 VPN 再推")

- **范围**:C1 设置页「镜像源优先级」整段下线(ghproxy 前缀挪网络卡保留);C2 环境页 HKLM 区收窄为
  "系统 PATH 只看 + 只追加一条,删改去系统手动做"(用户原话口径,已记 BACKLOG 表)。
- **已实现(commit `3509542`)**:core `applySystemPathAdd`(闸门→`assertSystemPathEntry`→幂等 merge 只增不删→
  scope=system 快照→`Set-SystemEnv Path`→失败还原)/`applySystemVarSet·Remove` 与 `assertSystemVarName` 下线/
  通道 `env:system-set·remove`→`env:system-path-add`/`env:system-list` 只回 PATH 条目/契约 `SettingsView` 去
  `sourcePriority`、`ToolCardView` 去 `sourceIds`;设置页开关与两处弹窗文案同步改口径。
- **安全复查(`/security-review` 复跑,因动系统级写口)**:1 Medium **已修** —— `readSystemVars()` 解析失败
  曾降级空表,会让"追加"以单条**覆写整个系统 PATH** 且备份为空(回滚失真);改 fail-closed:不可解析抛
  `system-read`、零值空表拒写 `system-path-read`(§7.1.1 新铁律,勿回退)。其余核查干净(psLiteral 无逃逸、
  闸门无绕过路径、restoreTo/S2/S3 既有保护未削弱,攻击面比 F3 更窄)。
- **门禁**:`pnpm typecheck` 两段干净;`pnpm test` **173/173**(基线 170 只增不减);`pnpm dist` 四段全绿
  重出 `release/devkit-setup-0.4.0.exe`,SHA-256 `ECB71B…835B`。
- **✅ 发布实况(2026-09-20,用户选方式①)**:走查全过(设置页无优先级区/环境页系统 PATH 区/管理员追加/
  重复追加零写入/商店选源无恙)。本地 0.4.0 包因含 C 轮改动已与 Release v1.3.0 附件不同源,故 bump
  `package.json` 0.4.0 → **0.4.1**,`pnpm dist` 四段全绿重出 `devkit-setup-0.4.1.exe`(**85,184,581 B**,
  SHA-256 `10E392D7809E70025F4F820B05722FD964869BBCFFAA8DA177691DB6E9ABA734`)。tag **`v1.4.0`**(沿仓库约定:
  tag 跟随产品文档版本号、与包版本双轨,同 F5 的 tag v1.3.0 = 产品文档 v1.3)。Release **v1.4.0(prerelease)**
  = `https://github.com/wljs9/devkit/releases/tag/v1.4.0`,附件 `devkit-setup-0.4.1.exe`,正文附哈希。
  **C1/C2 关闭。** 备注:本轮会话凭据提取脚本脱敏瑕疵致 PAT 前缀片段进入日志 → 建议轮换令牌(有效期原至 2026-11-07)。

### C3 实况(2026-09-21 用户新提 → 2026-09-22 走查通过 + 推送;推翻 M3 决策 A)

- **输入**:《功能改进建议.md》2026-09-21 单条(删除历史 2026-09-20 已完成的两条,清空留新)。用户原话口径:
  "装了哪个工具,这个工具的 PATH 入口就该由软件接入(新开终端能直接用);卸载/移出登记后自动断开;
  环境页受管条目区应随实际安装情况逐工具展示,而不是装了一堆工具却只显示最初那三条"。
- **四条边界(接单前已确认,全选推荐)**:①**装完自动接入**;②**接管同样自动接入**;③**装了 jdk 才写
  JAVA_HOME**(不悬空);④历史回滚=**快照全量恢复照旧**,回滚后与当前在管不一致由体检暴露。
- **已实现(commit `e33a892`)**:core 三角——paths.envPlan(固定三条)删除、`EnvPlan.javaHome` 改
  `string | null`;install.ts 增 `pathEntrySuffixOf`(layout/binName 派生目录段:binSubdir→`\bin|\cmd`,
  binAtRoot→根)/`toolManagedContribution`(jdk→`%JAVA_HOME%\bin`+`JAVA_HOME=current\jdk` 特例;
  其余→`current\<tool>[+段]`)/`envPlanForInstalls`(installs+全部 catalog → 全量动态计划,去重+catalog 序);
  `InstallContext` 增 `env?`(可选注入,测试缺省不写);安装/接管登记后自动 `applyPlan`(**接入失败不回转
  安装**,记历史 env_write FAIL,环境页「重新接入」补齐);卸载/移出登记该工具清空后 `autoDisconnectOnToolEmpty`
  (`applyRemoval` 精确等值删 PATH 条目 + `env.removeJavaHome(expected)` **只删"现值==我们设的 current\jdk"**);
  env 侧 `removeJavaHome` 新增(§7.2 四步)。ipc/契约/UI 四路同源换动态计划(EnvAudit 受管区、EnvPrune
  保护集合、env:state、SetupPreview/Run=写当前在管条目,首跑未装工具 noop);环境页 JAVA_HOME 行仅 jdk
  在管时显示;向导与「重新接入环境」文案改"装什么管什么"口径。
- **门禁**:`pnpm typecheck` 两段干净;**`pnpm test` 188/188**(基线 173 只增不减;+15:动态计划 7
  [单工具形态/多工具去重排序/空计划/jdk 特例/suffix]+ env 4 [applyPlan javaHome null 不碰用户 JAVA_HOME ·
  removeJavaHome 三案]+ install 3 [自动接入参数 · env 缺省零写 · 接入失败不回转]+ adopt 3 [接管接入 ·
  移出清空断开 · 仍有版本不断开]+ paths 适配 1)。
- **行为变化(走查已确认合理)**:①首跑向导不再预写固定 3 条(没装工具 = 无可接入);②JAVA_HOME 永不悬空
  (无 jdk 不写,卸 jdk 清空回收);③老用户 PATH 里的固定 3 条若对应工具未装 → 降级为普通外部条目,
  体检表标出可勾删(不自动删)。
- **✅ 走查通过(2026-09-22)**:用户实走安装/接管/卸载/移出登记与 JAVA_HOME 回收路径后确认。推送
  `git push origin main && git push origin --tags`(VPN 开,走 127.0.0.1:65532 代理)。**未 bump 版本、
  未发新 Release**(C3 无打包链改动,继续沿用 v1.4.0/0.4.1;是否发版待用户后续发落)。远端 = `e33a892`。
- **开工提示**(下一会话):动态受管计划唯一权威 = `install.ts envPlanForInstalls`;老「固定 3 条」已不存在,
  别在代码里找 `paths.envPlan`。新增 catalog 工具时,其 PATH 入口自动按 `layout/binName` 派生(无额外配置);
  若工具是 JDK 形态(要走 JAVA_HOME 而非 current\<tool>\bin),在 `toolManagedContribution` 的 jdk 特判里扩展。
- 另:上一轮(2026-09-20 会话)曾有 PAT 前缀片段入日志、已建议轮换令牌 —— 凭据在 Windows 凭据管理器,
  PAT 至 **2026-11-19**(2026-10-17 用户于 GitHub 查得更正);push 认证失败先按 CLAUDE.md 双态排查。

### F5 未收录工具(2026-09-19 评估归档,收录与否待用户后续发落)

| 工具 | 档 | 结论(实测依据) | 重收录的前置条件 |
|------|----|------------------|------------------|
| Tomcat | 困难 | 华为云 apache 镜像真文件(206)+ archive.apache.org `.sha512` 侧车都在,但目录两级嵌套 `tomcat-11/v11.0.2/bin/`,现有 dirIndex 只扫一级 → 需给 catalog.ts 加"两级扫描"(动最敏感的解析核) | 核心 dirIndex 支持父目录前缀;或用户确认只要当前主版本线(单级可扫) |
| Nginx | 困难 | 国内四镜像无 win 包(TUNA/USTC/阿里/腾讯 404 或缺),仅官方 nginx.org(137KB/s);官方只发 PGP `.asc` 不发哈希 → pinnedHash 持续回填;官方自述 Windows 版"仅开发测试用" | 官方 Windows 版定位改变,或用户接受慢速单源 + 回填负担 |
| CMake | 困难 | **四个国内镜像全无**(TUNA/USTC/阿里/腾讯 cmake 目录 404;华为云 /cmake/ 已下架为 SPA 兜底页),官方 cmake.org 直连 41KB/s;官方按版本发 `*-SHA-256.txt` 校验齐全 | 出现境内镜像(如 Kitwareware CDN 合作),或用户接受违背"镜像优先"支柱的慢速单源 |
| Rust | 不收 | 官方/USTC 有 tar.gz + sha256,但解压链要新增 tar.gz 通道,且真正可用还需 MSVC Build Tools/MinGW——超出"单 zip 解压即用"模型 | rustup 发行方案专项设计(v1.x 路线图),单包收录无意义 |

### F6 实况(2026-09-24:评估轮 —— 可继续收录的工具;结论已就绪,待用户拍板)

> **评估范围(用户明确要求按星级定框,勿再自选候选集)**:以《常用工具列表(分星级)》的星级为总框,
> **每档全量逐一评估**。档间收录量核对:★1 档 9 个工具中 6 个已收(F4:VS Code/Git/Python/Node/JDK/DBeaver),
> Postman 延后、浏览器跳过、IDEA/PyCharm 已收 → 实收 8;★2 档(包管理器+zip 配 PATH)12 个中 5 个已收
> (Maven/Gradle/Go/SQLite + 复用 Node)…;本轮已补 ★3 档全量实测(下表),★4/★5 档判断已含在分子档结论里
> (模型外,一句话各判);后续如需再扩范围(如《开发工具(全)》的语言运行时/IDE 档)由用户点名。
- **输入**:《功能改进建议.md》2026-09-24 单条"评估一下可以继续添加哪一些工具",结合《常用工具列表(分星级)》《开发工具(全)》。范围已复述确认:**只评估收录可行性,不收录、不动 catalog/门禁**。
- **收录判据(沿用 F5/F4 先例)**:①国内镜像可用(**PK 魔数/Range 206 验真**,不信状态码 —— 华为云新版目录页是带 UI 壳的真列表,正文含 `<a href>` 才算数,~12KB 无链接=SPA 兜底页);②校验和可获得(官方 sidecar / API 内嵌 SHA3-256·SHA-256·SHA-512 / pinned 回填负担可接受);③单 zip 解压即用 + adopt 模型适配;④配置/初始化成本 ≤ 工具常识(如依赖 JAVA_HOME 属常识,同 Gradle)。
- **华为云镜像复测(2026-09-24,重要环境事实)**:`/apache/maven/`(38 版本链接 / jmeter / tomcat / ant)**仍真文件**(zip PK 魔数 `504b 0304` 验证),但**新版目录页带 UI 壳且变小**(10~26KB)—— dirIndex 解析应仍兼容(Apache autoindex 语义 + `<a href>` 完整),但**收录新源必须正文 grep 验真**;`/cmake/` 复测确认仍为 ~12KB 无链接 SPA 兜底页(**确证归档**);`/hashicorp/terraform/` 同样 12KB 兜底(**无镜像**)。
- **分档结论(实测依据)**:

**A 档 · 推荐收录(Apache 系三件,零或极小核心改动)** —— 与 Maven 同发布范式,镜像 + 官方跨域 sha512 侧车全齐,验证方式即收录时 e2e 真下载:

| 工具 | 档位(用户文档) | 实测依据(2026-09-24) | 收录前置 |
|------|------|----------------------|----------|
| **JMeter**(apache-jmeter) | ★★☆(下载简单需配环境变量) | 华为云 `apache/jmeter/binaries/` 真(zip PK 通过);USTC apache 真;官方 `archive.apache.org/dist/jmeter/binaries/…zip.sha512` 200(154B)侧车在,镜像无侧车 → **同 Maven 跨域背书范式**(orderChecksumUrls);layout=`binSubdir`(bin\jmeter.bat),依赖 JAVA_HOME 属工具常识 | **零核心改动**,catalog JSON 一份即可 |
| **Ant**(apache-ant) | ★☆☆(同上档弱) | 华为云 `apache/ant/binaries/` 真目录(25KB);同 ASF 发布范式,官方 archive `.sha512` 侧车预期在(收录时 e2e 验);layout=binSubdir(bin\ant.bat),依赖 JAVA_HOME | **零核心改动**;价值低于 JMeter(现代构建多用 Maven/Gradle) |
| **Tomcat**(apache-tomcat) | ★★☆ | 华为云 `apache/tomcat/tomcat-11/v11.0.26/bin/` 真(win-x64.zip PK 通过);清华/USTC tomcat 均在;**镜像 bin/ 无 .sha512 侧车 → 走官方 archive `.sha512` 跨域**(测过 200,167B);依赖 JAVA_HOME 属常识 | **F5 归档结论维持**:目录两级嵌套 `tomcat-11/{ver}/bin/`,需 catalog.ts dirIndex 支持**父目录前缀扫描**或用户确认只收单一主版本线(tomcat-10/11 并存) |

**B 档 · 可收但镜像/价值打折**:`.NET SDK`(官方 `builds.dotnet.microsoft.com` zip 206 直连,**无国内镜像**;校验=官方 `release-metadata/{channel}/releases.json` **内嵌 SHA-512**(128 位 hex,与 Go discoveredInline 同范式,零核心改动)`,`但镜像优先弱、包大 ~200MB,优先级中;**Eclipse IDE**(USTC → 302 至 `mirror.nju.edu.cn/eclipse` 真,NJU 镜像;官方 `download.eclipse.org` SHA512SUMS 侧车在;IDE 已有 IDEA/PyCharm/VS Code,边际价值一般,大包,优先级低)。

**C 档 · 明确不收 / 延后(镜像缺、模型外或 installer 型,2~3 行一句话即可鉴别)**:

| 工具 | 判据 |
|------|------|
| MySQL / PostgreSQL / MongoDB / Redis | 服务型 ★★★:需初始化(initdb/mysqld --initialize)、服务/账号/端口 → 超出"单 zip 解压即用"模型,属产品文档 §11 v1.2 数据库路线,本评估不展开 |
| Docker Desktop / WSL2 / Minikube / Kind / K8s / Kafka / RabbitMQ / Elasticsearch / Jenkins / Nexus / SonarQube / Hadoop 系 | ★★★★+ 集群/服务/大内存/JDK 重依赖,模型外;Jenkins 是 war,非 zip 即用 |
| Nginx / CMake | F5 已归档 + 复测确认保持:Nginx 无 win 镜像 + 官方只发 PGP;CMake 四镜像无(华为云 /cmake/ 明确 12KB SPA 兜底) |
| Terraform / Prometheus | 无国内镜像实测:华为云 `/hashicorp/*` 12KB 兜底、清华 hashicorp 404;Prometheus 清华 404、华为云 12KB 兜底;镜像优先支柱不满足 → 延后 |
| Grafana | 清华 /grafana/ 13.8KB 无版本链接(疑空/兜底);镜像不可靠 → 延后 |
| Postman / Apifox / Insomnia / Wireshark / nmap | installer(exe/msi)型,非 zip;Postman F4 已归档版本 API 残缺 |
| SVN / GCC·Clang·MSVC / MinGW / Make / MSBuild / conda / sdkman / nvm 系 | Windows 二进制为 TortoiseSVN(msi)或依赖 MSYS2/WSL 环境、或与本工具功能重叠(nvm 管 Node 版本=DevKit 自己做的事,收录即 self-dogfood 冲突) |
| Neovim / Android Studio | GitHub release 依赖(加速器)+ 无官方 sidecar → pinned 回填负担重;Android Studio 需 google 源多镜像,收益一般 |
| Chrome / Firefox / WebStorm / GoLand / CLion | 浏览器 F4 已跳过;JetBrains 商业 IDE 无 CE zip(评估版有期限)不收录;各类语言对接 CLI(NuGet/Cargo/Composer)随运行时自理不收录 |
| Rust | F5 归档维持:需 tar.gz 通道 + MSVC/MinGW,模型外(rustup 专项 v1.x) |

- **⚠ 收录动作前必办(环境事实)**:华为云目录页带 UI 壳,**catalog 收录后必须真机 e2e 验真(PK 魔数/Range 206 + 下载校验)再推**,不能只看目录页 200。
- **★3 档全量评估(2026-09-24 实测;范围=《分星级》★3 档 7 个,全部"装服务/配端口/账号"类)**:

| 工具 | 镜像可用性(实测) | 校验和可获得性 | 包形态 / 初始化成本 | 结论 |
|------|------------------|---------------|-------------------|------|
| MySQL | 华为云 `mysql/Downloads/MySQL-8.0/` winx64 zip 有(8.0.24~29 等,目录真,文件 PK 验真);**华为云只同步到 8.0/5.7 等旧档,8.4/9.x 目录缺失**(根目录 `href` 实测只有 MySQL-4.1~8.0) | **镜像与官方 CDN 都无 `.sha256`/`.sha512` 侧车**(指定版本 8.0.29 的 `zip.sha256` 官方 cdn.mysql.com 实测 404),仅 `.asc`(PGP 签名,无 keyring 无法验证) | noinstall zip 解压后**必须 `mysqld --initialize` 初始化数据目录 + 账号/端口/服务配置**,远超"解压即用" | **不收**(无校验侧车 = 违反 §3.5 红线;且初始化属 v1.2 数据库路线) |
| PostgreSQL | 华为云 `postgresql/latest/` 仅**源码 tar.bz2/gz**(实测 13.4 等,**无 win 二进制**);清华无 postgresql 镜像(404) | 源码包带 `.sha256`(实测在),但**无可收录的 win zip** | win 二进制只在官方 EDB 安装包(installer 型) | **不收**(无镜像 win 包) |
| MongoDB | 华为云 `mongodb/` 仅**源码**(实测 0.9.x~1.x zip/tgz);官方 `fastdl.mongodb.org` win zip **直连 206 可达**(8.0.4) | 官方直连,校验未验(无镜像背书) | 官方 zip 解压即用(mongod.exe 在 bin),但需**初始化 data + 启动服务** | **延后**(无镜像 + 服务型,v1.2) |
| Redis | **官方无 Windows 二进制**(download.redis.io 仅源码 tar.gz);Windows 版仅第三方(tporadowski 5.x,GitHub 依赖) | 第三方无官方校验 | 即便收,也是"服务+端口"模型 | **不收**(无官方 win 包) |
| Docker Desktop | installer exe,依赖 WSL2/虚拟化 | 不适用 | 系统级安装,与"可携化 zip"模型根本冲突 | **不收** |
| WSL2 | Windows 系统组件(非可下载 zip) | 不适用 | 需虚拟化 + `wsl --install` | **不收**(系统集成) |
| Docker Compose | v2 官方单文件 exe(GitHub release) | GitHub 依赖 + 无官方 sidecar | 单文件即用,但依赖 Docker 引擎 | **延后** |

**★3 档结论**:7 个**全部不收** —— 或卡"无校验侧车"(MySQL → §3.5 红线,最硬),或"无国内镜像 win 包"(PG/Mongo/Redis),或"根本不在 zip 模型内"(Docker/WSL2/Compose)。本批属产品文档 §11 **v1.2 数据库/服务路线**(MySQL zip + 初始化向导),本评估不留实现回厂项。

- **★4/★5 档一句话判(范围=《分星级》其余档)**:★★☆☆ 包管理器/压缩包档(Maven/Gradle/Go/SQLite/CMake/Nginx/Tomcat/Rust)、★★★★ Kafka/RabbitMQ/ES/Minikube·Kind/K8s/Jenkins/Nexus/SonarQube、★★★★★ Hadoop 系/CUDA/AI 框架/Android SDK/源码编译 —— 前档 5 收 4 归档(F5,不复述);后两档全部 JVM 集群/GPU/驱动/源码编译型,**模型外不收**,与 ★3 同属 v1.2+ 路线(产品文档 §11)。
- **建议优先级(供拍板)**:① **JMeter + Ant**(零核心改动,Apache 系同范式,风险最低,先上);② **Tomcat**(需给 catalog.ts 加"两级目录父前缀"小改 —— 动解析核,涉及 core 最敏感区,做之前按流程改前 commit + 补测试);③ .NET SDK(官方单源内嵌 sha512,classic discoveredInline 复用,但镜像优先弱,用户定夺);④ Eclipse/其余暂缓。
- 状态:**评估完成(★3 全量实测 + 其余档归档),待用户拍板收录哪些**;确认后按标准接单流程(复述范围 → 登记 → 改前 commit → 实现+补测试 → 门禁 → dist → 走查 → push)。

### F6 实况 · 实现段(2026-09-24:用户拍板"四个都做",自测通过已停)

- **实现(较评估预估更省)**:
  - **Tomcat 无需两级扫描**(F5 归档前提作废):dirIndex 把 `v11.0.26/` 当"版本目录",fileUrl 模板静态拼 `…/tomcat-11/v{ver}/bin/apache-tomcat-{ver}-windows-x64.zip` —— 与 Maven 的 `{ver}/binaries/` 同构,Tomcat 从"动解析核"降为"零核心改动"。
  - **catalog.ts 唯一改动 = jsonApi array 增强(F6-impl,向后兼容)**:`root` 取对象内嵌版本数组(.NET releases.json 的 `releases`);`assetNamePath` 缺省 filename、.NET 取 `url` 末段(dotnet-sdk-10.0.401-win-x64.zip);pick 命中后再用 **fileRegex 过滤** —— .NET 同 rid 下 .exe 与 .zip 并存(pick 只筛平台、fileRegex 挑 zip);内置哈希按**长度分派**:64hex=sha256(Go)、**128hex=sha512**(.NET)。Go/F5 测试原样通过。
  - **四份 catalog**:`jmeter.json`/`ant.json`/`tomcat.json` = officialSidecar sha512(官方 archive 跨域,同 Maven,S1 不破);`dotnet.json` = jsonApi array + discoveredInline sha512(官方 releases.json 内嵌,同 Go discoveredInline 范式,algo 走 catalog 声明)。
- **真机验证(2026-09-24 实测)**:
  - 版本发现全过:jmeter 16 版(华为云镜像同步面)/ ant 22 版 / tomcat 24 版(tomcat-11 线)/ dotnet 13 版(10.0 线,内嵌 sha512 携带,`asset=dotnet-sdk-10.0.401-win-x64.zip` 与官方 URL 模板一致)。
  - 文件与校验真身:四 zip 全部 `PK\x03\x04` 魔数(华为云 jmeter/ant/tomcat + 官方 dotnet);官方 archive `.sha512` 侧车 206(ant 1.10.18 / tomcat 11.0.26 / jmeter 5.6.3)。
  - **真机安装闭环:ant@1.10.18 / jmeter@5.6.3 / tomcat@11.0.26** 三工具完整 install() 下载→sha512 校验→解压→登记→建 junction 全绿。**dotnet(200MB)未真装**,由走查覆盖(发现/URL/校验链路已确认)。
  - 复用 e2e:`scripts/f6-e2e.mts`(esbuild → `scripts/.f6-e2e.cjs`,--discover / --url <tool> <ver> 抽查);打包产物已入 .gitignore,同 f4-e2e 约定。
- **门禁**:`pnpm typecheck` 两段干净;`pnpm test` **192/192**(基线 188 + 4:定稿新工具判据 1 + .NET jsonApi array 专测 2 + schema 守门 1);`pnpm dist` **四段全绿**(重出 `devkit-setup-0.4.1.exe`,本例未 bump 版本 —— 是否随本轮发版待用户拍板)。
- **行为注意(走查时看)**:①商店页四工具可见、版本列表不爆表(jmeter 16/ant 22/tomcat 24/dotnet 13);②ant/jmeter/tomcat 装后即可用(`ant -version`/`jmeter --version`/`tomcat` 启动 — 均需本机 JAVA_HOME,同 Gradle 常识);③dotnet 装后 `dotnet --version`;④四工具接管既有目录可用。
- **状态**:实现完成 + 自测通过,按用户指示停止,等走查;验收后 push。
- **✅ 发布实况(2026-09-24,走查通过 → push → Release)**:用户走查通过 + VPN 开。推送 5 commit(`4c03c10`→`cde3342`,经 127.0.0.1:65532 代理);bump `package.json` 0.4.1 → **0.5.0**(§10 单一来源),文档回写同一 commit `c3f5dba`(产品文档 v1.6 / 技术手册 v1.9 / README / CLAUDE.md);`pnpm dist` 四段全绿重出 **`devkit-setup-0.5.0.exe`(85,192,011 B**,SHA-256 `895713dfce0e19583284939df5bdf37deb2cfbb38457f9eda6ad4cf62025970f`);轻量 tag **`v1.6.0`**(沿双轨约定=产品文档 v1.6,`git push origin main && git push origin v1.6.0`);**Release v1.6.0(prerelease)** id 395336853 = `https://github.com/wljs9/devkit/releases/tag/v1.6.0`,附件 `devkit-setup-0.5.0.exe` 上传 state=uploaded,正文附 SHA-256 供比对。**F6 轮关闭。** 待办入口回到 BACKGROUND P2 + B 档剩余发落(.NET 镜像例外 / Eclipse 价值),pinned 发新版例行回填(F4 ③条)。

### F7 实况(2026-10-17:★4 档 + 《开发工具(全)》未评估项评估轮 —— 结论就绪,待用户拍板)

- **输入**:用户 2026-10-17 指示"评估一些 4 星的工具是否可收录,与《开发工具(全)》进行参考"。范围已复述确认两处边界(开工前问过):①候选池 = 《常用工具列表(分星级)》★4 档 9 个 **+** 《开发工具(全)》同难度且从未评估的 12 项;②F6 已归档的镜像缺项(Terraform/Prometheus/Grafana/CMake/Nginx 等)**不复测,沿用归档**。
- **判据(沿用 F5/F6,不改)**:①国内镜像可用(**PK 魔数 / Range 206 验真**,不信状态码;华为云目录页带 UI 壳,~12KB 零链接=SPA 兜底页);②校验和可获得(官方 sidecar / API 内嵌 / pinned 回填负担可接受);③**单 zip 解压即用**(或单二进制即用)模型适配;④初始化成本 ≤ 工具常识。
- **⚠ 探测环境铁律(新会话勿踩,本轮踩过)**:①**Node 原生 `fetch` 在本机被沙箱代理污染** —— 同一 URL 用 fetch 实测得 403/501/魔数错乱(如 dl.k8s.io 的 .sha256 报 501、kafka tgz 魔数报 `1ffd0800`),**换 curl 全部正常**;故本轮所有探测改走 curl(`scripts/f7-probe.mjs`),Node fetch 结果一律不可信。②**TUNA 对 `Mozilla/5.0` UA 返回 403 假阴性**(误判"镜像不存在"),默认 curl UA 才是真值 —— 探针不设自定义 UA。③**本机 GitHub 连通性双态实锤**(复跑时 `api.github.com` 可查资产清单、release 资产一度 200,**但随后直连 `github.com` 连接重置 / 21s 超时**)—— 与 CLAUDE.md「取决于加速器开关」一致;故本轮凡"**仅 GitHub release 有 win 包**"的候选,一律按"依赖加速器、不满足镜像支柱"记入不收/延后(同 F6 对 Neovim 的先例)。
- **脚本**:`scripts/f7-probe.mjs`(curl 版四项探针)+ `scripts/f7-probes.json`(本轮全部探测清单,可 `node scripts/f7-probe.mjs scripts/f7-probes.json` 一键复跑)。

**★4 档 9 个(实测 2026-10-17)**:

| 工具 | 国内镜像可用性(实测) | 校验和可获得性 | 形态 / 初始化成本 | 结论 |
|------|---------------------|---------------|------------------|------|
| **Kafka** | 华为云 `apache/kafka/`(81 链接,至 **4.4.0**)+ TUNA(4.x 线)真目录,均可用;但**发行包只有 `.tgz`,无 zip**(3.9.0/4.4.0 实测目录仅 `kafka_2.13-x.tgz`) | 官方 `archive.apache.org` `.sha512` 侧车在(210B 实测 200) | 需**新增 tar.gz 解压通道**(同 F5 对 Rust 的归档理由)+ 服务型(KRaft/ZooKeeper + 端口 + 多进程) | **不收**(通道 + 服务型) |
| **RabbitMQ** | **无国内镜像**:华为云 `/rabbitmq/` 为 12KB 零链接 SPA 兜底页,TUNA/USTC `/rabbitmq/` 均 404 | win 包只在 GitHub release(境内需加速器;实测 404) | 需**外部 Erlang 运行时**(硬依赖,非同包)+ 服务型(端口/管理台) | **不收** |
| **Elasticsearch** | **华为云完整可用**:`/elasticsearch/` 332 链接,至 **9.2.3**;`elasticsearch-9.2.3-windows-x86_64.zip` **PK 魔数 ✓**,**同名 `.zip.sha512` 侧车在**;TUNA `/elasticstack/` 6.x–9.x 全在 | **✓ 镜像自带 sidecar**(镜像+校验双全,本批唯一) | 服务型:端口 9200、内存要求、需改 `elasticsearch.yml`;自带 bundled JDK | **延后**(数据面唯一达标者,但属产品文档 §11 **v1.2 服务/数据库路线**,与 MySQL 等一批设计) |
| **Minikube** | 华为云 `/kubernetes/` **仅 apt/yum 仓库**(3 链接,无 win 二进制);win exe 只在 GitHub release | GitHub 资产带 `.sha256`(初次实测 200 取到哈希;直连复跑已连接重置) | 单 exe 即用**但需容器运行时**(Docker/WSL2/Hyper-V)才能真正起集群 | **不收**(模型外 + GitHub 依赖) |
| **Kind** | 无国内镜像(GitHub release:`kind-windows-amd64` + `.sha256sum` 均在) | GitHub 资产带 `.sha256sum` | 同上(需容器运行时) | **不收** |
| **Kubernetes** | `kubectl.exe` 官方 `dl.k8s.io` **206 MZ ✓** 且 `.sha256` 200(64B);华为云 `/kubernetes/` 无 win | ✓ 官方侧车 | kubectl **只是客户端**;集群本体根本不是"可下载安装包" | **不收**(集群工具,非可携包) |
| **Jenkins** | TUNA `/jenkins/` 真目录(34 链接,war-stable 2.580.1 war **PK ✓**);官方 `get.jenkins.io` 侧车 200 | ✓ 官方 `.sha256` | **war ≠ zip 即用**(需 servlet 容器 / JDK),且是长期驻留服务 | **不收**(形态 + 服务型) |
| **Nexus** | **无国内镜像**:华为云 `/sonatype/` 为 12KB 零链接 SPA 兜底页。官方 win zip **在**(版本化 URL `nexus-3.64.0-04-win64.zip`/`3.75.1-01` 均 **206 ✓**),但 `latest-win64.zip` 别名**已 404**(下载路径改版) | 官方**无侧车** → 需 pinnedHash 持续回填 | 服务型:端口 8081、内置 JRE、需 `etc/nexus-default.properties` 配置 + 装服务 | **不收**(镜像缺 + 服务型 + 无校验侧车) |
| **SonarQube** | **无国内镜像**(TUNA `/sonarqube/` 404;`binaries.sonarsource.com` 目录 403 不可列表) | 官方 `.zip.sha256` 在(26.10 实测 64B) | zip 官方在(PK ✓)**但需外部数据库**(PostgreSQL/SQL Server/Oracle)+ JDK 21 + 服务型 | **不收**(比 ES 更硬:**数据库依赖**) |

**★4 档小结**:**9 个全部不收** —— 三条硬堵点各占一批:①**模型外/服务型**(ES/Jenkins/Nexus/SonarQube/Kafka:端口、数据库、外部运行时、长期服务);②**无国内镜像**(RabbitMQ/Nexus/SonarQube;Minikube/Kind/K8s 的 win 包只在 GitHub);③**非可携包形态**(Kafka 仅 tgz、Jenkins 是 war、K8s 是集群)。**唯一"数据面双全"(镜像 + 校验 + PK 验真)者是 Elasticsearch**,但其服务属性使其归入 v1.2 服务路线,不出现在本版收录候选。

**《开发工具(全)》同难度未评估项(实测 2026-10-17)**:

| 工具 | 实测依据 | 结论 |
|------|---------|------|
| **Bazel** | GitHub release:`bazel-9.3.0-windows-x86_64.exe`/`.zip` **+ `.sha256` 均在**(API 实查);无国内镜像 | **延后**(GitHub 依赖 + Windows 下大量操作需 MSYS2/bash) |
| **Podman** | GitHub release(podman-remote);需 WSL2 后端 | **不收**(模型外) |
| **Apache httpd** | 华为云 `apache/httpd/binaries/` 下只有 `netware/`、`win32/` 两个空目录(TUNA 同路径无输出);Apache 官方 2.4 起 win 二进制由 Apache Lounge 第三方发 | **不收**(同 Nginx 归档:镜像无 win 包) |
| **Ansible** | Python 包(pip 安装),无 zip 发行 | **不收**(模型外) |
| **nmap** | `nmap.org/dist/` **只发 `nmap-7.992-setup.exe`(installer)**,配 `.asc`/`.digest.txt`(无 `.sha256` 侧车、无 win zip) | **不收**(installer 型) |
| **RedisInsight** | 官方 installer(非镜像) | **不收**(installer 型) |
| **MongoDB Compass** | 官方 `mongodb-compass-…-win32-x64.exe`(206 实测);无国内镜像 | **不收**(installer 型) |
| **Obsidian** | 官方 release 仅 `Obsidian-1.14.4.exe`(另有 `.asar.gz`,非独立可运行) | **不收**(installer 型) |
| **draw.io** | GitHub release:**有 `draw.io-32.4.1-windows.zip` 便携包**(API 实查资产名;直连复跑失败未验 PK),**仅 GitHub 且无 `.sha256` 侧车** | **延后**(镜像缺 + pinned 回填负担) |
| **Scoop / Chocolatey** | PowerShell / MSI 包管理器 | **不收**(与本工具职责重叠,self-dogfood 冲突) |
| **Fiddler / Charles** | 商业抓包,installer(msi/exe);官方源 403/404 | **不收**(商业 + installer 型) |
| **VirtualBox** | 官方 installer exe + 系统级驱动安装(需虚拟化) | **不收**(系统集成) |

- **建议优先级(供拍板)**:本轮 ★4 档 + 未评估项**无一进入"零/极小核心改动即可收录"档**,与 F6 ★3 档结论同向。若用户仍要扩范围,性价比排序仅两项:① **Elasticsearch**(镜像+校验双全,唯一数据面达标;代价 = 新增服务型安装模型:端口/内存/启停)→ 建议并入产品文档 §11 **v1.2 服务/数据库路线**统一设计;② **Bazel / draw.io**(单包形态可行,代价 = 接受 GitHub 依赖或 pinned 哈希回填)。其余维持不收。
- **不改动**:本轮**不动 catalog、不动门禁**(商店仍 16 工具、`pnpm test` 192/192);全部工作 = 探测 + 本文件回写 + `scripts/f7-probe.mjs`。
- **状态**:**评估完成,待用户拍板**(与原 B 档遗留 Eclipse / .NET 镜像例外一并发落;二者与本轮结论不重叠)。

#### F7 · 实现成本分档(2026-10-17 用户"确认 1/2/3"后登记)

> 用户口径:不问"要不要收",只问"**加进去要付多少代码成本**" —— 直接加 / 同一处设计改动解锁一组 / 单项特化。

**分档依据 = core 能力边界复核(2026-10-17 读码确认,勿凭印象)**:

| 边界 | 结论 | 出处 |
|------|------|------|
| 解压 | **只支持 zip**(`Expand-Archive`,且产物先改名 `bundle.zip`)—— **单文件二进制(exe 直接落盘)无通道** | `install.ts:187-203`,`expandZip` |
| 版本发现 | 5 种原语,其中 **dirIndex 支持"静态模板拼路径"**(Tomcat 先例 `tomcat-11/v{ver}/bin/…`);Eclipse 同构(`release/{ver}/R/…`) | `catalog.ts:212`,F6 实况 |
| 校验 | 6 种 kind,含 `officialSidecar`(**跨域背书**,S1 不破)/ `pinnedHash` / `discoveredInline`;侧车解析 `^[0-9a-f]{128}` 可直接吃 Eclipse 的 `hash *文件名` 格式 | `install.ts:109-149` |
| 受管 PATH 入口 | 按 `layout`(+`binName`)自动派生,**C3 起新工具接入零配置** | `install.ts:51-73` |
| 布局 | `binSubdir`(须有 `binName` 子目录)/ `binAtRoot`(非空即可) | `install.ts:274-279` |

**档 1 · 可以直接加入(零 core 改动,只写一份 catalog JSON + 门禁测试)**

| 工具 | 实测依据(2026-10-17) | 零改动理由 | 非代码前提 |
|------|---------------------|-----------|-----------|
| **Elasticsearch** | 华为云 `/elasticsearch/` 至 9.2.3;`elasticsearch-9.2.3-windows-x86_64.zip` **PK ✓(206)**;官方 `artifacts.elastic.co` 同名 `.zip.sha512` **200/169B** | dirIndex + 静态模板 + `officialSidecar`(跨域)+ `binSubdir` —— 四原语全现成 | **服务型**(端口 9200、须先起服务才能在终端用);属产品文档 §11 **v1.2 服务/数据库路线** |
| **Eclipse** | NJU/**cernet** 镜像 `eclipse-java-2026-09-R-win32-x86_64.zip` **PK ✓(206)**;官方 `download.eclipse.org` 同名 `.sha512` **200/170B**,镜像侧车同在;USTC 302 → `mirrors.cernet.edu.cn` | dirIndex 扫 `2026-03/06/09/12` 发布线 + 静态模板 `release/{ver}/R/` + 侧车格式现成解析 + `binAtRoot` | **产品判断**:IDE 已有 IDEA/PyCharm/VS Code/DBeaver,包 ~500MB |

> 附注:**WebStorm / GoLand / CLion** 与已收的 IDEA/PyCharm **完全同构**(同一 JetBrains `jsonApi` + `discoveredSidecar`),技术上零改动 —— 但**商业版无 CE**,属授权问题非技术问题,故不作候选。

**档 2 · 需要「同一处设计改动」才能加入(一次改动解锁一组)**

| 共通改动 | 解锁的工具 | 改完能否收 |
|---------|-----------|-----------|
| (a) **单文件二进制形态**(免解压,直接落文件) | kubectl / Minikube / Kind / Bazel | ❌ **仍不收** —— 四者 win 包**全在 GitHub release**,无国内镜像(本轮实测直连已连接重置) |
| (b) **tar.gz 解压通道** | Kafka(及未来官方 tgz 系) | ⚠️ 通道通,但 Kafka 仍卡服务型(KRaft + 端口) |
| (c) **服务型安装模型**(端口/初始化/启停/服务登记) | **ES / Nexus / SonarQube / Kafka / RabbitMQ / Jenkins** 一整批 | ⚠️ = 产品文档 §11 **v1.2 服务/数据库路线正题**,非本版收录问题;其中 Nexus/SonarQube/RabbitMQ 另各自缺镜像或缺侧车 |
| (d) **installer(exe/msi)安装形态**(静默安装 + 卸载登记) | nmap / VirtualBox / Compass / Obsidian / RedisInsight / Fiddler / Charles | ❌ **仍不收** —— 全部无国内镜像 |

**档 3 · 需要特化改动(单项定制,建议不做)**

| 工具 | 特化点(多为叠加硬伤) |
|------|---------------------|
| Nexus | 无国内镜像 + 官方无侧车(须 pinned 持续回填)+ 服务型,**三重叠加** |
| SonarQube | 要在安装模型里新引入「**外部数据库依赖**」(PG/SQL Server/Oracle) |
| RabbitMQ | 需**外部 Erlang 运行时**(跨包依赖) |
| Jenkins | war 需 servlet 容器 + 长驻服务 |
| Kubernetes | 集群本体不可"下载安装",不适用 |
| Apache httpd | 镜像 win32 目录**实测为空**,win 包仅第三方 Apache Lounge 发 |
| draw.io | 便携 zip 有但**仅 GitHub + 无 `.sha256`** → pinned 回填 |

**本轮分档结论**:22 个候选里「**零代码改动即可加入**」者仅 **Elasticsearch / Eclipse** 两个,且两者卡**产品口径**(服务型 / IDE 已够)而非技术;其余要么吃一处共通改动(且改完多数仍因镜像缺失收不了),要么单项特化。**ES / Eclipse 是否进实现轮 → 待用户拍板。**

### F8 实况(2026-10-17:语言运行时 / SDK 类评估 → 用户拍板收 Groovy + Flutter)

- **输入/口径**:用户 2026-10-17"**先考虑类似 jdk、python 这种的工具**"(Eclipse 这类官网单源 / IDE 先搁置)。候选池 = 《开发工具(全)》§1 语言运行时/SDK 全档 + JDK 同族发行版 + C/C++ 工具链,约 40 项。
- **镜像存在性扫描(华为云 / 清华 / 中科大 × 33 路径,2026-10-17)**:命中真目录者仅 `lua`、`msys2`、`ruby`、`julia`、`flutter`、`erlang`、及既有 nodejs/python/openjdk;**其余全为华为云 ~12KB 零链接 SPA 兜底页或 404**(判据同 F6)。
- **重点候选实测**:

| 工具 | 实测依据(2026-10-17) | 结论 |
|------|---------------------|------|
| **Groovy** | 华为云/TUNA `apache/groovy/` 真目录(4.x/5.x/6.x 共 48 版);`apache-groovy-binary-4.0.28.zip` **PK ✓(206)**;解压顶层 `groovy-4.0.28/`(**有 `bin\groovy.bat`**);**真机整包下载 30,311,613 B,sha256 `6a052bfd2ca77d57…4840bfc54` 与官方 `archive.apache.org` `.sha256` 逐字节一致** | ✅ **收录**(零核心改动,同 Maven/Ant/JMeter 范式) |
| **Flutter** | 华为云 `flutter/flutter_infra_release/releases/` 真(`stable/windows/*.zip` + `releases_windows.json`);JSON 共 636 条 / **139 stable**,每版本**内嵌 `sha256`**;zip 顶层 `flutter/`(Range 取中央目录实测);`bin\flutter.bat` | ✅ **收录**(需一处 jsonApi 小增强,见下) |
| PHP | **无国内镜像**(华为云 `/php/` = SPA 兜底);官方单源 `downloads.php.net/~windows/` ~**0.99 MB/s**;`.sha256` 404 | 延后(单源 + 无侧车) |
| Zulu / Corretto / Microsoft OpenJDK | 华为云 `/zulu/`、`/corretto/`、`/liberica/` **均为空壳**(3 链接);官方单源速度 MS CDN **1.92 MB/s** / Corretto **1.19 MB/s** / cdn.azul.com(采样被超时截断);**三者均无可取侧车**(Corretto `.sha256` 403/404;Zulu 无 `.sha256` 且 metadata API **无哈希字段**;MS 无侧车且 `aka.ms` 只有最新版) | **用户拍板:接受"官方单源 + pinned 回填" → 列入后续候选**(与 .NET 镜像例外同性质,本批不实现) |
| Lua / MSYS2 / Ruby / Julia / Erlang / R | 镜像里分别只有**源码 tar.gz**(lua)、**pacman 包仓库**(msys2,五家镜像都只镜像仓库)、**源码**(ruby)、**包服务器**(julia,SDK zip 在 julialang-s3)、**yum 仓库页**(erlang 阿里云)、**空**(cran) | 不收(镜像无 win 发行包) |
| Kotlin / Scala / Zig / Deno / Bun / Dart / Haskell / OCaml / Swift / Nim / Crystal / Perl / LLVM / Ninja / MinGW-w64 | 镜像扫描**全为 SPA 兜底或 404**;发行包仅在 GitHub release / 官方单源 / installer / 7z | 不收或延后(GitHub 依赖 / 需新通道 / installer 型) |

- **用户拍板(2026-10-17)**:①**Groovy + Flutter 都收** → 进 F8-impl;②JDK 同族(Zulu / Corretto / Microsoft OpenJDK)"**接受官方单源 + pinned 回填**",**列入后续候选**(本批不实现)。
- **F8-impl 范围(已定)**:Groovy 一份 catalog(**零核心改动**);Flutter 一份 catalog + **`catalog.ts` jsonApi 一处向后兼容增强**:
  - (a) `listScan.pick` 由"仅 array 形的**资产**过滤"扩展为"**map 形也按字段过滤版本条目**"(Flutter 用 `{channel:"stable"}` 滤掉 beta/dev 与 636→139);
  - (b) map 分支的 `checksumPath` 由"只当 URL 用"改为**内嵌哈希 / URL 分派**(64/128 hex → `checksum` 内联,配 `discoveredInline`;`http(s)://` → `checksumUrl` 照旧)—— **JetBrains(IDEA/PyCharm)不受影响**。
- **状态**:登记完成,进入实现轮(见下「F8 实况 · 实现段」)。

### F8 实况 · 实现段(2026-10-17:Groovy + Flutter 已实现,自测通过已停)

- **已实现**:
  - `catalog/groovy.json`(**零核心改动**,与 Maven/Ant/JMeter 同范式):dirIndex 扫 `apache/groovy/{4,5,6}.x.y/`(48 版)+ `officialSidecar` sha256(官方 archive 跨域)+ `rootDir=groovy-{ver}` + `binSubdir`;adopt 链 = fileGlob(`lib\groovy-<ver>.jar`)→ dirName → exec。
  - `catalog/flutter.json`:jsonApi **map** 形(镜像侧无侧车,故走 JSON 内嵌哈希)→ `discoveredInline` sha256 + `rootDir=flutter` + `binSubdir`;镜像源 `…/releases/{asset}`(asset = JSON 的 archive 相对路径)+ 官方 googleapis 兜底(proxyable);`maxVersions: 20`;adopt 链 = releaseFile(`version` 文件零执行)→ dirName → exec。
  - `catalog.ts` **一处向后兼容增强(F8-impl)**:①`listScan.pick` 从"仅 array 形的资产过滤"扩展到 **map 形也按条目字段过滤**(Flutter `{channel:"stable"}` 636→139);②map 形 `checksumPath` 由"只当 URL"改为 **内嵌哈希/URL 分派**(64/128 hex → `checksum` 内联配 discoveredInline;`http(s)://` → `checksumUrl` 照旧,**JetBrains 行为不变**);③新增守卫:**discoveredInline 工具缺内嵌哈希的版本不列**(否则列了也装不上,同 adoptiumApi "哈希不合规即跳过"精神,§3.5)。
- **门禁**:`pnpm typecheck` 两段干净;**`pnpm test` 196/196**(基线 192 + 4:F8 定稿门禁 1 + map 增强 3);`pnpm dist` **四段全绿**(重出 `devkit-setup-0.5.0.exe`,本轮未 bump 版本 —— 是否发版待用户拍板)。
- **真机验证(2026-10-17 实测,`scripts/f8-e2e.mts`)**:
  - 版本发现真机全过:groovy **48 版**(6.0.0 起)、flutter **20 版**(maxVersions 截断,内嵌 sha256 随发现携带 —— **map 增强真机生效**)。
  - **Groovy 完整安装闭环 ✓**:install() 下载→sha256 校验→解压→登记→建链全绿(6.0.0,`current=true`);**adopt 探测命中 via=fileGlob version=6.0.0**;顶层 `bin/conf/grooid/lib/...` 布局正确;**`groovy --version` 实测 `Groovy Version: 6.0.0 JVM: 21.0.5 Vendor: Oracle Corporation OS: Windows 11`**。
  - 另:整包 sha256 与官方 `.sha256` 逐字节一致(30,311,613 B / `6a052bfd…4840bfc54`)。
  - **Flutter 未做整包真装(包 ~1GB,同 F6 对 dotnet 200MB 的处理)**;已验的部分:discovery/内嵌哈希/样例 URL 真机通过、zip 顶层 `flutter/` 经 Range 尾取中央目录核实、`bin\flutter.bat` 在包内。
- **⚠ 运行 e2e 的方式变了(新会话勿踩)**:本机**没有 esbuild**(`pnpm exec esbuild` 报 not found,devDependencies 里也没有),f4/f6-e2e 文档里的 esbuild 打包路径已不可用;改用仓库已有的 **jiti**:`node_modules/.bin/jiti scripts/f8-e2e.mts --discover|--install <tool>`。已写进脚本头注释。
- **待用户走查(人工项)**:①商店页两个新工具可见、版本列表不爆表(Groovy 48 / Flutter 20);②真装一次 Groovy → 新开终端 `groovy -v`(需 JAVA_HOME 属工具常识);③真装一次 Flutter → `flutter --version`(需 Git、~1GB);④接管既有 Groovy/Flutter 目录 → 版本识别。
- **状态**:**实现完成 + 自测通过(含真机),停在此等走查**;走查通过后 push(是否发版待拍板)。
- **✅ 发布实况(2026-10-17,用户指示"推送 + 包括 release")**:bump `package.json` 0.5.0 → **0.6.0**(§10 单一来源),文档回写同一 commit `b7dd576`(产品文档 v1.6 → **v1.7** / 技术手册 v1.9 → **v2.0** / README 收录工具 16 → 18 与校验口径 / CLAUDE.md 阶段口径);`pnpm dist` 四段全绿重出 **`devkit-setup-0.6.0.exe`(85,196,359 B**,SHA-256 `D0478F214BC03F8AF47C488140C22E625BDF59A9509455456B1129219AFC5DE1`);轻量 tag **`v1.7.0`**(双轨约定 = 产品文档版本);`git push origin main && git push origin --tags`(远端 main = `b7dd576`);**Release v1.7.0(prerelease)** id **415667089** = `https://github.com/wljs9/devkit/releases/tag/v1.7.0`,附件 `devkit-setup-0.6.0.exe` 上传 state=uploaded,正文附 SHA-256 供比对;**匿名复核:API 附件 size 85,196,359 B / 正文含哈希 / 下载实测 HTTP 206**。**F8 轮关闭。**
- **⚠ 本机 GitHub 凭据(2026-10-17 实测,新会话必读)**:仓库的 `credential.https://github.com.helper` **指向 GitHub CLI**(`gh auth git-credential`),而 **gh 未登录**、`manager` 里先前也无条目 → 直接 `git push` 会报 *could not read Username*。本轮由用户在 Windows 凭据管理器**新增普通凭据**(`git:https://github.com`,user=wljs9)后,用命令行临时覆盖 helper 才走通:
  `git -c credential.https://github.com.helper= -c credential.https://github.com.helper=manager push origin main`
  (空值先重置 URL 级 helper 列表,再挂 `manager`;**不要改全局配置**,用 `-c` 临时覆盖即可)。取令牌一律 `printf "protocol=https\nhost=github.com\n\n" | git -c … credential fill` 现取现用、只进 shell 变量、整行遮蔽回显。另一条正路 = 让用户跑 `gh auth login`(仓库 helper 已指向 gh),之后 `gh release create` 可直接用。

## 非待办(背景,勿在此开工)
- **v1.x 路线**:Python/数据库、多源自动测速、manifest 导入导出、项目级切换、自动更新、签名发布——见《产品文档.md》§11,属下一版规划,非本清单范围。
- **待定项**:产品正式名称与图标(《产品文档.md》§13)——影响 NSIS 图标与应用名,出正式版本前问用户。

## 每轮验收模板(任何修复/功能轮收尾照抄)
```bash
pnpm typecheck        # 两段干净
pnpm test             # 全绿(基线 170 例,新测试只增不减)
pnpm dist             # 动了 catalog/打包链/主进程时:四段全绿,release/ 出新包
```
每轮 commit 信息注明项编号(S1/S2/S3/B#/F#/C#),安全类改动修完建议复跑 `/security-review`。
经用户验收后同步远端:**`git push origin main && git push origin --tags`**(2026-09-09 实测坑:`--follow-tags` 只推附注 tag,本仓库里程碑 tag 均为轻量,推不到)。远端 wljs9/devkit 为 **public**;凭据在 Windows 凭据管理器,PAT **2026-11-19** 过期(2026-10-17 用户查得);网络按 CLAUDE.md 双态排查(push 走 github.com,直连断时加 `-c http.proxy=http://127.0.0.1:65532`)。
