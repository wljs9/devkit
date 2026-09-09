# DevKit — 待办与流程清单(新会话按此继续)

> 建立:2026-09-08;改版:2026-09-09(安全修复轮 + R1 发布完成后重组)。
> 用法:新会话开场读 `CLAUDE.md` → 本文件。
> **当前状态:S1/S2/S3 + R1 全部完成并已发布(下方"归档"节,历史参考与发布配方,勿重做)。唯一活待办 = P2 节(等用户的 bug/功能/改进清单到手,按 P2 流程逐项做)。**

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
> 4. **实现 + 补测试**:门禁基线 **111 例只增不减**(§11);纯逻辑入 `src/main/core/`(arch.test 十模块铁律,渲染层组件保持哑);
> 5. **绿了才交**:`pnpm typecheck && pnpm test`;动到 catalog/主进程/打包链再 `pnpm dist`;
> 6. **单独 commit**:信息注明 `B#/F#/C#`,本节该条打勾 + 记 commit 号;
> 7. **小结等确认**(CLAUDE.md 阶段性执行铁律,严禁连做下一项);
> 8. **验收后同步**:`git push origin main && git push origin --tags`;若要出新版,整段照抄上方 **R1 配方**(bump → tag → dist → Release API,含安装包 SHA-256)。

| # | 类型 | 项 | 状态 |
|---|---|---|---|
| (待补) | | | |

## 非待办(背景,勿在此开工)
- **v1.x 路线**:Python/数据库、多源自动测速、manifest 导入导出、项目级切换、自动更新、签名发布——见《产品文档.md》§11,属下一版规划,非本清单范围。
- **待定项**:产品正式名称与图标(《产品文档.md》§13)——影响 NSIS 图标与应用名,出正式版本前问用户。

## 每轮验收模板(任何修复/功能轮收尾照抄)
```bash
pnpm typecheck        # 两段干净
pnpm test             # 全绿(基线 111 例,新测试只增不减)
pnpm dist             # 动了 catalog/打包链/主进程时:四段全绿,release/ 出新包
```
每轮 commit 信息注明项编号(S1/S2/S3/B#/F#/C#),安全类改动修完建议复跑 `/security-review`。
经用户验收后同步远端:**`git push origin main && git push origin --tags`**(2026-09-09 实测坑:`--follow-tags` 只推附注 tag,本仓库里程碑 tag 均为轻量,推不到)。远端 wljs9/devkit 为 **public**;凭据在 Windows 凭据管理器,PAT 约 2026-11-07 过期;网络按 CLAUDE.md 双态排查(push 走 github.com,直连断时加 `-c http.proxy=http://127.0.0.1:65532`)。
