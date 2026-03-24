const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    shorten: (payload) => ipcRenderer.invoke('shorten', payload),
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
    startAgent: () => ipcRenderer.invoke('start-agent'),
    stopAgent: () => ipcRenderer.invoke('stop-agent'),
    getSessionStatus: (account) => ipcRenderer.invoke('get-session-status', account),
    openLogin: (account) => ipcRenderer.invoke('open-login', account),
    onAgentStatus: (cb) => ipcRenderer.on('agent-status', (_e, v) => cb(v)),
    onSessionStatus: (cb) => ipcRenderer.on('session-status', (_e, v) => cb(v)),
    onLogEntry: (cb) => ipcRenderer.on('log-entry', (_e, v) => cb(v)),
});
