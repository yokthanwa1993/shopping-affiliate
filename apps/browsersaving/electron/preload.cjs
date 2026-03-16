const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__BROWSERSAVING_ELECTRON__', {
  invoke(command, args = {}) {
    return ipcRenderer.invoke('browsersaving:invoke', command, args)
  },
  relaunch() {
    return ipcRenderer.invoke('browsersaving:relaunch')
  },
})
