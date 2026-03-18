const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    shorten: (payload) => ipcRenderer.invoke('shorten', payload),
    toggleShopee: () => ipcRenderer.invoke('toggle-shopee'),
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
    startAgent: () => ipcRenderer.invoke('start-agent'),
    stopAgent: () => ipcRenderer.invoke('stop-agent'),
    getAgentStatus: () => ipcRenderer.invoke('get-agent-status'),
    onAgentLog: (cb) => ipcRenderer.on('agent-log', (_e, data) => cb(data)),
    onAgentStatus: (cb) => ipcRenderer.on('agent-status', (_e, running) => cb(running)),
});
