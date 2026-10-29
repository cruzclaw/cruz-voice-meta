import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ATTENTION_COLORS, ATTENTION_KINDS } from '@cruzclaw/windows-bridge';

const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const html = read('panel.html');
const css = read('panel.css');
const js = read('panel.js');
const preload = read('panel-preload.cjs');

describe('the panel pages', () => {
  it('draw the four attention colours exactly as the logic names them, so the strip, the dots and the logic cannot disagree', () => {
    for (const kind of ATTENTION_KINDS) {
      const declared = new RegExp(`--attn-${kind}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
      assert.equal(declared?.toLowerCase(), ATTENTION_COLORS[kind].toLowerCase(), kind);
      assert.match(css, new RegExp(`\\.dot-${kind}\\s*\\{[^}]*var\\(--attn-${kind}\\)`), `dot colour for ${kind}`);
    }
  });

  it('colour the strip as one flowing gradient from the waiting kinds, right to left, not as separate blocks', () => {
    assert.match(js, /var\(--attn-\$\{kind\}\)/);
    assert.match(js, /colour\(attentionKinds\[0\]\)\]/, 'the first colour closes the loop');
    assert.match(css, /\.hue\s*\{[^}]*background:\s*linear-gradient\(90deg in oklch,\s*var\(--stops\)\)/);
    assert.match(css, /@keyframes hue-flow\s*\{\s*to\s*\{\s*background-position:\s*200% 0/);
    assert.equal(/\.seg/.test(css) || /createElement\('span'\);\s*seg\./.test(js), false, 'no separate blocks');
  });

  it('show an orange glow from the centre outwards, bright to dark, for as long as the employee is thinking', () => {
    assert.match(css, /\.hue\.is-thinking\s*\{[^}]*radial-gradient\(ellipse farthest-side at 50% 50%,\s*#ffd699 0%,\s*#ff9a1f var\(--glow\),\s*#8a3a00 100%\)/);
    assert.match(css, /@keyframes hue-breathe/);
    assert.match(js, /thinking = s\.display === 'thinking' \|\| s\.display === 'task_working'/);
    assert.match(js, /hue\.hidden = attentionKinds\.length === 0 && !thinking/);
  });

  it('keep the attention colours out of the conversation colours, so blue only ever means an acknowledgement in the strip', () => {
    // The strip's own rules are the only place the attention variables are used.
    const uses = [...css.matchAll(/var\(--attn-(\w+)\)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0 && uses.every((kind) => (ATTENTION_KINDS as readonly string[]).includes(kind!)));
    const orb = /\.orb\[data-state[^{]*\{[^}]*\}/g;
    assert.equal([...css.matchAll(orb)].some((m) => m[0].includes('--attn-')), false);
  });

  it('put the strip at the very top, above the header, in the one page that holds both the panel and the bar', () => {
    assert.ok(html.indexOf('id="hue"') > 0 && html.indexOf('id="hue"') < html.indexOf('<header>'));
    assert.ok(html.indexOf('id="mini"') > html.indexOf('id="hue"'), 'the bar is in the same page, under the same strip');
    assert.match(css, /\.hue\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*right:\s*0/);
    // Nothing hides the strip in the minimised state.
    const hidden = /body\.is-mini[^{]*\{[^}]*display:\s*none/g;
    for (const m of css.matchAll(hidden)) assert.equal(m[0].includes('.hue'), false, 'the strip is not hidden when minimised');
  });

  it('use no inline style attributes, which the panel page security policy would block', () => {
    assert.equal(/\sstyle\s*=/.test(html), false);
  });

  it('only look up elements that exist', () => {
    const ids = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    for (const id of new Set(ids)) assert.ok(html.includes(`id="${id}"`), `#${id} is used by panel.js but not in panel.html`);
  });

  it('give the strip and both badges a way to open the waiting items only when pressed, and nothing else opens them', () => {
    assert.match(js, /chip\.addEventListener\('click', \(\) => window\.panel\.openAttention\(\)\)/);
    assert.match(js, /miniAttn\.addEventListener\('click', \(\) => window\.panel\.openAttention\(\)\)/);
    assert.equal((js.match(/openAttention\(\)/g) ?? []).length, 2);
    assert.match(preload, /openAttention: \(\) => ipcRenderer\.send\('panel-attention-open'\)/);
  });

  it('stay quiet: no sound, no speech and no focus calls come from the attention code', () => {
    const attentionJs = js.slice(js.indexOf('const hue'));
    for (const noisy of ['Audio', 'speechSynthesis', 'Notification', '.focus(', 'play(', 'beep']) assert.equal(attentionJs.includes(noisy), false, noisy);
  });

  it('do not announce changes to a screen reader by themselves', () => {
    assert.equal(/id="attention"[^>]*aria-live/.test(html), false);
    assert.equal(/id="hue"[^>]*aria-live/.test(html), false);
  });

  it('slow the flowing motion, not stop it, for people who ask for less motion', () => {
    assert.match(css, /prefers-reduced-motion[\s\S]*\.hue\s*\{\s*animation-duration:\s*16s/);
    assert.equal(/prefers-reduced-motion[\s\S]*\.hue[^{]*\{[^}]*animation:\s*none/.test(css), false, 'the strip is slowed, never stopped, so a long wait always shows life');
  });

  it('let the person choose the employee from the panel itself, and hand only an id to the app', () => {
    assert.match(preload, /chooseEmployee: \(id\) => ipcRenderer\.send\('panel-choose-employee', id\)/);
    assert.match(js, /window\.panel\.chooseEmployee\(person\.id\)/);
    assert.ok(html.includes('id="choose"') && html.includes('id="change-employee"') && html.includes('id="mini-choose"'));
  });

  it('write employee names as text, never as markup', () => {
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(js), false);
    assert.match(js, /button\.textContent = person\.name/);
  });

  it('take what to say, who it is for, the microphone words and whether Call works from the main process, not from the page', () => {
    for (const field of ['s.caption', 's.emptyText', 's.micText', 's.employee', 's.canCall']) assert.ok(js.includes(field), field);
    assert.equal(/Press Call|tray|menu/i.test(js), false, 'the page holds no instructions of its own');
    assert.equal(/button\.disabled = !s\.connected/.test(js), false, 'Call no longer waits for a connection that only a call opens');
  });

  it('show the microphone state in its own element on both the full panel and the bar, with words', () => {
    assert.ok(html.includes('id="mic"') && html.includes('id="mini-mic"'));
    assert.match(css, /\.mic\[data-mic="wake"\]/);
    assert.match(css, /\.mini-mic/);
  });

  it('keep the strip crisp on the small bar, and keep the content of the bar out from under it', () => {
    assert.match(css, /body\.is-mini \.hue\s*\{[^}]*box-shadow:\s*none/);
    assert.match(css, /\.mini\s*\{[^}]*padding:\s*4px /, 'the bar starts below the 4px strip');
    assert.match(css, /\.hue\s*\{[^}]*height:\s*4px/);
  });
});
