const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onLog: (cb) => ipcRenderer.on('log-entry', (_e, entry) => cb(entry)),
    onAgentStatus: (cb) => ipcRenderer.on('agent-status', (_e, running) => cb(running)),
});
