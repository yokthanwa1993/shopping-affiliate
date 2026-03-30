$ErrorActionPreference = "Stop"

$port = 9222
$startUrls = @(
  "https://www.lazada.co.th/",
  "https://adsense.lazada.co.th/index.htm#/"
)
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
$automationUserDataDir = Join-Path $projectRoot "chrome-cdp-user-data"

function Test-CdpReady {
  param([int]$Port)

  try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/json/version"
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Path $chrome)) {
  throw "Chrome not found at $chrome"
}

New-Item -ItemType Directory -Force -Path $automationUserDataDir | Out-Null

if (-not (Test-CdpReady -Port $port)) {
  $args = @(
    "--remote-debugging-port=$port",
    "--profile-directory=Default",
    "--user-data-dir=$automationUserDataDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window"
  )
  $args += $startUrls

  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
}

for ($i = 0; $i -lt 20; $i++) {
  if (Test-CdpReady -Port $port) {
    Write-Output "CDP ready on 127.0.0.1:$port"
    exit 0
  }
  Start-Sleep -Seconds 1
}

throw "Chrome CDP endpoint did not start on port $port"
