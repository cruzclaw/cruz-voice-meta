// Preload for the panel window. Only these calls cross into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  onState: (callback) => ipcRenderer.on('panel-state', (_event, state) => callback(state)),
  onLevel: (callback) => ipcRenderer.on('panel-level', (_event, level) => callback(level)),
  onDiag: (callback) => ipcRenderer.on('panel-diag', (_event, text) => callback(text)),
  talk: () => ipcRenderer.send('panel-talk'),
  hide: () => ipcRenderer.send('panel-hide'),
});
