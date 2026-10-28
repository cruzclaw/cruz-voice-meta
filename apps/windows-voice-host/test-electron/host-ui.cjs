// Runs the real createVoiceHost in Electron, with no server, and checks the silent attention strip on the
// real panel window: when it appears, that it takes no focus, its colours, and that the bar and the
// full panel have the same width and left edge. Run with: npm run test:electron
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const { createVoiceHost } = require(path.join(dist, 'index.cjs'));

const COLORS = { update: '#1fb26a', approval: '#f59e0b', acknowledgement: '#2f6df6', error: '#e5484d' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = (c) => ({ counts: { update: 0, approval: 0, acknowledgement: 0, error: 0, ...c } });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};

// Windows may refuse to give focus to an app that is not in front, which would hide a focus grab from a test
// that only looks at isFocused(). So the calls that take focus are recorded, and any of them is a failure.
const focusGrabs = [];
for (const method of ['show', 'focus', 'moveTop', 'setAlwaysOnTop']) {
  const real = BrowserWindow.prototype[method];
  if (method === 'setAlwaysOnTop') continue;
  BrowserWindow.prototype[method] = function (...args) {
    focusGrabs.push(method);
    return real.apply(this, args);
  };
}

app.whenReady().then(async () => {
  console.log(`display scale factor ${screen.getPrimaryDisplay().scaleFactor}`);
  let resolves = 0;
  const host = createVoiceHost({
    connection: { resolve: async () => { resolves += 1; throw new Error('offline'); } },
    assetsDir: dist,
    deviceSpeech: false,
    shortcutLabel: 'Ctrl+Shift+Space',
    log: () => undefined,
  });
  const win = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Cruz');
  const dom = (code) => win().webContents.executeJavaScript(code);
  const strip = () =>
    dom(`Array.from(document.querySelectorAll('#hue .seg')).map((s) => ({ kind: s.className.replace('seg seg-', ''), color: getComputedStyle(s).getPropertyValue('--c').trim(), width: Math.round(s.getBoundingClientRect().width), top: Math.round(s.getBoundingClientRect().top), height: Math.round(s.getBoundingClientRect().height) }))`);
  const hueVisible = () =>
    dom(`(() => { const h = document.getElementById('hue'); const r = h.getBoundingClientRect(); return !h.hidden && r.height > 0 && getComputedStyle(h).display !== 'none'; })()`);
  const click = (id) => dom(`document.getElementById('${id}').click()`);
  const KINDS = { update: { update: 1 }, approval: { approval: 1 }, acknowledgement: { acknowledgement: 1 }, error: { error: 1 } };

  check(!win(), 'no window exists before anything is waiting');
  check(resolves === 0, 'nothing connects to the server until the person asks for a call');

  // 1. An update arrives while no panel is open.
  host.setAttention(counts({ update: 2 }));
  await wait(1500);
  const w = win();
  check(!!w && w.isVisible(), 'the small bar appears when an update is waiting');
  check(BrowserWindow.getAllWindows().length === 1, 'and it is the only window: no microphone window is opened just to show a strip');
  check(!!w && !w.isFocused(), 'and it does not take focus');
  check(host.describe().mini === true, 'and it is the minimised bar, not the expanded panel');
  const bar = w.getBounds();
  check(bar.height < 60, `the bar is thin (height ${bar.height})`);
  let s = await strip();
  check(s.length === 1 && s[0].kind === 'update' && s[0].color === COLORS.update, 'the strip is green for an update');
  check(!!s[0] && s[0].top === 0 && s[0].height >= 3, `the strip is at the very top of the bar (top ${s[0] && s[0].top}, height ${s[0] && s[0].height})`);
  check(!!s[0] && s[0].width >= bar.width - 4, 'and spans the bar');

  // 2. Expanding: same width and left edge, and the strip is still there.
  await click('expand');
  await wait(600);
  const full = win().getBounds();
  check(full.width === bar.width, `the expanded panel is as wide as the bar (${full.width} = ${bar.width})`);
  check(full.x === bar.x, `and has the same left edge (${full.x} = ${bar.x})`);
  check(Math.abs(full.y + full.height - (bar.y + bar.height)) <= 1, `and grows upward from the bar, keeping its bottom edge, within a pixel of rounding (${full.y}+${full.height} vs ${bar.y}+${bar.height})`);
  check(await hueVisible(), 'the strip is still there in the expanded panel');
  check(!win().isFocused(), 'expanding does not make it take focus from other apps');

  // 3. Every colour, expanded.
  for (const [kind, c] of Object.entries(KINDS)) {
    host.setAttention(counts(c));
    await wait(300);
    s = await strip();
    check(s.length === 1 && s[0].kind === kind && s[0].color === COLORS[kind], `expanded: the strip is ${COLORS[kind]} for ${kind}`);
  }
  host.setAttention(counts({ update: 2, approval: 1, acknowledgement: 1, error: 3 }));
  await wait(300);
  s = await strip();
  check(s.map((x) => x.kind).join() === 'update,approval,acknowledgement,error', 'expanded: all four kinds show at once, none hiding another');
  check(s.every((x) => x.color === COLORS[x.kind]), 'with their own colours');
  const widths = s.map((x) => x.width);
  check(Math.max(...widths) - Math.min(...widths) <= 1, `in equal parts (${widths.join(', ')})`);

  // 4. Minimise with everything waiting: the strip stays, and the width and left edge do not change.
  await click('minimize');
  await wait(600);
  const mini = win().getBounds();
  check(mini.width === full.width && mini.x === full.x, `minimising keeps the width and left edge (${mini.width} at ${mini.x})`);
  check(await hueVisible(), 'the strip is still visible when minimised');
  s = await strip();
  check(s.length === 4 && s.every((x) => x.color === COLORS[x.kind]), 'minimised: all four colours show');
  for (const [kind, c] of Object.entries(KINDS)) {
    host.setAttention(counts(c));
    await wait(300);
    s = await strip();
    check(s.length === 1 && s[0].kind === kind && s[0].color === COLORS[kind], `minimised: the strip is ${COLORS[kind]} for ${kind}`);
    check(win().getBounds().width === full.width, `minimised ${kind}: width unchanged`);
  }

  // 5. Closing with something waiting leaves the bar. With nothing waiting it hides.
  await click('expand');
  await wait(400);
  await click('close');
  await wait(400);
  check(win().isVisible() && host.describe().mini, 'closing with something waiting leaves the small bar, so the strip is not taken away');
  check(win().getBounds().width === full.width && win().getBounds().x === full.x, 'at the same width and left edge');
  host.setAttention(counts({}));
  await wait(400);
  check(!(await hueVisible()), 'with nothing waiting the strip is gone');
  check(!win().isVisible(), 'and the bar that was only there for it goes away with it');

  // 5b. Something arrives again after the panel was hidden: the bar comes back, silently, at the same place.
  host.setAttention(counts({ error: 1 }));
  await wait(600);
  check(win().isVisible() && host.describe().mini, 'a later arrival brings the small bar back');
  const again = win().getBounds();
  check(again.width === full.width && again.x === full.x, 'at the same width and left edge as before');
  s = await strip();
  check(s.length === 1 && s[0].kind === 'error' && s[0].color === COLORS.error, 'in red for an error');
  host.setAttention(counts({}));
  await wait(400);

  // 6. Arrivals never move or resize a panel the person has open.
  await click('expand');
  await wait(400);
  const before = win().getBounds();
  host.setAttention(counts({ update: 1 }));
  await wait(400);
  check(JSON.stringify(win().getBounds()) === JSON.stringify(before), 'a new arrival does not move, resize or minimise an open panel');
  host.setAttention(counts({}));
  await wait(400);
  check(win().isVisible(), 'and clearing it does not close a panel the person opened');

  // 7. The first press is what opens the connection.
  host.press();
  await wait(800);
  check(resolves >= 1, 'pressing Call opens the connection');
  check(BrowserWindow.getAllWindows().length === 1, 'and a call that could not connect opens no microphone window');
  host.testSpeaker();
  await wait(500);
  check(BrowserWindow.getAllWindows().length === 2, 'the audio window opens only when the speaker or microphone is first needed');
  host.hangUp();
  focusGrabs.length = 0;

  check(focusGrabs.length === 0, `nothing in this whole run asked the system to focus or raise a window (${focusGrabs.join(', ') || 'no calls'})`);
  console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
  host.dispose();
  app.exit(failures === 0 ? 0 : 1);
});
