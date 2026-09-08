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

export interface EnvBackup {
  ts: string;
  regKey: string;
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

  /** 从备份文件回滚(历史页 [回滚] 的后端;M3 接 UI) */
  async restoreBackup(file: string): Promise<EnvApplyResult> {
    const bk = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvBackup;
    if (!Array.isArray(bk?.rows)) throw new CoreError('env-backup-invalid', `备份文件不合法:${file}`);
    const names = await this.restoreTo(bk.rows);
    return { changed: names, backupFile: null, broadcast: 'ok' };
  }

  listBackups(): { file: string; ts: string; names: string[] }[] {
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
          return { file: full, ts: bk.ts, names: bk.rows.map((r) => r.name) };
        } catch {
          return { file: full, ts: f, names: [] }; // 坏备份也列出(标坏),由 UI 决定展示
        }
      });
  }

  /** 全量同步到目标行集:多余的删、缺失/漂移的写回原类型 */
  private async restoreTo(target: EnvVar[]): Promise<string[]> {
    const current = await this.readAll();
    const calls: string[] = [];
    const touched: string[] = [];
    for (const c of current) {
      if (!target.some((t) => t.name.toLowerCase() === c.name.toLowerCase())) {
        calls.push(`Remove-Env -Key ${psLiteral(this.regKey)} -Name ${psLiteral(c.name)}`);
        touched.push(c.name);
      }
    }
    for (const t of target) {
      const kind = t.kind === 'String' || t.kind === 'ExpandString' ? t.kind : null;
      if (kind === null) throw new CoreError('env-restore-kind', `备份含不支持的值类型 ${t.kind}:${t.name}`);
      const cur = current.find((c) => c.name.toLowerCase() === t.name.toLowerCase());
      if (!cur || cur.value !== t.value || cur.kind !== t.kind) {
        calls.push(`Set-Env -Key ${psLiteral(this.regKey)} -Name ${psLiteral(t.name)} -Value ${psLiteral(t.value)} -Kind ${kind}`);
        touched.push(t.name);
      }
    }
    if (calls.length === 0) return [];
    calls.push('Publish-EnvChange');
    await this.runPowerShell(calls);
    return touched;
  }

  /** ①全量快照:userData\env_backups\<ts>.json;保留最近 20 份(产品文档 §6) */
  private writeBackup(rows: EnvVar[]): string {
    const ts = new Date().toISOString();
    fs.mkdirSync(this.backupDir, { recursive: true });
    const file = path.join(this.backupDir, `${ts.replace(/[:.]/g, '-')}.json`);
    const bk: EnvBackup = { ts, regKey: this.regKey, rows };
    fs.writeFileSync(file, JSON.stringify(bk, null, 2), 'utf8');
    const olds = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort();
    while (olds.length > 20) {
      const victim = olds.shift()!;
      fs.rmSync(path.join(this.backupDir, victim));
    }
    return file;
  }
}
