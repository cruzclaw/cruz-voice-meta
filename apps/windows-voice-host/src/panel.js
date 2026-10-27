// The panel page. It only shows what the main process sends and forwards two button presses.
const $ = (id) => document.getElementById(id);
const set = (el, text, placeholder) => {
  el.textContent = text || placeholder || ' ';
  el.classList.toggle('muted', !text);
};

window.panel.onState((s) => {
  $('dot').dataset.state = s.display;
  $('label').textContent = s.label;
  set($('said'), s.transcript);
  set($('reply'), s.reply);
  $('talk').textContent = s.display === 'listening' ? 'Done talking' : s.display === 'speaking' ? 'Interrupt' : 'Talk';
  $('talk').disabled = !s.connected;
  $('hint').textContent = s.connected ? `or press ${s.shortcut}` : '';
  const note = $('note');
  const text = s.approval ? `Needs your approval: ${s.approval}` : s.error;
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('error', !s.approval && !!s.error);
  if (s.display !== 'listening') $('level').style.width = '0';
});

window.panel.onLevel((level) => {
  // Speech sits well below full scale, so stretch it to fill the bar.
  $('level').style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 140))}%`;
});

window.panel.onDiag((text) => {
  $('diag').textContent = text;
});

$('talk').addEventListener('click', () => window.panel.talk());
$('close').addEventListener('click', () => window.panel.hide());
