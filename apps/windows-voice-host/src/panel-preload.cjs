// Preload for the panel window. Only these calls cross into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  onState: (callback) => ipcRenderer.on('panel-state', (_event, state) => callback(state)),
  onLevel: (callback) => ipcRenderer.on('panel-level', (_event, level) => callback(level)),
  onDiag: (callback) => ipcRenderer.on('panel-diag', (_event, text) => callback(text)),
  onAttention: (callback) => ipcRenderer.on('panel-attention', (_event, attention) => callback(attention)),
  onAudioTest: (callback) => ipcRenderer.on('panel-audio-test', (_event, step) => callback(step)),
  testAudio: () => ipcRenderer.send('panel-test-audio'),
  audioHeard: (heard) => ipcRenderer.send('panel-audio-heard', heard === true),
  talk: () => ipcRenderer.send('panel-talk'),
  mute: () => ipcRenderer.send('panel-mute'),
  hangup: () => ipcRenderer.send('panel-hangup'),
  minimize: () => ipcRenderer.send('panel-minimize'),
  expand: () => ipcRenderer.send('panel-expand'),
  hide: () => ipcRenderer.send('panel-hide'),
  openAttention: () => ipcRenderer.send('panel-attention-open'),
  chooseEmployee: (id) => ipcRenderer.send('panel-choose-employee', id),
});
