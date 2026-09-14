# resources/env.ps1 —— DevKit 用户级环境变量操作(技术手册 §7.1)
#
# 调用协议:Node 侧 execFile('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand', b64]),
#   本文件内容与调用语句拼成一条命令后整体 UTF-16LE 编码 —— 参数不走命令行引号,杜绝注入。
# 铁律:
#   1) 禁用 setx(PATH 超 1024 字符截断,一票否决);
#   2) 一切写入经 .NET SetValue 显式指定 RegistryValueKind,防 %VAR% 被打平;
#   3) 读取一律 DoNotExpandEnvironmentNames,保留原始值(备份/回滚保真)。
# 键名可注入(-Key):自动化与自检只允许 Environment_DevKitTest,测完全删(§11)。

function Get-Env {
  [CmdletBinding()]
  param([string]$Key = 'Environment')
  $sub = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  if ($null -eq $sub) { return '[]' }
  $rows = @()
  foreach ($name in $sub.GetValueNames()) {
    if ($name -eq '') { continue }
    $raw = $sub.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [string]$sub.GetValueKind($name)
    if ($raw -is [array]) { $raw = $raw -join ';' }  # HKCU\Environment 基本不会出现多字符串,兜底
    $rows += [pscustomobject]@{ name = $name; kind = $kind; value = [string]$raw }
  }
  $sub.Close()
  return (ConvertTo-Json -InputObject @($rows) -Compress)
}

function Get-SystemPath {
  # 只读:M3 §4.4 体检的"系统 PATH"区。红线 §3.1 —— 本文件一切写口都钉死 CurrentUser,
  # HKLM 仅开读句柄;DoNotExpandEnvironmentNames 保 %SystemRoot% 等原样,展示层自决展开。
  $sub = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
  if ($null -eq $sub) { return '{}' }
  $raw = $sub.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $raw) { $sub.Close(); return '{}' }
  $kind = [string]$sub.GetValueKind('Path')
  $sub.Close()
  return (ConvertTo-Json -InputObject ([pscustomobject]@{ name = 'Path'; kind = $kind; value = [string]$raw }) -Compress)
}

function Set-Env {
  [CmdletBinding()]
  param(
    [string]$Key = 'Environment',
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Value = '',
    [ValidateSet('String', 'ExpandString')][string]$Kind = 'ExpandString'
  )
  $vk = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $Kind)
  $sub = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Key)
  try { $sub.SetValue($Name, $Value, $vk) } finally { $sub.Close() }
  return 'OK'
}

function Remove-Env {
  [CmdletBinding()]
  param([string]$Key = 'Environment', [Parameter(Mandatory = $true)][string]$Name)
  $sub = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key, $true)
  if ($null -ne $sub) {
    try {
      if ($sub.GetValueNames() -contains $Name) { $sub.DeleteValue($Name) }
    } finally { $sub.Close() }
  }
  return 'OK'
}

function Publish-EnvChange {
  # WM_SETTINGCHANGE "Environment" 广播(§7.1):内联 P/Invoke,免原生依赖
  if (-not ('DevKitWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DevKitWin {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
'@
  }
  $result = [IntPtr]::Zero
  # HWND_BROADCAST=0xFFFF, WM_SETTINGCHANGE=0x1A, SMTO_ABORTIFHUNG=0x2
  $ret = [DevKitWin]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [IntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$result)
  if ($ret -eq [IntPtr]::Zero) { return 'BROADCAST_TIMEOUT' } else { return 'BROADCAST_OK' }
}

# ---------------------------------------------------------------- ★ F3(2026-09-14)系统级(HKLM)
# 分工:保护名单(Windows 内置变量)、开关闸门(默认关)、快照与回滚全部在 core/env.ts ——
# 本层只负责"按正确类型读/写/删",以及"无管理员权限时老老实实报错"。
# 铁律不变:一切写入经 .NET SetValue 显式指定 RegistryValueKind,防 %VAR% 被打平。

function Get-SystemEnv {
  # 全量读取系统环境变量(读不需要管理员:只开只读句柄)。
  $sub = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
  if ($null -eq $sub) { return '[]' }
  $rows = @()
  foreach ($name in $sub.GetValueNames()) {
    if ($name -eq '') { continue }
    $raw = $sub.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [string]$sub.GetValueKind($name)
    if ($raw -is [array]) { $raw = $raw -join ';' }
    $rows += [pscustomobject]@{ name = $name; kind = $kind; value = [string]$raw }
  }
  $sub.Close()
  return (ConvertTo-Json -InputObject @($rows) -Compress)
}

function Set-SystemEnv {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Value = '',
    [ValidateSet('String', 'ExpandString')][string]$Kind = 'ExpandString'
  )
  $vk = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $Kind)
  # 无管理员权限时 CreateSubKey 抛 UnauthorizedAccessException → 由 core 归一为 system-need-admin
  $sub = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
  try { $sub.SetValue($Name, $Value, $vk) } finally { $sub.Close() }
  return 'OK'
}

function Remove-SystemEnv {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Name)
  $sub = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
  if ($null -ne $sub) {
    try {
      if ($sub.GetValueNames() -contains $Name) { $sub.DeleteValue($Name) }
    } finally { $sub.Close() }
  }
  return 'OK'
}

function Get-Elevated {
  # 当前进程是否管理员:写 HKLM 的前置条件,UI 事先讲清楚,别让用户点完才报错。
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return 'ELEVATED_YES' }
  } catch { }
  return 'ELEVATED_NO'
}
