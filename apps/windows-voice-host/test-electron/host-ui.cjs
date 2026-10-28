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

// The first host is disposed before the second is made, and Electron quits when its last window closes.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log(`display scale factor ${screen.getPrimaryDisplay().scaleFactor}`);
  let resolves = 0;
  const lines = [];
  const host = createVoiceHost({
    connection: { resolve: async () => { resolves += 1; throw new Error('offline'); } },
    assetsDir: dist,
    deviceSpeech: false,
    shortcutLabel: 'Ctrl+Shift+Space',
    log: (line) => lines.push(line),
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

  // 5. Closing is the person's act. It hides the panel for the session, whatever is waiting, and nothing brings it back.
  await click('expand');
  await wait(400);
  await click('close');
  await wait(400);
  check(!win().isVisible(), 'closing hides the panel completely, even with something waiting');
  host.setAttention(counts({ error: 1 }));
  await wait(600);
  check(!win().isVisible(), 'and something arriving afterwards does not bring it back');
  host.setAttention(counts({}));
  await wait(300);
  host.setAttention(counts({ error: 1 }));
  await wait(600);
  check(!win().isVisible(), 'nor does clearing and arriving again');

  // 5b. The shortcut, the tray or the app bring it back, as the small bar, at the same place and width.
  host.showBar();
  await wait(600);
  check(win().isVisible() && host.describe().mini, 'showBar brings the small bar back');
  const again = win().getBounds();
  check(again.width === full.width && again.x === full.x, 'at the same width and left edge as before');
  s = await strip();
  check(s.length === 1 && s[0].kind === 'error' && s[0].color === COLORS.error, 'with the strip in red for the error that is waiting');
  host.setAttention(counts({}));
  await wait(400);
  check(win().isVisible(), 'and clearing what is waiting does not hide a bar the person has not closed');

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
  await wait(2500);
  check(BrowserWindow.getAllWindows().length === 2, 'the audio window opens only when the speaker or microphone is first needed');
  check(lines.some((l) => /test tone played/.test(l)), 'and what was sent to it before its page had loaded still arrives: the test tone played');
  // 8. Signing out ends everything: the words on the panel go, and the connection is not retried.
  const logText = () => dom(`document.getElementById('log').textContent`);
  host.controller.onServer({ v: 1, seq: 1, type: 'transcript.final', utteranceId: 'u1', text: 'what does the email from Maria say' }, true);
  host.controller.onServer({ v: 1, seq: 2, type: 'assistant.text.delta', turnId: 't1', text: 'It says the numbers are 41 and 97.' }, true);
  await wait(400);
  check(/numbers are 41 and 97/.test(await logText()), 'a conversation is on the panel');
  host.endSession();
  const triesAtSignOut = resolves;
  await wait(500);
  const afterText = await logText();
  check(!/Maria|41 and 97/.test(afterText), `signed out: none of the conversation is left on the panel (${JSON.stringify(afterText.slice(0, 60))})`);
  check(host.controller.display === 'disconnected' && !host.controller.inCall, 'and the call is over');
  await wait(5000);
  check(resolves === triesAtSignOut, `and it does not try to reconnect by itself (${resolves} tries, ${triesAtSignOut} at sign-out)`);
  host.hangUp();
  host.dispose();
  focusGrabs.length = 0;

  // ================= Part 2: the pad on a normal start, the employee, what it says, the microphone =================
  const chosen = [];
  let resolves2 = 0;
  const lines2 = [];
  const host2 = createVoiceHost({
    connection: { resolve: async () => { resolves2 += 1; throw new Error('offline'); } },
    assetsDir: dist,
    deviceSpeech: false,
    shortcutLabel: 'Ctrl+Shift+Space',
    onEmployeeChoose: (id) => chosen.push(id),
    log: (line) => lines2.push(line),
  });
  const win2 = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Cruz');
  const dom2 = (code) => win2().webContents.executeJavaScript(code);
  const text = (id) => dom2(`document.getElementById('${id}').textContent`);
  const shown = (id) => dom2(`(() => { const e = document.getElementById('${id}'); return !e.hidden && e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none'; })()`);
  const disabled = () => dom2(`Array.from(document.querySelectorAll('.js-call')).every((b) => b.disabled)`);
  const click2 = (id) => dom2(`document.getElementById('${id}').click()`);
  const TESLA = { id: 'p-tesla', name: 'Tesla' };
  const OPS = { id: 'p-ops', name: 'Versal Ops' };

  // 9. An ordinary start: the pad appears, silently, and turns nothing on.
  host2.showBar();
  await wait(1500);
  check(!!win2() && win2().isVisible() && host2.describe().mini, 'on a normal start the small pad appears');
  check(!win2().isFocused() && focusGrabs.length === 0, 'without taking focus');
  check(BrowserWindow.getAllWindows().length === 1, 'and it is the only window: no microphone is opened');
  check(resolves2 === 0, 'it connects to nothing and starts no call');
  check((await text('mini-mic')) === 'Mic off', 'the microphone reads Mic off');
  check(host2.describe().visible, 'and it is visible');

  // 10. Before the account answers, nothing can be called.
  host2.setReadiness({ state: 'checking' });
  await wait(300);
  check((await text('mini-caption')) === 'Checking…' && (await disabled()), 'while checking, the pad says so and Call is not available');

  // 11. No employee chosen: the pad offers the choice itself.
  host2.setEmployees([TESLA, OPS], undefined);
  host2.setReadiness({ state: 'no_employee' });
  await wait(300);
  check((await text('mini-caption')) === 'Choose employee', 'with none chosen, the pad says Choose employee');
  check(await shown('mini-choose'), 'and offers a Choose button on the small pad');
  check(await disabled(), 'Call is not available');
  host2.press();
  await wait(700);
  check(resolves2 === 0, 'pressing the shortcut with no employee connects to nothing');
  check(host2.describe().visible && !host2.describe().mini, 'but it opens the full panel, so the reason is on screen');
  check(await shown('choose'), 'where the employees are listed to choose from');
  const names = await dom2(`Array.from(document.querySelectorAll('#choose-list .choice')).map((b) => b.textContent)`);
  check(JSON.stringify(names) === JSON.stringify(['Tesla', 'Versal Ops']), `listing every eligible employee (${names.join(', ')})`);
  check(/Choose which employee/.test(await text('log')), 'and the words in the panel say Choose which employee to talk to');
  check(!/tray|menu/i.test(await dom2(`document.body.innerText`)), 'without sending the person to a tray menu');

  // 12. Choosing hands the choice to the app. Choosing alone opens nothing.
  await dom2(`document.querySelectorAll('#choose-list .choice')[0].click()`);
  await wait(300);
  check(chosen.join() === TESLA.id, 'choosing an employee tells the app which one');
  check(BrowserWindow.getAllWindows().length === 1 && resolves2 === 0, 'and by itself opens no microphone and makes no connection');
  host2.setEmployees([TESLA, OPS], TESLA.id);
  host2.setReadiness({ state: 'ready' });
  await wait(300);
  check((await text('title')) === 'Tesla', 'the chosen employee is named on the expanded panel');
  check((await text('caption')) === 'Tesla · Ready', `and in its caption (${await text('caption')})`);
  check(!(await shown('choose')) && (await shown('change-employee')), 'the list closes, and Change stays available');
  check(!(await disabled()), 'Call is available now');
  check((await text('mic')) === 'Mic off', 'the microphone still reads Mic off after choosing');
  await click2('minimize');
  await wait(500);
  check((await text('mini-caption')) === 'Tesla · Ready', 'the small pad shows the employee too');

  // 13. Changing the choice later.
  await click2('expand');
  await wait(400);
  await click2('change-employee');
  await wait(300);
  check(await shown('choose'), 'Change opens the list');
  const marked = await dom2(`Array.from(document.querySelectorAll('#choose-list .choice')).filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent)`);
  check(marked.join() === 'Tesla', 'with the current employee marked');
  await dom2(`document.querySelectorAll('#choose-list .choice')[1].click()`);
  await wait(200);
  check(chosen.join() === `${TESLA.id},${OPS.id}`, 'and the new choice reaches the app');
  host2.setEmployees([TESLA, OPS], OPS.id);
  await wait(300);
  check((await text('title')) === 'Versal Ops', 'the panel follows the app and shows the new employee');
  host2.setEmployees([TESLA, OPS], 'someone-removed');
  host2.setReadiness({ state: 'no_employee' });
  await wait(300);
  check((await text('title')) === 'Cruz' && (await shown('choose')), 'a chosen employee who is no longer on the account is not shown, and the list opens again');

  // 14. Why a call is not available: each reason in its own words, naming only controls that exist.
  const reasons = [
    ['voice_disabled', 'Voice not enabled', /not turned on/],
    ['no_employees', 'No employee', /no employee to talk to/],
    ['signed_out', 'Signed out', /Sign in to CruzClaw/],
  ];
  for (const [state, cap, words] of reasons) {
    host2.setReadiness({ state });
    await wait(300);
    check((await text('caption')) === cap, `${state}: the caption is ${cap}`);
    check(words.test(await text('log')), `${state}: the panel explains it`);
    check(await disabled(), `${state}: Call is not available`);
    check(!/Press Call|Ctrl\+Shift/.test(await text('log')), `${state}: the panel does not tell the person to press Call`);
    host2.press();
    await wait(400);
  }
  check(resolves2 === 0, 'none of those presses connected to anything');

  // 15. A connection that keeps failing is said plainly, and is not confused with the other reasons.
  host2.setEmployees([TESLA, OPS], TESLA.id);
  host2.setReadiness({ state: 'ready' });
  await wait(200);
  host2.press();
  await wait(1500);
  check(resolves2 >= 1, 'with an employee chosen and voice on, a press does try to connect');
  check(host2.readiness.state === 'connection_failed', `a failing connection is reported as such (${host2.readiness.state})`);
  check((await text('caption')) === 'Tesla · Cannot connect' && /Cannot reach CruzClaw/.test(await text('log')), 'in the caption and the words');
  host2.setReadiness({ state: 'voice_disabled' });
  await wait(300);
  check(host2.readiness.state === 'voice_disabled', 'while an account without voice is never reported as a connection failure');
  host2.setReadiness({ state: 'ready' });
  host2.hangUp();

  // 16. The wake phrase is shown as its own microphone state.
  // Wake listening needs a connected, idle, unmuted conversation.
  host2.controller.setConnected(true);
  host2.controller.enableWake({ feed: () => {}, reset: () => {} });
  host2.setReadiness({ state: 'ready' });
  await wait(300);
  check((await text('mic')) === 'Wake listening', 'with the wake phrase on, the microphone reads Wake listening');
  host2.controller.disableWake();
  host2.setReadiness({ state: 'ready' });
  await wait(300);
  check((await text('mic')) === 'Mic off', 'and Mic off when it is turned off');
  host2.controller.setConnected(false);

  // 17. Closing dismisses the pad for the session. The shortcut brings it back. A restart starts it again.
  await click2('close');
  await wait(400);
  check(!win2().isVisible(), 'closing hides the pad');
  host2.setAttention(counts({ update: 1 }));
  await wait(500);
  check(!win2().isVisible(), 'something waiting does not bring it back');
  host2.press();
  await wait(700);
  check(win2().isVisible(), 'the shortcut brings it back');
  await click2('close');
  await wait(300);
  host2.showPanel();
  await wait(500);
  check(win2().isVisible() && !host2.describe().mini, 'so does the tray (showPanel), as the full panel');
  await click2('minimize');
  await wait(400);
  await click2('close');
  await wait(300);
  host2.showBar();
  await wait(500);
  check(win2().isVisible() && host2.describe().mini, 'and showBar, as the small pad again');

  // 18. Ending a session for a changed employee leaves the pad where it was and clears the conversation.
  // After a hang-up the controller only accepts the utterance it expects next, which is named 'interrupted'.
  host2.controller.onServer({ v: 1, seq: 1, type: 'transcript.final', utteranceId: 'interrupted', text: 'hello' }, true);
  host2.controller.onServer({ v: 1, seq: 2, type: 'assistant.text.delta', turnId: 't9', text: 'A thing the first employee said.' }, true);
  await wait(300);
  await click2('expand');
  await wait(400);
  check(/first employee said/.test(await text('log')), 'a conversation is on the panel');
  host2.endSession('employee_changed');
  await wait(400);
  check(!/first employee said/.test(await text('log')), 'ending the session for a different employee clears it');
  check(lines2.some((l) => /employee changed/.test(l)) && win2().isVisible(), 'and says why, and the pad stays');
  host2.dispose();
  focusGrabs.length = 0;

  check(focusGrabs.length === 0, `nothing in this whole run asked the system to focus or raise a window (${focusGrabs.join(', ') || 'no calls'})`);
  console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
