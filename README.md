# DevKit —— 开发环境管理器(暂定名)

Windows 桌面工具:从**国内镜像**(华为云 / 清华 TUNA / 中科大 USTC 等)高速下载开发工具
(JDK Temurin / Node.js / Maven),**可携化安装、秒级多版本切换**,并以
"单入口 PATH + Junction + 历史回滚"的方式让环境变量永远干净。

> 产品与工程文档:《产品文档.md》(功能)、《技术手册.md》(编码与测试门禁)、《需求分析.md》(背景)。

## 三个支柱

1. **镜像优先**:国内源是默认下载渠道,断点续传 + 校验和(SHA-256/SHA-512)默认拒绝坏包;
2. **可携化**:不跑安装向导、不写注册表(环境变量除外)——`DevRoot\tools\<tool>\<ver>` 真实文件,
   `DevRoot\current\<tool>` 用 Junction 指向当前版本,切换 = 重建一个链接,PATH 一个字符都不变;
3. **环境变量卫生学**:用户 PATH 终身只被本工具添加固定 3 条 + `JAVA_HOME`;任何写入前自动快照备份,
   环境页可逐条体检(✓ 正常 / ⚠ 失效 / ✗ 未接入)、勾选清理、一键回滚。

## 界面

侧边栏五页:软件商店(装任意版本)/ 已安装(切换·卸载)/ 环境(体检·清理·快照回滚)/
历史(时间线·回滚)/ 设置(DevRoot·镜像源优先级·代理·并发·缓存)+ 首跑向导。
顶栏常驻下载进度与"环境未接入"提示。

## 从源码运行

要求:**Node ≥ 22、pnpm ≥ 9**(没有 Node?恰好本工具的第一个 dogfood 场景:先手工装一个)。

```bash
pnpm install
pnpm bin:electron   # Electron 二进制(npmmirror 下载 + 解压;GitHub 不可直连的机器必跑,见技术手册 §7.6)
pnpm dev            # electron-vite 三入口热加载
```

常用脚本:`pnpm typecheck` / `pnpm test`(vitest 双 project:core 在 node 环境直测,含真实注册表**沙盒键**
`HKCU\Environment_DevKitTest` 与真 zip 端到端;renderer 冒烟)/ `pnpm env-selftest`(PowerShell 注册表链路自检)/
`pnpm m0`(镜像探测)。

## 打包与安装(自己出包)

```bash
pnpm dist   # typecheck → test → build → NSIS 安装包(release/devkit-setup-<版本>.exe)
```

- 安装位置:**向导中可选目录**(默认 `%LOCALAPPDATA%\Programs\DevKit`,per-user,不需要管理员,绝不写 HKLM);
- 脚本内置 npmmirror 镜像(`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`),GitHub 不可达也可出包。

### SmartScreen 提示(MVP 不签名,预期行为)

安装器**未做代码签名**(技术手册 §10:MVP 决定,签名证书留 v1.x 评估)。Windows 首次运行会蓝底提示
"已保护你的电脑 —— 未知发布者":点 **“更多信息” → “仍要运行”** 即可,这是正常路径而非损坏。
介意的话可用 `Get-FileHash release\devkit-setup-*.exe -Algorithm SHA256` 比对发布渠道公布的哈希。

### 数据与卸载

| 落点 | 内容 |
|------|------|
| `%APPDATA%\DevKit\devkit.json(.bak)` | 安装登记 / 设置 / 目录缓存 |
| `%APPDATA%\DevKit\env_backups\*.json` | 每次环境写入前的全量快照(留最近 20 份) |
| `%APPDATA%\DevKit\history.jsonl` | 操作历史 |
| `<DevRoot>\tools / current / cache` | 真实文件 / Junction / 下载断点 |
| `HKCU\Environment` | 固定 3 条 PATH + `JAVA_HOME`(写入前必有快照) |

卸载(`设置`→系统"应用和功能"→卸载,或跑安装器里的卸载项)移除**程序本体**;
`DevRoot`、`%APPDATA%\DevKit`、用户 PATH 条目与 `JAVA_HOME` **不会被动**——这是有意的:
环境变量与工具文件属于"你的机器状态",不是安装器资产。若想卸前清干净:
**环境页 → 用快照区 [恢复此状态] 把 PATH 回到接入前 → 删除 DevRoot 目录 → 再卸载**。

## 已知边界(v0.x / MVP)

- 仅支持 **Windows 10/11 x64**;日常运行**不需要管理员**;
- 收录工具:Node.js、JDK (Temurin)、Maven;Python/数据库等见路线图(产品文档 §11);
- Electron 体积:安装包 ~90-120MB(选型时声明的代价,技术手册 §1),"用时才开"非常驻;
- Temurin 历史版本下载依赖第三方 GitHub 加速器 ghfast.top(设置页可换前缀/关代理);
- 产品正式名称与图标未定,当前使用 electron-builder 默认图标。
