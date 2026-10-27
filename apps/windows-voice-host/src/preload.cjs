// Preload for the hidden audio window. Exposes only the few calls the audio page needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostAudio', {
  onCapture: (callback) => ipcRenderer.on('capture', (_event, on) => callback(Boolean(on))),
  onPlay: (callback) => ipcRenderer.on('play', (_event, pcm) => callback(pcm)),
  onStopPlayback: (callback) => ipcRenderer.on('stop-playback', () => callback()),
  sendMic: (buffer) => ipcRenderer.send('mic', buffer),
  reportError: (message) => ipcRenderer.send('audio-error', String(message)),
});
