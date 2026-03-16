$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$starter = Join-Path $scriptDir "Start-ShortlinkInstance.ps1"
$accounts = @("chearb", "neezs", "golf", "first")
$taskPassword = "7EvaYLj986"

foreach ($account in $accounts) {
  $taskName = "Shortlink-$account"
  $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$starter`" -Account $account"
  schtasks /Create /TN $taskName /SC ONLOGON /RU Administrator /RP $taskPassword /IT /RL HIGHEST /TR $taskCommand /F | Out-Null
  Write-Output "Installed task $taskName"
}
