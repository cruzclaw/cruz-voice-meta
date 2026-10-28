// Preload for the hidden audio window. Exposes only the few calls the audio page needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostAudio', {
  onCapture: (callback) => ipcRenderer.on('capture', (_event, on) => callback(Boolean(on))),
  onPlay: (callback) => ipcRenderer.on('play', (_event, pcm) => callback(pcm)),
  onChime: (callback) => ipcRenderer.on('chime', (_event, kind) => callback(String(kind))),
  onWake: (callback) => ipcRenderer.on('wake-mic', (_event, on) => callback(Boolean(on))),
  ready: () => ipcRenderer.send('audio-ready'),
  onBeep: (callback) => ipcRenderer.on('beep', () => callback()),
  onStopPlayback: (callback) => ipcRenderer.on('stop-playback', () => callback()),
  sendMic: (buffer) => ipcRenderer.send('mic', buffer),
  sendOutLevel: (level) => ipcRenderer.send('out-level', level),
  drained: (count) => ipcRenderer.send('playback-drained', count),
  sendLevel: (level) => ipcRenderer.send('level', level),
  info: (message) => ipcRenderer.send('audio-info', String(message)),
  reportError: (message) => ipcRenderer.send('audio-error', String(message)),
});
