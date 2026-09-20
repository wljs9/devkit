/**
 * 注册表读写与写入协议(技术手册 §7.1/§7.2)。
 * - 经 powershell.exe -EncodedCommand 调 resources/env.ps1,参数零引号注入;
 * - 写前全量快照,任一步失败用快照还原并 rethrow;
 * - 键名可注入:自动化/自检全部打 SANDBOX_REG_KEY,真实 Path 只走手动走查(§11);
 * - 禁 setx(§7.1),类型由 PS 侧显式 RegistryValueKind 保证(%VAR% 不被打平)。
 */
import { execFile as cpExecFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CoreError } from './errors';
import { mergePathEntries, removePathEntries, type EnvPlan } from './paths';

export interface EnvVar {
  name: string;
  /** 'String' | 'ExpandString'(REG_SZ / REG_EXPAND_SZ) */
  kind: string;
  value: string;
}

/** ★ F3:环境变量作用域 —— 'user' = HKCU\Environment;'system' = HKLM\...\Environment(需管理员) */
export type EnvScope = 'user' | 'system';

export interface EnvBackup {
  ts: string;
  regKey: string;
  /** ★ F3:快照作用域;老备份(无此字段)按 'user' 处理 */
  scope?: EnvScope;
  rows: EnvVar[];
}

export interface EnvApplyResult {
  changed: string[];
  backupFile: string | null;
  /** 广播结果:null=本次无写入未广播 */
  broadcast: 'ok' | 'timeout' | null;
}

/** applyRemoval 返回:在 EnvApplyResult 之上带实际删除的条目原文(§4.4 清理结果展示) */
export interface EnvRemovalResult extends EnvApplyResult {
  removed: string[];
}

/** ★ C2 applySystemPathAdd 返回:带实际追加的条目(幂等命中时为空数组) */
export interface EnvPathAddResult extends EnvApplyResult {
  appended: string[];
}

/** ★F3 快照作用域:优先显式 scope;老备份按 regKey 反推(SYSTEM_REG_KEY = 系统级) */
function scopeOfBackup(bk: EnvBackup): EnvScope {
  if (bk?.scope === 'system') return 'system';
  if (bk?.scope === 'user') return 'user';
  return bk?.regKey === SYSTEM_REG_KEY ? 'system' : 'user';
}

/** BROADCAST_OK/BROADCAST_TIMEOUT 标记解析(§7.1 Publish-EnvChange 的 stdout) */
function broadcastOf(out: string): EnvApplyResult['broadcast'] {
  return /BROADCAST_OK/.test(out) ? 'ok' : /BROADCAST_TIMEOUT/.test(out) ? 'timeout' : null;
}

export type ExecFileFn = (cmd: string, args: readonly string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFileFn = async (cmd, args) => {
  const { stdout } = await promisify(cpExecFile)(cmd, [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

/** §11:自动化测试沙盒注册表键(测完全删) */
export const SANDBOX_REG_KEY = 'Environment_DevKitTest';

/** ★ F3:系统级环境变量键(HKLM;写入需管理员权限) */
export const SYSTEM_REG_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/**
 * ★ F3 Windows 内置系统变量保护名单(不可删除)—— 系统本体与其他程序依赖其存在,
 * 误删 SystemRoot/ComSpec/TEMP 会把机器搞坏。★C2(方向 A,2026-09-20)起本名单只守一个口:
 * restoreTo 系统级回滚【永不删除】内置变量;F3 时代的"自定义变量增删改"整段下线。
 * 含系统 `Path`:C2 口径 —— 系统级唯一写出口是 applySystemPathAdd 的【追加一条】,
 * 它经 mergePathEntries 只增不减;名单里的 path 继续拦住任何"删除/覆写 Path 变量本身"的路径。
 */
export const PROTECTED_SYSTEM_VARS: readonly string[] = [
  'allusersprofile', 'appdata', 'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432',
  'computername', 'comspec', 'driverdata', 'homedrive', 'homepath', 'localappdata', 'logonserver',
  'number_of_processors', 'os', 'path', 'pathext', 'processor_architecture', 'processor_identifier',
  'processor_level', 'processor_revision', 'programdata', 'programfiles', 'programfiles(x86)',
  'programw6432', 'public', 'systemdrive', 'systemroot', 'temp', 'tmp', 'userdomain',
  'userdomain_roamingprofile', 'username', 'userprofile', 'windir',
];

/** 是否 Windows 内置(受保护)系统变量:大小写不敏感,前后空白容错 */
export function isProtectedSystemVar(name: string): boolean {
  return PROTECTED_SYSTEM_VARS.includes(String(name ?? '').trim().toLowerCase());
}

/**
 * ★ C2 系统 PATH 条目合法性:trim → 非空;不含 `;`(PATH 分隔符)与 `"`(Windows 路径禁字符)与换行;
 * 必须是盘符绝对路径或 `%VAR%` 前缀引用 —— 相对路径在系统 PATH 里语义不定,拒。
 * 通过校验则返回 trim 后的原文。
 */
export function assertSystemPathEntry(entry: string): string {
  const e = String(entry ?? '').trim();
  if (e.length === 0) throw new CoreError('system-path-entry', 'PATH 条目不能为空');
  if (/[;"]/.test(e)) throw new CoreError('system-path-entry', `条目不能含 ; 或 "(PATH 分隔符 / Windows 非法字符):${e}`);
  if (/[\r\n]/.test(e)) throw new CoreError('system-path-entry', '条目不能含换行');
  if (!/^[A-Za-z]:[\\/]./.test(e) && !/^%[^%;"]+%(?:[\\/].*)?$/.test(e)) {
    throw new CoreError('system-path-entry', `条目须为绝对路径(C:\\tools\\bin)或 %VAR% 前缀引用(%TOOL_HOME%\\bin):${e}`);
  }
  return e;
}

/** PS 单引号字面量(EncodedCommand 内再逃逸,双保险) */
export function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export interface EnvServiceOptions {
  /** 备份根目录(userData 注入;§7.2①) */
  userDataDir: string;
  regKey?: string;
  execFile?: ExecFileFn;
  /** 测试注入 env.ps1 内容;缺省读仓库 resources/ */
  psScript?: string;
  /** ★ F3 系统级写入门闸:壳层注入 `settings.allowSystemEnv`;**缺省(测试/未接线)一律拒** */
  allowSystem?: () => boolean;
}

export class EnvService {
  private readonly regKey: string;
  private readonly exec: ExecFileFn;
  private psSource: string | undefined;

  constructor(private readonly opts: EnvServiceOptions) {
    this.regKey = opts.regKey ?? 'Environment';
    this.exec = opts.execFile ?? defaultExec;
    this.psSource = opts.psScript;
  }

  /** 备份目录(env_backups)与 history 独立存放(§9) */
  get backupDir(): string {
    return path.join(this.opts.userDataDir, 'env_backups');
  }

  /** 一条命令 = env.ps1 全文 + 调用语句,整体 EncodedCommand */
  private async runPowerShell(calls: string[]): Promise<string> {
    if (this.psSource === undefined) {
      this.psSource = fs.readFileSync(new URL('../../../resources/env.ps1', import.meta.url), 'utf8');
    }
    const script = `${this.psSource}\n${calls.join('\n')}\n`;
    const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)]);
    return r.stdout;
  }

  async readAll(): Promise<EnvVar[]> {
    const out = await this.runPowerShell([`Get-Env -Key ${psLiteral(this.regKey)}`]);
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop();
    if (!line) throw new CoreError('env-read', `Get-Env 无 JSON 输出:${out.slice(0, 200)}`);
    const rows = JSON.parse(line) as Array<{ name?: unknown; kind?: unknown; value?: unknown }>;
    return rows.map((r) => ({ name: String(r.name), kind: String(r.kind ?? 'String'), value: String(r.value ?? '') }));
  }

  /**
   * §7.2 不可绕过的四步:①快照 → ②计算(envPlan/mergePathEntries 幂等) → ③写入+广播 → ④失败还原并 rethrow。
   * 无任何变化时不写不备份(幂等:重复"接入环境"零副作用)。
   */
  async applyPlan(plan: EnvPlan): Promise<EnvApplyResult> {
    const rows = await this.readAll();
    const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
    const javaRow = rows.find((r) => r.name.toLowerCase() === 'java_home');
    const merged = mergePathEntries(pathRow?.value ?? '', plan.pathEntries);
    const javaChanged = (javaRow?.value ?? '') !== plan.javaHome;
    if (!merged.changed && !javaChanged) return { changed: [], backupFile: null, broadcast: null };

    const backupFile = this.writeBackup(rows);
    const changed: string[] = [];
    const calls: string[] = [];
    if (merged.changed) {
      calls.push(`Set-Env -Key ${psLiteral(this.regKey)} -Name 'Path' -Value ${psLiteral(merged.value)} -Kind ExpandString`);
      changed.push('Path');
    }
    if (javaChanged) {
      calls.push(`Set-Env -Key ${psLiteral(this.regKey)} -Name 'JAVA_HOME' -Value ${psLiteral(plan.javaHome)} -Kind ExpandString`);
      changed.push('JAVA_HOME');
    }
    calls.push('Publish-EnvChange');
    try {
      const out = await this.runPowerShell(calls);
      return { changed, backupFile, broadcast: broadcastOf(out) };
    } catch (e) {
      // ④:尽力还原;还原也失败则把二次错误挂到原错误 context 上,仍 rethrow 原错误
      try {
        await this.restoreTo(rows);
      } catch (restoreErr) {
        if (e instanceof CoreError) e.context = { ...e.context, restoreAlsoFailed: String(restoreErr) };
      }
      throw e;
    }
  }

  /**
   * §4.4 PATH 清理:§7.2 四步应用于"删除"方向(快照→removePathEntries 仅等值命中→写+广播→失败还原)。
   * 受管条目(本工具 3 条)的拦截责任在壳层 ipc(决策 A:受管项只经向导接入/重连,不经清理删除);
   * removePathEntries 本身只做等值精确匹配,是红线 §3.3"绝不模糊删"的底层保障。
   */
  async applyRemoval(remove: string[]): Promise<EnvRemovalResult> {
    const rows = await this.readAll();
    const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
    const res = removePathEntries(pathRow?.value ?? '', remove);
    if (!res.changed) return { changed: [], removed: [], backupFile: null, broadcast: null };
    const backupFile = this.writeBackup(rows);
    const calls = [
      `Set-Env -Key ${psLiteral(this.regKey)} -Name 'Path' -Value ${psLiteral(res.value)} -Kind ExpandString`,
      'Publish-EnvChange',
    ];
    try {
      const out = await this.runPowerShell(calls);
      return { changed: ['Path'], removed: res.removed, backupFile, broadcast: broadcastOf(out) };
    } catch (e) {
      try {
        await this.restoreTo(rows);
      } catch (restoreErr) {
        if (e instanceof CoreError) e.context = { ...e.context, restoreAlsoFailed: String(restoreErr) };
      }
      throw e;
    }
  }

  /**
   * 系统 PATH(HKLM\SYSTEM\…\Environment,只读,不展开 %VAR%)——§4.4 体检的"系统"条目区。
   * 红线 §3.1:读可以,写绝不(本服务所有写口都钉死 CurrentUser);读取失败按"无系统项"降级,不阻塞用户 PATH 体检。
   */
  async readSystemPath(): Promise<string | null> {
    try {
      const out = await this.runPowerShell(['Get-SystemPath']);
      const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
      if (!line) return null;
      const o = JSON.parse(line) as { value?: string };
      return typeof o.value === 'string' && o.value.length > 0 ? o.value : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- ★ F3 系统级(HKLM,2026-09-14)→ ★ C2 收窄为"系统 PATH 追加"

  /** 系统级写入门闸:关闭(默认)时任何系统写入一律拒 —— 闸门在 core,不靠 UI 自觉 */
  private assertSystemWritable(): void {
    if (!(this.opts.allowSystem?.() ?? false)) {
      throw new CoreError('system-write-disabled', '系统 PATH 写入未开启:请到「设置 → 系统 PATH(HKLM)」打开开关(默认关闭)');
    }
  }

  /** 管理员权限探测(写 HKLM 的前置条件;探测失败按 false 处理,UI 据此先讲清楚) */
  async isElevated(): Promise<boolean> {
    try {
      return /ELEVATED_YES/.test(await this.runPowerShell(['Get-Elevated']));
    } catch {
      return false;
    }
  }

  /**
   * 系统变量全量读取(读不需要管理员)。★安全复查轮(C2)fail-closed 改造:
   * 输出无可解析 JSON 行【不再降级为空表】——本方法只被两条"先读后覆写"的写路径消费
   * (applySystemPathAdd / restoreTo 系统回滚),把"读坏了"当"真的空"会让
   * Set-SystemEnv 以单条新值【整体覆写系统 PATH】且备份同步失真,必须抛错拒写。
   * (展示用的读取走 readSystemPath,保留 null 降级语义,不受影响。)
   */
  async readSystemVars(): Promise<EnvVar[]> {
    const out = await this.runPowerShell(['Get-SystemEnv']);
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop();
    if (!line) throw new CoreError('system-read', 'Get-SystemEnv 无可解析输出,拒绝按虚假的"空环境"写入');
    const rows = JSON.parse(line) as Array<{ name?: unknown; kind?: unknown; value?: unknown }>;
    return rows.map((r) => ({ name: String(r.name), kind: String(r.kind ?? 'String'), value: String(r.value ?? '') }));
  }

  /**
   * ★ C2(方向 A):向【系统 PATH】追加一条 —— 本服务唯一的系统级"新增"写出口
   * (取代 F3 的自定义变量增/改/删;删除与改条目本工具不提供,用户到系统设置手动处理)。
   * §7.2 四步的系统版:条目校验 → 闸门 → 读现值幂等 merge(等值已存在 = 零写入零备份)
   * → 快照(scope=system)→ Set-SystemEnv 'Path'(保持原 Kind,缺省 ExpandString)→ 广播 → 失败快照还原。
   * 红线:只增不删(mergePathEntries 语义),绝不重写其余条目。
   */
  async applySystemPathAdd(entry: string): Promise<EnvPathAddResult> {
    const e = assertSystemPathEntry(entry);
    this.assertSystemWritable();
    const rows = await this.readSystemVars();
    // 双保险 fail-closed:正常机器的 HKLM Environment 键不可能零值(SystemRoot/Path/windir 必在),
    // 读出空表只可能是异常 —— 此时写入 = 用单条覆写整个 PATH 且备份失真,一律拒。
    if (rows.length === 0) throw new CoreError('system-path-read', '系统环境变量读取结果为空(异常),拒绝追加以防整体覆写系统 PATH');
    const pathRow = rows.find((r) => r.name.toLowerCase() === 'path');
    const merged = mergePathEntries(pathRow?.value ?? '', [e]);
    if (!merged.changed) return { changed: [], appended: [], backupFile: null, broadcast: null };
    const kind = pathRow?.kind === 'String' ? 'String' : 'ExpandString'; // PATH 惯例 ExpandString,保住 %VAR%
    const backupFile = this.writeBackup(rows, 'system');
    const calls = [
      `Set-SystemEnv -Name 'Path' -Value ${psLiteral(merged.value)} -Kind ${kind}`,
      'Publish-EnvChange',
    ];
    try {
      return { changed: ['Path'], appended: merged.appended, backupFile, broadcast: broadcastOf(await this.runPowerShell(calls)) };
    } catch (err) {
      try {
        await this.restoreTo(rows, 'system');
      } catch (restoreErr) {
        if (err instanceof CoreError) err.context = { ...err.context, restoreAlsoFailed: String(restoreErr) };
      }
      throw this.asSystemError(err, '写入');
    }
  }

  /** HKLM 写入被系统拒绝(未提权)→ 归一为可读原因,而非把 PS 的原始堆栈丢给用户 */
  private asSystemError(e: unknown, action: string): unknown {
    const msg = e instanceof Error ? e.message : String(e);
    if (/access is denied|unauthorized|拒绝访问|权限|SecurityException/i.test(msg)) {
      return new CoreError('system-need-admin', `系统环境变量${action}需要管理员权限:请以管理员身份重新运行 DevKit 后重试`, { cause: msg });
    }
    return e;
  }

  /** writeBackup 落盘命名:<ISO 时间戳 :.全替->.json(形如 2026-09-08T06-31-12-345Z.json) */
  private static readonly BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

  /**
   * ★ S3(2026-09-09 安全审查):回滚只许消费"本服务写出的标准备份"——
   * 绝对路径的父目录必须恰为 backupDir(嵌套子目录亦拒),且文件名匹配 writeBackup 命名。
   */
  isBackupFile(file: string): boolean {
    if (typeof file !== 'string' || file.length === 0) return false;
    const abs = path.resolve(file);
    if (path.dirname(abs).toLowerCase() !== path.resolve(this.backupDir).toLowerCase()) return false;
    return EnvService.BACKUP_NAME_RE.test(path.basename(abs));
  }

  /**
   * 从备份文件回滚(历史页 [回滚] 的后端;入口收口见 isBackupFile —— 任意文件路径一律拒)。
   * ★F3:按快照自带作用域回滚到对应 hive;系统级快照回滚同样要先过开关闸门。
   */
  async restoreBackup(file: string): Promise<EnvApplyResult> {
    if (!this.isBackupFile(file)) {
      throw new CoreError('env-backup-path', `回滚只接受 ${this.backupDir} 下的标准备份文件:${file}`);
    }
    const bk = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvBackup;
    if (!Array.isArray(bk?.rows)) throw new CoreError('env-backup-invalid', `备份文件不合法:${file}`);
    const scope = scopeOfBackup(bk);
    if (scope === 'system') this.assertSystemWritable();
    const names = await this.restoreTo(bk.rows, scope);
    return { changed: names, backupFile: null, broadcast: 'ok' };
  }

  listBackups(): { file: string; ts: string; names: string[]; scope: EnvScope }[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        const full = path.join(this.backupDir, f);
        try {
          const bk = JSON.parse(fs.readFileSync(full, 'utf8')) as EnvBackup;
          return { file: full, ts: bk.ts, names: bk.rows.map((r) => r.name), scope: scopeOfBackup(bk) };
        } catch {
          return { file: full, ts: f, names: [], scope: 'user' as const }; // 坏备份也列出(标坏),由 UI 决定展示
        }
      });
  }

  /**
   * 全量同步到目标行集:多余的删、缺失/漂移的写回原类型(按 scope 选 hive)。
   * ★F3 系统级特有保护:回滚【永不删除】Windows 内置变量 —— 即便备份里恰好缺了 SystemRoot,
   * 也绝不把它从系统里抹掉(比"忠实回滚"更重要的一条)。
   */
  private async restoreTo(target: EnvVar[], scope: EnvScope = 'user'): Promise<string[]> {
    const current = scope === 'system' ? await this.readSystemVars() : await this.readAll();
    const keyArg = scope === 'system' ? '' : ` -Key ${psLiteral(this.regKey)}`;
    const setFn = scope === 'system' ? 'Set-SystemEnv' : 'Set-Env';
    const rmFn = scope === 'system' ? 'Remove-SystemEnv' : 'Remove-Env';
    const calls: string[] = [];
    const touched: string[] = [];
    for (const c of current) {
      if (target.some((t) => t.name.toLowerCase() === c.name.toLowerCase())) continue;
      if (scope === 'system' && isProtectedSystemVar(c.name)) continue; // 红线的兜底:内置变量只增不减
      calls.push(`${rmFn}${keyArg} -Name ${psLiteral(c.name)}`);
      touched.push(c.name);
    }
    for (const t of target) {
      const kind = t.kind === 'String' || t.kind === 'ExpandString' ? t.kind : null;
      if (kind === null) throw new CoreError('env-restore-kind', `备份含不支持的值类型 ${t.kind}:${t.name}`);
      const cur = current.find((c) => c.name.toLowerCase() === t.name.toLowerCase());
      if (!cur || cur.value !== t.value || cur.kind !== t.kind) {
        calls.push(`${setFn}${keyArg} -Name ${psLiteral(t.name)} -Value ${psLiteral(t.value)} -Kind ${kind}`);
        touched.push(t.name);
      }
    }
    if (calls.length === 0) return [];
    calls.push('Publish-EnvChange');
    try {
      await this.runPowerShell(calls);
    } catch (e) {
      throw scope === 'system' ? this.asSystemError(e, '回滚') : e;
    }
    return touched;
  }

  /** ①全量快照:userData\env_backups\<ts>.json;保留最近 20 份(产品文档 §6) */
  private writeBackup(rows: EnvVar[], scope: EnvScope = 'user'): string {
    const ts = new Date().toISOString();
    fs.mkdirSync(this.backupDir, { recursive: true });
    const file = path.join(this.backupDir, `${ts.replace(/[:.]/g, '-')}.json`);
    const bk: EnvBackup = { ts, regKey: scope === 'system' ? SYSTEM_REG_KEY : this.regKey, scope, rows };
    fs.writeFileSync(file, JSON.stringify(bk, null, 2), 'utf8');
    const olds = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort();
    while (olds.length > 20) {
      const victim = olds.shift()!;
      fs.rmSync(path.join(this.backupDir, victim));
    }
    return file;
  }
}
