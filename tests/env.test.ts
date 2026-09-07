import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { EnvService, SANDBOX_REG_KEY, encodePowerShellCommand, psLiteral, type EnvApplyResult, type EnvVar, type ExecFileFn } from '../src/main/core/env';
import { envPlan } from '../src/main/core/paths';

const FAKE_PS = '# fake env.ps1 for mock tests\n';

interface DecodedCall {
  args: readonly string[];
  /** EncodedCommand 解码出的完整脚本(fake ps 头 + 调用行) */
  script: string;
  /** 调用行(去掉注入的 ps 头) */
  calls: string;
}

/** mock execFile:responder 决定 stdout 或抛错;记录全部解码调用 */
function mockExec(responder: (calls: string, n: number) => string) {
  const calls: DecodedCall[] = [];
  const fn: ExecFileFn = async (_cmd, args) => {
    const b64 = args[3]!;
    const script = Buffer.from(b64, 'base64').toString('utf16le');
    const rest = script.startsWith(FAKE_PS) ? script.slice(FAKE_PS.length) : script;
    calls.push({ args, script, calls: rest });
    return { stdout: responder(rest, calls.length) }; // responder 内可直接 throw 模拟进程失败
  };
  return { calls, fn };
}

function svcWith(fn: ExecFileFn, userDataDir: string, regKey?: string): EnvService {
  return new EnvService({ userDataDir, execFile: fn, psScript: FAKE_PS, regKey });
}

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-env-'));
});

const readRows = (rows: EnvVar[]) => JSON.stringify(rows); // Get-Env 的 stdout 形状
const PLAN = envPlan('D:\\dev');

describe('EncodedCommand 协议(§7.1)', () => {
  it('参数形态固定,脚本整体 UTF-16LE 编码', async () => {
    const { calls, fn } = mockExec(() => readRows([]));
    await svcWith(fn, userData).readAll();
    expect(calls.length).toBe(1);
    // execFile(cmd, args):args 固定为 -NoProfile -NonInteractive -EncodedCommand <b64>
    expect([...calls[0]!.args].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(typeof calls[0]!.args[3]).toBe('string');
    expect(calls[0]!.script).toContain('# fake env.ps1');
    expect(calls[0]!.calls.trim()).toBe(`Get-Env -Key 'Environment'`);
  });
  it('引号逃逸与编码往返', () => {
    expect(psLiteral("a'b")).toBe("'a''b'");
    const enc = encodePowerShellCommand("测试'quote'");
    expect(Buffer.from(enc, 'base64').toString('utf16le')).toBe("测试'quote'");
  });
});

describe('applyPlan 写入协议(§7.2 四步)', () => {
  it('首次接入:快照→合并 Path(ExpandString)→JAVA_HOME→广播', async () => {
    const { calls, fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([{ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows' }]) : 'OK\nBROADCAST_OK'));
    const svc = svcWith(fn, userData);
    const r = await svc.applyPlan(PLAN);
    expect(r).toEqual({ changed: ['Path', 'JAVA_HOME'], backupFile: expect.any(String) as unknown as string, broadcast: 'ok' });
    const write = calls[1]!.calls;
    expect(write).toContain(`Set-Env -Key 'Environment' -Name 'Path' -Value 'C:\\Windows;D:\\dev\\current\\node;D:\\dev\\current\\maven\\bin;%JAVA_HOME%\\bin' -Kind ExpandString`);
    expect(write).toContain(`-Name 'JAVA_HOME' -Value 'D:\\dev\\current\\jdk' -Kind ExpandString`);
    expect(write).toContain('Publish-EnvChange');
    // ①快照内容 = 写入前的原始行集
    const backup = JSON.parse(fs.readFileSync(r.backupFile!, 'utf8')) as { rows: EnvVar[] };
    expect(backup.rows).toEqual([{ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows' }]);
  });

  it('幂等:条目已在(大小写不同)→ 零写入零备份', async () => {
    const already = [
      { name: 'PATH', kind: 'ExpandString', value: 'C:\\Windows;D:\\DEV\\CURRENT\\NODE;D:\\dev\\current\\maven\\bin;%java_home%\\bin' },
      { name: 'java_home', kind: 'ExpandString', value: 'D:\\dev\\current\\jdk' },
    ];
    const { calls, fn } = mockExec(() => readRows(already));
    const r = await svcWith(fn, userData).applyPlan(PLAN);
    expect(r.changed).toEqual([]);
    expect(r.backupFile).toBeNull();
    expect(calls.length).toBe(1); // 只有 readAll
  });

  it('写入中途失败(PS 脚本半程崩溃)→ 用快照还原已变更项并 rethrow(§7.2④)', async () => {
    // 模拟部分应用:第一次执行中 Path 已写、JAVA_HOME 行崩溃 → 崩溃后读回能看到漂移的 Path
    const MERGED = 'C:\\Windows;D:\\dev\\current\\node;D:\\dev\\current\\maven\\bin;%JAVA_HOME%\\bin';
    let readN = 0;
    const { calls, fn } = mockExec((c) => {
      if (c.includes('Get-Env')) {
        readN++;
        return readN === 1
          ? readRows([{ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows' }]) // 写入前
          : readRows([{ name: 'Path', kind: 'ExpandString', value: MERGED }]); // Path 已漂移(部分应用)
      }
      if (c.includes("Name 'JAVA_HOME'")) throw new Error('powershell crashed');
      return 'OK\nBROADCAST_OK';
    });
    const svc = svcWith(fn, userData);
    await expect(svc.applyPlan(PLAN)).rejects.toThrowError(/crashed/);
    // 还原:末次执行把 Path 写回快照原值(JAVA_HOME 不在快照也不在现值 → 无需动作)
    const restore = calls.at(-1)!.calls;
    expect(restore).toContain(`-Name 'Path' -Value 'C:\\Windows' -Kind ExpandString`);
    expect(restore).not.toContain("JAVA_HOME");
    expect(fs.existsSync(svc.listBackups()[0]!.file)).toBe(true); // 快照留存(供历史页)
  });

  it('广播超时不算写入失败(记录但成功)', async () => {
    const { fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([]) : 'OK\nBROADCAST_TIMEOUT'));
    const r = await svcWith(fn, userData).applyPlan(PLAN);
    expect(r.broadcast).toBe('timeout');
    expect(r.changed).toEqual(['Path', 'JAVA_HOME']);
  });

  it('快照保留最近 20 份(产品文档 §6)', async () => {
    const dir = path.join(userData, 'env_backups');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-0${String(i).padStart(3, '0')}.json`), '{}');
    const { fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([]) : 'OK\nBROADCAST_OK'));
    const svc = svcWith(fn, userData);
    await svc.applyPlan(PLAN);
    expect(fs.readdirSync(dir).length).toBe(20);
  });
});

describe('restoreBackup', () => {
  it('删除多余项 + 写回漂移项,并广播', async () => {
    const target: EnvVar[] = [{ name: 'Path', kind: 'ExpandString', value: 'OLD' }];
    const file = path.join(userData, 'bk.json');
    fs.writeFileSync(file, JSON.stringify({ ts: 'x', regKey: 'Environment', rows: target }));
    const { calls, fn } = mockExec((c) =>
      c.includes('Get-Env') ? readRows([
        { name: 'Path', kind: 'ExpandString', value: 'NEW' },
        { name: 'GONE_SINCE', kind: 'String', value: 'z' },
      ]) : 'OK\nBROADCAST_OK',
    );
    const r: EnvApplyResult = await svcWith(fn, userData).restoreBackup(file);
    expect(r.changed.sort()).toEqual(['GONE_SINCE', 'Path']);
    const last = calls.at(-1)!.calls;
    expect(last).toContain(`Remove-Env -Key 'Environment' -Name 'GONE_SINCE'`);
    expect(last).toContain(`-Name 'Path' -Value 'OLD'`);
  });
});

// ---- 真机链路(§11:自动化全部打沙盒键,测完全删;真实 PATH 只允许手动走查) ----
describe.skipIf(process.platform !== 'win32')('EnvService 真机链路(HKCU:\\' + SANDBOX_REG_KEY + ')', () => {
  const execP = promisify(execFile);
  async function wipeSandbox(): Promise<void> {
    await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${SANDBOX_REG_KEY}', $false); exit 0`]);
  }

  it('写入→读回类型保真(%JAVA_HOME% 不被展开)→幂等→回滚→清沙盒', async () => {
    await wipeSandbox();
    const svc = new EnvService({ userDataDir: userData, regKey: SANDBOX_REG_KEY });
    try {
      expect(await svc.readAll()).toEqual([]); // 空沙盒起步
      const r1 = await svc.applyPlan(PLAN);
      expect(r1.changed.sort()).toEqual(['JAVA_HOME', 'Path']);
      const rows = await svc.readAll();
      const p = rows.find((x) => x.name.toLowerCase() === 'path')!;
      const j = rows.find((x) => x.name.toLowerCase() === 'java_home')!;
      expect(p.kind).toBe('ExpandString');
      expect(p.value).toBe(['D:\\dev\\current\\node', 'D:\\dev\\current\\maven\\bin', '%JAVA_HOME%\\bin'].join(';')); // 原样未展开
      expect(j.value).toBe('D:\\dev\\current\\jdk');
      expect(['ok', 'timeout']).toContain(r1.broadcast);

      const r2 = await svc.applyPlan(PLAN); // 幂等
      expect(r2.changed).toEqual([]);

      const r3 = await svc.restoreBackup(r1.backupFile!); // 回到"接入前"= 空
      expect(r3.changed.sort()).toEqual(['JAVA_HOME', 'Path']);
      expect(await svc.readAll()).toEqual([]);
    } finally {
      await wipeSandbox(); // §11:测完全删
      const sub = await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `if ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${SANDBOX_REG_KEY}')) {'GONE'} else {'HERE'}`]);
      expect(sub.stdout.trim()).toBe('GONE');
    }
  }, 120_000);
});
