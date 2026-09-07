# scripts/env-selftest.ps1 —— 注册表/广播链路真机自检(技术手册 §11 env 真机链路)
#
# 只操作沙盒键 HKCU:\Environment_DevKitTest,测完全删;绝不触碰真实 Path/JAVA_HOME。
# 验收点:①写入类型保真(REG_EXPAND_SZ 不被打平) ②读回=原始值 ③广播链路返回 BROADCAST_OK
#        ④删除幂等 ⑤沙盒键清理干净。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/env-selftest.ps1
$ErrorActionPreference = 'Stop'
$SANDBOX = 'Environment_DevKitTest'
$failures = @()

function Assert([bool]$cond, [string]$what) {
  if ($cond) { Write-Host "  ✓ $what" }
  else { $script:failures += $what; Write-Host "  ✗ $what" -ForegroundColor Red }
}

. (Join-Path $PSScriptRoot '..\resources\env.ps1')

Write-Host "== DevKit env 真机自检(沙盒键 $SANDBOX) =="
try {
  # —— 0. 起点清理
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SANDBOX, $false)

  # —— 1. 写入含未展开引用的 ExpandString,读回必须保真
  $probePath = 'D:\dev\current\maven\bin;%DevKitProbe%\bin;C:\Windows'
  Set-Env -Key $SANDBOX -Name 'Path' -Value $probePath -Kind ExpandString | Out-Null
  $rows = Get-Env -Key $SANDBOX | ConvertFrom-Json
  $row = @($rows | Where-Object { $_.name -eq 'Path' })[0]
  Assert ($null -ne $row) 'Get-Env 能读回刚写入的 Path'
  Assert ($row.value -eq $probePath) '读回值 == 写入值(%DevKitProbe% 未被系统展开)'
  Assert ($row.kind -eq 'ExpandString') '值类型为 REG_EXPAND_SZ(§7.1 显式 -Type 的成效)'

  # —— 2. 覆盖写不产生重复/类型漂移
  $probePath2 = "%DevKitProbe%\x;$probePath"
  Set-Env -Key $SANDBOX -Name 'Path' -Value $probePath2 -Kind ExpandString | Out-Null
  $rows = Get-Env -Key $SANDBOX | ConvertFrom-Json
  $row = @($rows | Where-Object { $_.name -eq 'Path' })[0]
  Assert ($row.value -eq $probePath2) '覆盖写生效且仅一条 Path'

  # —— 3. String 与 ExpandString 双类型共存(模拟 JAVA_HOME=String 场景)
  Set-Env -Key $SANDBOX -Name 'JAVA_HOME' -Value 'D:\dev\current\jdk' -Kind String | Out-Null
  $rows = Get-Env -Key $SANDBOX | ConvertFrom-Json
  $jh = @($rows | Where-Object { $_.name -eq 'JAVA_HOME' })[0]
  Assert ($jh.kind -eq 'String' -and $jh.value -eq 'D:\dev\current\jdk') 'String 类型写入读回一致'
  $pathRow = @($rows | Where-Object { $_.name -eq 'Path' })[0]
  Assert ($pathRow.kind -eq 'ExpandString') '同键并存类型互不串改'

  # —— 4. 广播链路
  $b = Publish-EnvChange
  Assert ($b -eq 'BROADCAST_OK') "SendMessageTimeoutW 广播返回 $b"

  # —— 5. 删除与幂等
  Remove-Env -Key $SANDBOX -Name 'JAVA_HOME' | Out-Null
  Remove-Env -Key $SANDBOX -Name 'JAVA_HOME' | Out-Null   # 二次删除不炸
  $rows = Get-Env -Key $SANDBOX | ConvertFrom-Json
  Assert (@($rows | Where-Object { $_.name -eq 'JAVA_HOME' }).Count -eq 0) 'Remove-Env 幂等删除'

  # —— 6. 中文/特殊字符值往返(编码链路无损)
  Set-Env -Key $SANDBOX -Name 'Note' -Value '带空格 与中文 & "引号" %未展开%' -Kind String | Out-Null
  $rows = Get-Env -Key $SANDBOX | ConvertFrom-Json
  $note = @($rows | Where-Object { $_.name -eq 'Note' })[0]
  Assert ($note.value -eq '带空格 与中文 & "引号" %未展开%') '特殊字符/中文值 JSON 往返无损'
}
catch {
  $failures += "脚本异常:$_"
  Write-Host "  ✗ 异常:$_" -ForegroundColor Red
}
finally {
  # —— 7. 沙盒键全删(§11:测完全删)
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SANDBOX, $false)
  $gone = $null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SANDBOX)
  Assert $gone '沙盒键已彻底删除'
}

if ($failures.Count -gt 0) {
  Write-Host "== 自检失败 $($failures.Count) 项 ==" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host '== env 真机自检全部通过 =='
exit 0
