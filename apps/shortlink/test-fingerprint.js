const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_UA;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
    const ses = session.defaultSession;
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = CHROME_UA;
        delete details.requestHeaders['X-Electron-Version'];
        callback({ requestHeaders: details.requestHeaders });
    });

    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.webContents.on('dom-ready', () => {
        win.webContents.executeJavaScript(`
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['th-TH', 'th', 'en-US', 'en'] });
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
        `).catch(() => {});
    });

    await win.loadURL('https://iphey.com/');

    // Wait for page to fully render
    await new Promise(r => setTimeout(r, 25000));

    const image = await win.webContents.capturePage();
    const screenshotPath = path.join(__dirname, 'iphey-result.png');
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log('Screenshot saved: ' + screenshotPath);

    app.quit();
});
