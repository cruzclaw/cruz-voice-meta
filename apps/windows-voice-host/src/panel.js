// The panel page. It only shows what the main process sends and forwards three button presses.
const $ = (id) => document.getElementById(id);
const orb = $('orb');
const scroller = $('scroll');
const log = $('log');
const miniDot = $('mini-dot');

/** Turns shown in the scroll area. A turn is what the person said and what the assistant answered. */
let turns = [];
let lastSaid = '';
let lastReply = '';
let newTurnNext = false;
let epoch = 0;

function syncTurns(s) {
  const said = s.transcript || '';
  const reply = s.reply || '';
  // The reply is cleared when a new utterance is recognised, so a cleared reply marks a new turn,
  // even if the person repeated the same sentence.
  if (!reply && lastReply) newTurnNext = true;
  const changedSaid = said !== '' && said !== lastSaid;
  const restarted = reply !== '' && lastReply !== '' && !reply.startsWith(lastReply); // a new greeting, for instance
  lastSaid = said;
  lastReply = reply;
  if (!said && !reply) return;
  if (!turns.length || changedSaid || restarted || newTurnNext) {
    turns.push({ said, reply });
    newTurnNext = false;
  } else {
    const turn = turns[turns.length - 1];
    turn.said = said || turn.said;
    turn.reply = reply;
  }
  if (turns.length > 8) turns = turns.slice(-8);
}

let emptyText = '';

function renderTurns() {
  log.textContent = '';
  if (!turns.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = emptyText;
    log.append(p);
    return;
  }
  for (const turn of turns) {
    const wrap = document.createElement('div');
    wrap.className = 'turn';
    if (turn.said) {
      const said = document.createElement('p');
      said.className = 'said';
      said.textContent = turn.said;
      wrap.append(said);
    }
    if (turn.reply) {
      const reply = document.createElement('p');
      reply.className = 'reply';
      reply.textContent = turn.reply;
      wrap.append(reply);
    }
    log.append(wrap);
  }
  scroller.scrollTop = scroller.scrollHeight;
}

const CAPTION = {
  disconnected: 'Not connected',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  awaiting_approval: 'Needs your approval',
  task_working: 'Working on it',
};

let inCall = false;
let lastState;

const hue = $('hue');
let attentionKinds = [];
let attentionLabel = '';
let thinking = false;
window.panel.onState((s) => {
  lastState = s;
  // Signed out: nothing of the earlier conversation stays in the page.
  if ((s.epoch || 0) !== epoch) {
    epoch = s.epoch || 0;
    turns = [];
    lastSaid = '';
    lastReply = '';
    newTurnNext = false;
  }
  document.body.classList.toggle('is-mini', !!s.mini);
  const muted = !!s.muted && s.display !== 'speaking' && s.display !== 'thinking';
  orb.dataset.state = s.display;
  orb.dataset.muted = String(muted);
  miniDot.dataset.state = s.display;
  miniDot.dataset.muted = String(muted);
  thinking = s.display === 'thinking' || s.display === 'task_working';
  showHue();
  // What it says, who it is for, whether a call can start and what the microphone is doing all come from the main
  // process, already decided. This page only shows them.
  const caption = s.caption || CAPTION[s.display] || s.label;
  $('caption').textContent = caption;
  $('mini-caption').textContent = caption;
  for (const id of ['mic', 'mini-mic']) {
    $(id).textContent = s.micText || '';
    $(id).dataset.mic = s.mic || 'off';
  }
  $('title').textContent = s.employee || 'Cruz';
  showEmployees(s);

  emptyText = s.emptyText || '';
  syncTurns(s);
  renderTurns();

  // One button starts the call and ends it. Pressing it in a call hangs up, whatever is happening.
  inCall = !!s.inCall;
  for (const button of document.querySelectorAll('.js-call')) {
    button.dataset.mode = inCall ? 'hangup' : 'call';
    button.dataset.listening = String(s.display === 'listening');
    // A call can start whenever the account is ready: it connects when pressed. In a call, hang up is always there.
    button.disabled = !inCall && !s.canCall;
    const label = inCall ? 'Hang up' : s.canCall ? (s.shortcut ? `Call (${s.shortcut})` : 'Call') : 'Call is not available yet';
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  for (const button of document.querySelectorAll('.js-mute')) {
    button.setAttribute('aria-pressed', String(!!s.muted));
    const label = s.muted ? 'Unmute microphone' : 'Mute microphone';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  const note = $('note');
  const text = s.approval ? `Needs your approval: ${s.approval}` : s.error;
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('error', !s.approval && !!s.error);

  const diag = $('diag');
  diag.hidden = !s.debug;
  if (s.display !== 'listening' && s.display !== 'speaking') target = 0;
});

// ---- Choosing the employee for voice ----
let chooseOpen = false;
let lastEmployees = '';

function showEmployees(s) {
  const list = Array.isArray(s.employees) ? s.employees : [];
  const mustChoose = s.readiness === 'no_employee' && list.length > 0;
  // Always open when nothing is chosen, so the way forward is on the panel itself. Otherwise only after Change.
  const open = mustChoose || (chooseOpen && list.length > 0);
  if (!mustChoose && !chooseOpen) chooseOpen = false;
  $('choose').hidden = !open;
  $('change-employee').hidden = list.length === 0 || mustChoose;
  $('mini-choose').hidden = !mustChoose;
  $('choose-heading').textContent = mustChoose ? 'Choose an employee' : 'Talk to';
  const key = JSON.stringify([list, s.selectedEmployeeId]);
  if (key === lastEmployees) return;
  lastEmployees = key;
  const box = $('choose-list');
  box.textContent = '';
  for (const person of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(person.id === s.selectedEmployeeId));
    button.textContent = person.name;
    button.addEventListener('click', () => {
      chooseOpen = false;
      window.panel.chooseEmployee(person.id);
    });
    box.append(button);
  }
}
$('change-employee').addEventListener('click', () => {
  chooseOpen = !chooseOpen;
  lastEmployees = '';
  // Redraw from the last state the main process sent.
  if (lastState) showEmployees(lastState);
});
$('mini-choose').addEventListener('click', () => window.panel.expand());

// The orb follows the loudness of whoever is talking: the person while listening, the assistant while speaking.
let target = 0;
let shown = 0;
window.panel.onLevel((level) => {
  // Speech sits well below full scale, so stretch it.
  target = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.7);
});
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function frame() {
  target *= 0.9; // fall back toward calm when no new level arrives
  shown += (target - shown) * 0.35;
  const level = reduceMotion.matches ? '0' : shown.toFixed(3);
  orb.style.setProperty('--level', level);
  miniDot.style.setProperty('--level', level);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.panel.onDiag((text) => {
  $('diag').textContent = text;
});

// The silent attention strip, the words under it and the badge on the minimised bar. They show
// exactly what the main process sends and do nothing until the person presses one of them.
const chip = $('attention');
const miniAttn = $('mini-attn');
// What the strip shows: the waiting items' colours flowing as one gradient, or, while the employee is thinking, an orange glow.
function showHue() {
  hue.hidden = attentionKinds.length === 0 && !thinking;
  hue.classList.toggle('is-thinking', thinking);
  hue.setAttribute('aria-label', thinking ? 'Thinking' : attentionLabel);
  // Each kind of waiting item adds its colour. The first colour closes the loop so the flow has no seam; one kind alone
  // shades from darker to lighter and back, so it still moves.
  const colour = (kind) => `var(--attn-${kind})`;
  const stops = attentionKinds.length > 1
    ? [...attentionKinds.map(colour), colour(attentionKinds[0])]
    : attentionKinds.length === 1
      ? [`color-mix(in srgb, ${colour(attentionKinds[0])} 70%, #000)`, colour(attentionKinds[0]), `color-mix(in srgb, ${colour(attentionKinds[0])} 55%, #fff)`, colour(attentionKinds[0]), `color-mix(in srgb, ${colour(attentionKinds[0])} 70%, #000)`]
      : [];
  if (stops.length) hue.style.setProperty('--stops', stops.join(', '));
}
window.panel.onAttention((a) => {
  const segments = Array.isArray(a && a.segments) ? a.segments : [];
  const label = (a && a.label) || '';
  attentionKinds = segments.map((segment) => segment.kind);
  attentionLabel = label;
  showHue();
  $('attention-dots').textContent = '';
  for (const segment of segments) {
    const dot = document.createElement('span');
    dot.className = `dot dot-${segment.kind}`;
    $('attention-dots').append(dot);
  }
  chip.hidden = segments.length === 0;
  $('attention-label').textContent = (a && a.shortLabel) || label;
  chip.setAttribute('aria-label', label ? `${label}. Press to review.` : '');
  miniAttn.hidden = segments.length === 0;
  $('mini-attn-count').textContent = a && a.total ? String(a.total) : '';
  miniAttn.setAttribute('aria-label', label ? `${label}. Press to review.` : '');
  miniAttn.title = label;
});
chip.addEventListener('click', () => window.panel.openAttention());
miniAttn.addEventListener('click', () => window.panel.openAttention());

for (const button of document.querySelectorAll('.js-call')) {
  button.addEventListener('click', () => (inCall ? window.panel.hangup() : window.panel.talk()));
}
for (const button of document.querySelectorAll('.js-mute')) button.addEventListener('click', () => window.panel.mute());
$('minimize').addEventListener('click', () => window.panel.minimize());
$('expand').addEventListener('click', () => window.panel.expand());
$('close').addEventListener('click', () => window.panel.hide());

// The speaker test. The host does the playing and says which step it is on; this page only shows it and sends back what the
// person answers. It starts no call and never touches the microphone.
const audioTest = $('audio-test');
const audioTestText = $('audio-test-text');
const audioAsk = $('audio-test-ask');
const audioClose = $('audio-test-close');
window.panel.onAudioTest((step) => {
  const known = step && typeof step === 'object' ? step : {};
  const name = typeof known.step === 'string' ? known.step : '';
  audioTest.hidden = name === '' || name === 'idle';
  audioTest.dataset.step = name;
  audioTestText.textContent = typeof known.text === 'string' ? known.text.slice(0, 240) : '';
  audioAsk.hidden = name !== 'ask';
  audioClose.hidden = !(name === 'yes' || name === 'no' || name === 'error' || name === 'busy');
  $('test-audio').disabled = name === 'testing' || name === 'ask';
});
$('test-audio').addEventListener('click', () => window.panel.testAudio());
$('audio-heard').addEventListener('click', () => window.panel.audioHeard(true));
$('audio-not-heard').addEventListener('click', () => window.panel.audioHeard(false));
audioClose.addEventListener('click', () => {
  audioTest.hidden = true;
  $('test-audio').disabled = false;
});
