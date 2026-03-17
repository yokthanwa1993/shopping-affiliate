param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("chearb", "neezs", "golf", "first")]
  [string]$Account
)

$ErrorActionPreference = "Stop"

$root = "C:\shortlink-native"
$appDir = Join-Path $root "electron-runtime"
$dataRoot = Join-Path $root "data"
$logRoot = Join-Path $root "logs"
$electronExe = Join-Path $appDir "node_modules\electron\dist\electron.exe"
$electronCmd = Join-Path $appDir "node_modules\.bin\electron.cmd"
$sharedWorkerBase = "https://shortlink.yokthanwa1993-bc9.workers.dev"

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$configs = @{
  chearb = @{
    HttpPort = "3000"
    WorkerAccount = "chearb"
    DisplayName = "CHEARB"
    AppName = "CHEARB"
    LocalhostLabel = "Open localhost:3000"
    Email = "affiliate@chearb.com"
    Password = ""
  }
  neezs = @{
    HttpPort = "3001"
    WorkerAccount = "neezs"
    DisplayName = "NEEZS"
    AppName = "NEEZS"
    LocalhostLabel = "Open localhost:3001"
    Email = "affiliate@neezs.com"
    Password = ""
  }
  golf = @{
    HttpPort = "3002"
    WorkerAccount = "golf"
    DisplayName = "GOLF"
    AppName = "GOLF"
    LocalhostLabel = "Open localhost:3002"
    Email = ""
    Password = ""
  }
  first = @{
    HttpPort = "3003"
    WorkerAccount = "first"
    DisplayName = "FIRST"
    AppName = "FIRST"
    LocalhostLabel = "Open localhost:3003"
    Email = ""
    Password = ""
  }
}

$config = $configs[$Account]
$workerAccount = $config.WorkerAccount
$workerUrl = "$sharedWorkerBase/?account=$workerAccount"
$userDataDir = Join-Path $dataRoot $Account
$stdoutLog = Join-Path $logRoot "$Account-out.log"
$stderrLog = Join-Path $logRoot "$Account-err.log"

if (Test-Path $electronExe) {
  $electronBinary = $electronExe
} elseif (Test-Path $electronCmd) {
  $electronBinary = $electronCmd
} else {
  throw "Missing Electron runtime at $electronExe"
}

$env:SHORTLINK_ACCOUNT_KEY = $Account
$env:SHORTLINK_MAIN = "main.js"
$env:SHORTLINK_HTTP_PORT = $config.HttpPort
$env:SHORTLINK_WORKER_URL = $workerUrl
$env:SHORTLINK_DISPLAY_NAME = $config.DisplayName
$env:SHORTLINK_APP_NAME = $config.AppName
$env:SHORTLINK_LOCALHOST_LABEL = $config.LocalhostLabel
$env:SHORTLINK_ACCOUNT_EMAIL = $config.Email
$env:SHORTLINK_ACCOUNT_PASSWORD = $config.Password
$env:SHORTLINK_VNC_CHEARB = ""
$env:SHORTLINK_VNC_NEEZS = ""
$env:SHORTLINK_VNC_GOLF = ""
$env:SHORTLINK_VNC_FIRST = ""

New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null

$arguments = @(
  (Join-Path $appDir "main.js")
  "--user-data-dir=$userDataDir"
)

$process = Start-Process `
  -FilePath $electronBinary `
  -ArgumentList $arguments `
  -WorkingDirectory $appDir `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Write-Output "Started $Account pid=$($process.Id) port=$($config.HttpPort)"
