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

describe('applyRemoval(§4.4 清理:§7.2 四步应用于删除方向)', () => {
  const RAW = 'C:\\Windows;D:\\junk\\x;D:\\dev\\current\\node;%JAVA_HOME%\\bin';

  it('快照→等值删除→写 ExpandString→广播;快照=删除前原值', async () => {
    const { calls, fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([{ name: 'Path', kind: 'ExpandString', value: RAW }]) : 'OK\nBROADCAST_OK'));
    const svc = svcWith(fn, userData);
    const r = await svc.applyRemoval(['D:\\junk\\x']);
    expect(r).toEqual({ changed: ['Path'], removed: ['D:\\junk\\x'], backupFile: expect.any(String), broadcast: 'ok' });
    const write = calls[1]!.calls;
    expect(write).toContain(`Set-Env -Key 'Environment' -Name 'Path' -Value 'C:\\Windows;D:\\dev\\current\\node;%JAVA_HOME%\\bin' -Kind ExpandString`);
    expect(write).toContain('Publish-EnvChange');
    const backup = JSON.parse(fs.readFileSync(r.backupFile!, 'utf8')) as { rows: EnvVar[] };
    expect(backup.rows[0]!.value).toBe(RAW); // %JAVA_HOME% 在快照里不被打平
  });

  it('删除仅等值命中(大小写/尾分隔符容错),绝不模糊匹配(红线 §3.3)', async () => {
    const { fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([{ name: 'Path', kind: 'ExpandString', value: 'C:\\WINDOWS\\;D:\\WINDOWS\\System32' }]) : 'OK'));
    const r = await svcWith(fn, userData).applyRemoval(['c:\\windows']);
    expect(r.removed).toEqual(['C:\\WINDOWS\\']); // 等值(忽略大小写+尾\)命中
  });

  it('无命中 → 零写入零备份(noop)', async () => {
    const { calls, fn } = mockExec(() => readRows([{ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows' }]));
    const r = await svcWith(fn, userData).applyRemoval(['D:\\absent']);
    expect(r).toEqual({ changed: [], removed: [], backupFile: null, broadcast: null });
    expect(calls.length).toBe(1); // 只有 readAll
  });

  it('写入失败 → 用快照还原并 rethrow(§7.2④)', async () => {
    const MERGED = 'C:\\Windows;D:\\dev\\current\\node;%JAVA_HOME%\\bin'; // 删后形态(模拟"写已落半程再炸")
    let reads = 0;
    let writes = 0;
    const { calls, fn } = mockExec((c) => {
      if (c.includes('Get-Env')) {
        reads++;
        return readRows([{ name: 'Path', kind: 'ExpandString', value: reads === 1 ? RAW : MERGED }]);
      }
      writes++;
      if (writes === 1) throw new Error('registry write boom'); // 删除写入崩
      return 'OK\nBROADCAST_OK'; // 还原写成功
    });
    const svc = svcWith(fn, userData);
    await expect(svc.applyRemoval(['D:\\junk\\x'])).rejects.toThrowError(/boom/);
    expect(calls.at(-1)!.calls).toContain(`-Value '${RAW}' -Kind ExpandString`); // 还原为快照原值
  });
});

describe('readSystemPath(只读 HKLM,§4.4 系统条目区)', () => {
  it('调用 Get-SystemPath 并解析 JSON value', async () => {
    const { calls, fn } = mockExec(() => JSON.stringify({ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows\\system32;%SystemRoot%\\x' }));
    expect(await svcWith(fn, userData).readSystemPath()).toBe('C:\\Windows\\system32;%SystemRoot%\\x');
    expect(calls[0]!.calls.trim()).toBe('Get-SystemPath');
  });
  it('空返回/无 value/进程失败 → null 降级(不阻塞用户 PATH 体检)', async () => {
    expect(await svcWith(mockExec(() => '{}').fn, userData).readSystemPath()).toBeNull();
    expect(await svcWith(mockExec(() => 'nope').fn, userData).readSystemPath()).toBeNull();
    expect(await svcWith(mockExec(() => { throw new Error('denied'); }).fn, userData).readSystemPath()).toBeNull();
  });
});

describe('restoreBackup', () => {
  /** S3 闸口后的合法备份:恰在 env_backups 下 + writeBackup 命名格式 */
  const legalBackupPath = (userData: string, name = '2026-01-02T03-04-05-678Z.json'): string => {
    const file = path.join(userData, 'env_backups', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };

  it('删除多余项 + 写回漂移项,并广播', async () => {
    const target: EnvVar[] = [{ name: 'Path', kind: 'ExpandString', value: 'OLD' }];
    const file = legalBackupPath(userData);
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

  it('S3 闸口:目录外 / 伪造名 / backupDir 嵌套子目录 → env-backup-path 拒绝,零执行', async () => {
    const { calls, fn } = mockExec(() => readRows([]));
    const svc = svcWith(fn, userData);
    const payload = JSON.stringify({ ts: 't', regKey: 'Environment', rows: [] as EnvVar[] });
    const outside = path.join(userData, '2026-01-02T03-04-05-678Z.json'); // 名合法,目录不对
    fs.writeFileSync(outside, payload);
    await expect(svc.restoreBackup(outside)).rejects.toThrowError(/回滚只接受/);
    const forged = legalBackupPath(userData, 'innocent.json'); // 目录对,名不符 writeBackup 命名
    fs.writeFileSync(forged, payload);
    await expect(svc.restoreBackup(forged)).rejects.toThrowError(/回滚只接受/);
    const nested = path.join(userData, 'env_backups', 'sub', '2026-01-02T03-04-05-678Z.json'); // 嵌套也算越界
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, payload);
    await expect(svc.restoreBackup(nested)).rejects.toThrowError(/回滚只接受/);
    expect(calls.length).toBe(0); // 三次全部挡在入口,未触 PowerShell
  });

  it('S3 正路:applyPlan 写出的快照命名与闸口同源,可直接回滚', async () => {
    const { fn } = mockExec((c) => (c.includes('Get-Env') ? readRows([{ name: 'Path', kind: 'ExpandString', value: 'C:\\Windows' }]) : 'OK\nBROADCAST_OK'));
    const svc = svcWith(fn, userData);
    const r = await svc.applyPlan(PLAN);
    expect(svc.isBackupFile(r.backupFile!)).toBe(true);
    const rr = await svc.restoreBackup(r.backupFile!); // 现值=快照 → 零变更,但不抛 = 放行
    expect(rr.changed).toEqual([]);
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

      // M3 §4.4 清理真机:精确删一条,其余原样(%JAVA_HOME% 不被打平),备份可回滚
      const r4 = await svc.applyRemoval(['D:\\dev\\current\\node']);
      expect(r4.removed).toEqual(['D:\\dev\\current\\node']);
      const after = await svc.readAll();
      expect(after.find((x) => x.name.toLowerCase() === 'path')!.value).toBe('D:\\dev\\current\\maven\\bin;%JAVA_HOME%\\bin');
      await svc.restoreBackup(r4.backupFile!); // 撤销清理
      expect((await svc.readAll()).find((x) => x.name.toLowerCase() === 'path')!.value)
        .toBe(['D:\\dev\\current\\node', 'D:\\dev\\current\\maven\\bin', '%JAVA_HOME%\\bin'].join(';'));

      // 系统 PATH 只读探测(真机,零写入;本机必有值)
      const sys = await svc.readSystemPath();
      expect(sys).toBeTruthy();
      expect(sys!.toLowerCase()).toContain('system32');

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
