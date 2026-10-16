const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dangoOverlay', {
  hide: () => ipcRenderer.send('overlay:hide'),
  compact: (on) => ipcRenderer.send('overlay:compact', on),
  reset: () => ipcRenderer.send('overlay:reset'),
  quit: () => ipcRenderer.send('overlay:quit'),
  onVisible: (cb) => ipcRenderer.on('overlay:visible', (_e, visible) => cb(visible)),
})
