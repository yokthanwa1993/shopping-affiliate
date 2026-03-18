# BrowserSaving System Tray App
# Runs PM2 services and shows icon in system tray

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Create icon (blue "B" letter)
$bmp = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::FromArgb(59, 130, 246))
$font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'
$sf.LineAlignment = 'Center'
$rect = New-Object System.Drawing.RectangleF(0, 0, 32, 32)
$g.DrawString('B', $font, [System.Drawing.Brushes]::White, $rect, $sf)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

# Create NotifyIcon
$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = $icon
$trayIcon.Text = 'BrowserSaving'
$trayIcon.Visible = $true

# Create context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Status header
$statusItem = $menu.Items.Add('BrowserSaving Services')
$statusItem.Enabled = $false
$statusItem.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# Open Dashboard
$openDash = $menu.Items.Add('🌐  Open Dashboard')
$openDash.Add_Click({
    Start-Process 'http://100.82.152.81:5173'
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# PM2 Status
$pmStatus = $menu.Items.Add('📊  Show Status')
$pmStatus.Add_Click({
    $status = & pm2 jlist 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($status) {
        $lines = @()
        foreach ($app in $status) {
            $name = $app.name
            $st = $app.pm2_env.status
            $uptime = ''
            if ($app.pm2_env.pm_uptime) {
                $up = [DateTimeOffset]::FromUnixTimeMilliseconds($app.pm2_env.pm_uptime).LocalDateTime
                $dur = (Get-Date) - $up
                $uptime = "$([int]$dur.TotalHours)h $($dur.Minutes)m"
            }
            $emoji = if ($st -eq 'online') { '✅' } else { '❌' }
            $lines += "$emoji $name - $st ($uptime)"
        }
        $msg = $lines -join "`n"
    } else {
        $msg = "Cannot get PM2 status"
    }
    [System.Windows.Forms.MessageBox]::Show($msg, 'BrowserSaving Status', 'OK', 'Information')
})

# Restart All
$restartAll = $menu.Items.Add('🔄  Restart All')
$restartAll.Add_Click({
    & pm2 restart all 2>$null
    $trayIcon.ShowBalloonTip(2000, 'BrowserSaving', 'All services restarted', [System.Windows.Forms.ToolTipIcon]::Info)
})

# Restart individual services
$restartSub = New-Object System.Windows.Forms.ToolStripMenuItem('🔧  Restart Individual')
$restartLauncher = $restartSub.DropDownItems.Add('Launcher Server')
$restartLauncher.Add_Click({ & pm2 restart launcher 2>$null; $trayIcon.ShowBalloonTip(1500, 'BrowserSaving', 'Launcher restarted', 'Info') })
$restartToken = $restartSub.DropDownItems.Add('Token Service')
$restartToken.Add_Click({ & pm2 restart token-service 2>$null; $trayIcon.ShowBalloonTip(1500, 'BrowserSaving', 'Token Service restarted', 'Info') })
$restartVite = $restartSub.DropDownItems.Add('Vite Dev Server')
$restartVite.Add_Click({ & pm2 restart vite-dev 2>$null; $trayIcon.ShowBalloonTip(1500, 'BrowserSaving', 'Vite restarted', 'Info') })
$menu.Items.Add($restartSub)

# View Logs
$viewLogs = $menu.Items.Add('📋  View Logs')
$viewLogs.Add_Click({
    Start-Process cmd -ArgumentList '/k', 'pm2 logs --lines 50'
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# Exit
$exitItem = $menu.Items.Add('❌  Exit Tray (services keep running)')
$exitItem.Add_Click({
    $trayIcon.Visible = $false
    $trayIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$trayIcon.ContextMenuStrip = $menu

# Double-click opens dashboard
$trayIcon.Add_DoubleClick({
    Start-Process 'http://100.82.152.81:5173'
})

# Ensure PM2 services are running on start
$pm2Check = & pm2 jlist 2>$null
if (-not $pm2Check -or $pm2Check -eq '[]') {
    Set-Location 'C:\BrowserSaving'
    & pm2 start ecosystem.config.js 2>$null
    & pm2 save 2>$null
}

# Show balloon on start
$trayIcon.ShowBalloonTip(3000, 'BrowserSaving', 'Services running in background', [System.Windows.Forms.ToolTipIcon]::Info)

# Run message loop
[System.Windows.Forms.Application]::Run()
