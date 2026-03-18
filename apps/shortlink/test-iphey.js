const { app, BrowserWindow, session } = require('electron');
const STEALTH_SCRIPT = require('./stealth.js');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_UA;

app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');

app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = CHROME_UA;
        delete details.requestHeaders['X-Electron-Version'];
        callback({ requestHeaders: details.requestHeaders });
    });

    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
        title: 'Fingerprint Test - iphey.com',
    });

    win.webContents.on('dom-ready', () => {
        win.webContents.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
    });

    win.loadURL('https://iphey.com/');
});
