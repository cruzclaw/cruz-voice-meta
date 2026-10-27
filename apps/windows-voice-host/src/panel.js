// The panel page. It only shows what the main process sends and forwards three button presses.
const $ = (id) => document.getElementById(id);
const orb = $('orb');
const scroller = $('scroll');
const log = $('log');

/** Turns shown in the scroll area. A turn is what the person said and what the assistant answered. */
let turns = [];
let lastSaid = '';
let lastReply = '';
let newTurnNext = false;

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

let shortcut = '';

function renderTurns() {
  log.textContent = '';
  if (!turns.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = shortcut ? `Press Talk or ${shortcut} to start.` : 'Press Talk to start.';
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

window.panel.onState((s) => {
  orb.dataset.state = s.display;
  orb.dataset.muted = String(!!s.muted && s.display !== 'speaking' && s.display !== 'thinking');
  $('caption').textContent = s.muted && s.display === 'idle' ? 'Microphone muted' : CAPTION[s.display] || s.label;

  shortcut = s.shortcut || '';
  syncTurns(s);
  renderTurns();

  const talk = $('talk');
  const stopMode = s.display === 'listening' || s.display === 'speaking' || s.display === 'thinking';
  talk.dataset.mode = stopMode ? 'stop' : 'talk';
  talk.dataset.listening = String(s.display === 'listening');
  talk.disabled = !s.connected;
  talk.setAttribute(
    'aria-label',
    s.display === 'listening' ? 'Done talking' : s.display === 'speaking' || s.display === 'thinking' ? 'Stop and listen' : `Talk (${s.shortcut})`,
  );
  talk.title = talk.getAttribute('aria-label');

  const mute = $('mute');
  mute.setAttribute('aria-pressed', String(!!s.muted));
  mute.setAttribute('aria-label', s.muted ? 'Unmute microphone' : 'Mute microphone');
  mute.title = mute.getAttribute('aria-label');

  const note = $('note');
  const text = s.approval ? `Needs your approval: ${s.approval}` : s.error;
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('error', !s.approval && !!s.error);

  const diag = $('diag');
  diag.hidden = !s.debug;
  if (s.display !== 'listening' && s.display !== 'speaking') target = 0;
});

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
  orb.style.setProperty('--level', reduceMotion.matches ? '0' : shown.toFixed(3));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.panel.onDiag((text) => {
  $('diag').textContent = text;
});

$('talk').addEventListener('click', () => window.panel.talk());
$('mute').addEventListener('click', () => window.panel.mute());
$('close').addEventListener('click', () => window.panel.hide());
