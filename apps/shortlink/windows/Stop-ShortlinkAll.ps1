$ErrorActionPreference = "SilentlyContinue"

$ports = 3000, 3001, 3002, 3003

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match "electron" -or
    $_.CommandLine -match "shortlink-native" -or
    $_.CommandLine -match "main-neezs.js" -or
    $_.CommandLine -match "main.js"
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force
    } catch {}
  }

foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    try {
      Stop-Process -Id $connection.OwningProcess -Force
    } catch {}
  }
}

Write-Output "Stopped shortlink Electron processes"
