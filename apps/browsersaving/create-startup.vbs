Set ws = CreateObject("WScript.Shell")
Set sc = ws.CreateShortcut(ws.SpecialFolders("Startup") & "\BrowserSaving.lnk")
sc.TargetPath = "C:\BrowserSaving\BrowserSaving.exe"
sc.WorkingDirectory = "C:\BrowserSaving"
sc.Description = "BrowserSaving Tray"
sc.Save
WScript.Echo "Startup shortcut created"
