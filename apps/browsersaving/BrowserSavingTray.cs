using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;
using System.Collections.Generic;

class BrowserSavingTray : Form
{
    private NotifyIcon trayIcon;
    private List<Process> processes = new List<Process>();
    private string basePath = @"C:\BrowserSaving";

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new BrowserSavingTray());
    }

    public BrowserSavingTray()
    {
        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.FormBorderStyle = FormBorderStyle.None;
        this.Opacity = 0;

        // Create icon
        Icon appIcon = CreateIcon();

        // Context menu
        var menu = new ContextMenuStrip();
        
        var header = new ToolStripLabel("BrowserSaving");
        header.Font = new Font("Segoe UI", 9, FontStyle.Bold);
        menu.Items.Add(header);
        menu.Items.Add(new ToolStripSeparator());
        
        var openDash = menu.Items.Add("Open Dashboard");
        openDash.Click += (s, e) => Process.Start(new ProcessStartInfo("http://100.82.152.81:5173") { UseShellExecute = true });
        
        menu.Items.Add(new ToolStripSeparator());
        
        var statusItem = menu.Items.Add("Show Status");
        statusItem.Click += (s, e) => ShowStatus();
        
        var restartAll = menu.Items.Add("Restart All");
        restartAll.Click += (s, e) => { StopAll(); StartAll(); trayIcon.ShowBalloonTip(2000, "BrowserSaving", "All services restarted", ToolTipIcon.Info); };
        
        var viewLogs = menu.Items.Add("View Logs");
        viewLogs.Click += (s, e) => {
            string logDir = Path.Combine(basePath, "logs");
            if (Directory.Exists(logDir))
                Process.Start(new ProcessStartInfo("explorer.exe", logDir));
            else
                MessageBox.Show("Log directory not found", "BrowserSaving");
        };
        
        menu.Items.Add(new ToolStripSeparator());
        
        var exitItem = menu.Items.Add("Exit");
        exitItem.Click += (s, e) => { StopAll(); trayIcon.Visible = false; Application.Exit(); };

        // Tray icon
        trayIcon = new NotifyIcon();
        trayIcon.Icon = appIcon;
        trayIcon.Text = "BrowserSaving";
        trayIcon.ContextMenuStrip = menu;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (s, e) => Process.Start(new ProcessStartInfo("http://100.82.152.81:5173") { UseShellExecute = true });

        // Start services
        StartAll();
        trayIcon.ShowBalloonTip(3000, "BrowserSaving", "3 services started", ToolTipIcon.Info);
    }

    private Icon CreateIcon()
    {
        Bitmap bmp = new Bitmap(32, 32);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.FromArgb(59, 130, 246));
            
            // Round corners
            using (var brush = new SolidBrush(Color.FromArgb(59, 130, 246)))
            {
                g.FillRectangle(brush, 0, 0, 32, 32);
            }
            
            using (Font font = new Font("Segoe UI", 18, FontStyle.Bold))
            using (StringFormat sf = new StringFormat() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                g.DrawString("B", font, Brushes.White, new RectangleF(0, 0, 32, 32), sf);
            }
        }
        Icon icon = Icon.FromHandle(bmp.GetHicon());
        return icon;
    }

    private void StartAll()
    {
        string logDir = Path.Combine(basePath, "logs");
        Directory.CreateDirectory(logDir);
        
        // 1. Launcher Server
        StartProcess("node", "launcher-server.js", basePath, Path.Combine(logDir, "launcher.log"));
        
        // 2. Token Service
        StartProcess("node", "token-service.js", basePath, Path.Combine(logDir, "token-service.log"));
        
        // 3. Vite Dev Server
        StartProcess("cmd.exe", "/c npx vite --host 0.0.0.0 --port 5173", Path.Combine(basePath, "apps", "browsersaving"), Path.Combine(logDir, "vite.log"));
    }

    private void StartProcess(string exe, string args, string workDir, string logFile)
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;

            var proc = Process.Start(psi);
            if (proc != null)
            {
                processes.Add(proc);
                // Write logs async
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLog(logFile, e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLog(logFile, "[ERR] " + e.Data); };
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            }
        }
        catch (Exception ex)
        {
            AppendLog(logFile, "FAILED TO START: " + ex.Message);
        }
    }

    private void AppendLog(string path, string line)
    {
        try { File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss") + " " + line + Environment.NewLine); } catch { }
    }

    private void StopAll()
    {
        foreach (var p in processes)
        {
            try
            {
                if (!p.HasExited)
                {
                    // Kill process tree
                    var kill = Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + p.Id.ToString()) { CreateNoWindow = true, UseShellExecute = false });
                    if (kill != null) kill.WaitForExit(5000);
                }
            }
            catch { }
        }
        processes.Clear();
    }

    private void ShowStatus()
    {
        var lines = new List<string>();
        string[] names = { "Launcher (3456)", "Token Service (3457)", "Vite Dev (5173)" };
        for (int i = 0; i < processes.Count && i < names.Length; i++)
        {
            var p = processes[i];
            string status;
            try { status = p.HasExited ? "Stopped" : "Running"; } catch { status = "Unknown"; }
            string emoji = status == "Running" ? "✅" : "❌";
            lines.Add(emoji + " " + names[i] + " — " + status);
        }
        if (lines.Count == 0) lines.Add("No services running");
        MessageBox.Show(string.Join("\n", lines), "BrowserSaving Status", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Minimize to tray instead of closing
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            this.Hide();
        }
        else
        {
            StopAll();
            trayIcon.Visible = false;
            base.OnFormClosing(e);
        }
    }
}
