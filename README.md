# DevKit —— 开发环境管理器(暂定名)

Windows 桌面工具:从**国内镜像**(华为云 / 清华 TUNA / 中科大 USTC / 腾讯云等)高速下载开发工具
(JDK Temurin / Node.js / Maven / Python / Git / VS Code / IntelliJ IDEA / PyCharm / DBeaver /
Gradle / Go / SQLite / Apache JMeter / Apache Ant / Apache Tomcat / .NET SDK),
**可携化安装、秒级多版本切换**,并以
"单入口 PATH + Junction + 历史回滚"的方式让环境变量永远干净。

> 产品与工程文档:《产品文档.md》(功能)、《技术手册.md》(编码与测试门禁)、《需求分析.md》(背景)。

## 三个支柱

1. **镜像优先**:国内源是默认下载渠道,断点续传 + 校验和(SHA-256/SHA-512)默认拒绝坏包;
2. **可携化**:不跑安装向导、不写注册表(环境变量除外)——`DevRoot\tools\<tool>\<ver>` 真实文件,
   `DevRoot\current\<tool>` 用 Junction 指向当前版本,切换 = 重建一个链接,PATH 一个字符都不变;
3. **环境变量卫生学**:用户 PATH 只添加**本工具实际在管的工具**入口(»装什么管什么«:装了/接管了哪个就接哪个,
   卸载/移出登记自动断开);任何写入前自动快照备份,环境页可逐条体检(✓ 正常 / ⚠ 失效 / ✗ 未接入)、勾选清理、一键回滚。

## 界面

侧边栏五页:软件商店(装任意版本·自选镜像源)/ 已安装(切换·卸载·**添加已有安装**)/ 环境(受管区=**在管工具逐条
✓/⚠**·体检·清理·快照回滚·**系统 PATH 追加**)/ 历史(时间线·回滚)/ 设置(DevRoot·代理·并发·加速器前缀·缓存·**系统 PATH 写开关**)
+ 首跑向导。顶栏常驻下载进度与"环境未接入"提示。

### 添加已有安装(接管本机既有目录)

机器上已经装好的 JDK / Node / Maven / Python / Git / VS Code / IDEA / DBeaver / Gradle / Go / SQLite / JMeter / Ant / Tomcat / .NET 等(如 `C:\Program
Files\nodejs`、`C:\Program Files\Java\jdk-21`)可以直接「已安装 → ＋添加已有安装」纳入管理:选工具 +
选目录,主进程按清单规则**校验目录并识别版本**,登记后 `current\<tool>` 指向它,于是也能 `/切换版本`。
接管**不复制、不移动、不删除**原目录里的任何文件,不想要了用 [移出登记] 摘掉记录即可(文件原样保留)。

### 系统 PATH(HKLM,默认关闭)

「设置 → 系统 PATH(HKLM)」的开关默认关闭。打开后,环境页的「系统 PATH(HKLM)」区可查看系统级 PATH 的
全部条目,并支持**追加一条**(如 `C:\Tools\bin` 或 `%TOOL_HOME%\bin`),给全机器加一个可执行目录。
刻意划出的边界:

- **只追加,不修改、不删除**——改哪条、删哪条,请到 Windows「设置 → 系统环境变量」手动处理(那里才是权威入口);
- 追加须为绝对路径或 `%VAR%` 引用;等值条目已在 PATH 里则零写入(幂等,不产生重复);
- 每次写入前自动快照,可在环境页/历史页回滚;回滚时 Windows 内置变量只写不删;
- 真正写入 HKLM **需要管理员权限**(未提权时界面会先提示,写入被系统拒绝会给可读原因)。

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
| `HKCU\Environment` | 本工具在管工具的 PATH 入口 + (管理 JDK 时)`JAVA_HOME`(写入前必有快照) |

卸载(`设置`→系统"应用和功能"→卸载,或跑安装器里的卸载项)移除**程序本体**;
`DevRoot`、`%APPDATA%\DevKit`、用户 PATH 条目与 `JAVA_HOME` **不会被动**——这是有意的:
环境变量与工具文件属于"你的机器状态",不是安装器资产。若想卸前清干净:
**环境页 → 用快照区 [恢复此状态] 把 PATH 回到接入前 → 删除 DevRoot 目录 → 再卸载**。

## 已知边界(v0.x / MVP)

- 仅支持 **Windows 10/11 x64**;日常运行**不需要管理员**;
- 收录工具:Node.js、JDK (Temurin)、Maven、Python、Git (MinGit)、VS Code、IntelliJ IDEA CE、PyCharm CE、DBeaver、Gradle、Go、SQLite (CLI)、Apache JMeter、Apache Ant、Apache Tomcat、.NET SDK;
  - 多版本:Node/Maven/JDK/Gradle/Go 全量历史版(各留最新 10 版展示);Python/DBeaver/SQLite 各留最新数版;Git/VS Code 镜像源只留最新稳定版;
  - 校验与更新口径:官方发 sidecar 的直接取(Gradle=官方 `.sha256`、JetBrains、Maven=官方 `.sha512`);API 内嵌的随发现携带(JDK=Adoptium API、Go=官方 dl API);官方不发布的走清单内嵌哈希表(Python/Git/DBeaver/VS Code/SQLite,发新版例行更新,**下载永远校验**,未收录版本拒装);
  - Gradle 运行依赖本机 JAVA_HOME(`gradle` 命令才能跑,安装本身不需要);SQLite 收录的是命令行工具包(sqlite3/sqldiff 等,不含 GUI 与 sqlite3.dll);
  - 数据库类工具(Python 生态的 pip/tkinter、DBeaver 插件等)与更多工具见路线图(产品文档 §11);
- Electron 体积:安装包 ~90-120MB(选型时声明的代价,技术手册 §1),"用时才开"非常驻;
- Temurin 历史版本下载依赖第三方 GitHub 加速器 ghfast.top(设置页可换前缀/关代理);
- 产品正式名称与图标未定,当前使用 electron-builder 默认图标。
