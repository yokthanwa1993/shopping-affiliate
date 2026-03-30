$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$stdoutLogPath = Join-Path $projectRoot "server.log"
$stderrLogPath = Join-Path $projectRoot "server.err.log"
$python = (Get-Command python -ErrorAction Stop).Source

$launchChromeScript = Join-Path $projectRoot "launch-chrome-cdp.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launchChromeScript

$env:PREWARM_BROWSER = "0"
$env:BROWSER_SESSION = "shortlink"
$env:CDP_URL = "http://127.0.0.1:9222"
Set-Location $projectRoot

Start-Process `
  -FilePath $python `
  -ArgumentList "server.py" `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutLogPath `
  -RedirectStandardError $stderrLogPath `
  -Wait
