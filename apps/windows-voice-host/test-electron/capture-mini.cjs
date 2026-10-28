// Saves a picture of the small bar, with all four colours waiting and voice not enabled, for a look by eye.
//   PAD_STATE=voice_disabled electron test-electron/capture-mini.cjs <output.png>
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const { createVoiceHost } = require(path.join(dist, 'index.cjs'));
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const host = createVoiceHost({ connection: { resolve: async () => { throw new Error('offline'); } }, assetsDir: dist, deviceSpeech: false, shortcutLabel: 'Ctrl+Shift+Space' });
  host.showBar();
  host.setEmployees([{ id: 'a', name: 'Tesla' }], 'a');
  host.setReadiness({ state: process.env.PAD_STATE || 'voice_disabled' });
  host.setAttention({ counts: { update: 2, approval: 1, acknowledgement: 1, error: 1 } });
  await wait(1500);
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Cruz');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(process.argv[2], image.toPNG());
  const { width, height } = image.getSize();
  console.log(`captured ${width}x${height} at scale ${require('electron').screen.getPrimaryDisplay().scaleFactor}`);
  host.dispose();
  app.exit(0);
});
