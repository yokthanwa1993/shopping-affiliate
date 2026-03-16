$ErrorActionPreference = "Stop"

$accounts = @("chearb", "neezs", "golf", "first")
foreach ($account in $accounts) {
  $taskName = "Shortlink-$account"
  schtasks /Run /TN $taskName | Out-Null
  Start-Sleep -Seconds 2
  Write-Output "Triggered $taskName"
}
