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
      assert.match(css, new RegExp(`\\.seg-${kind}\\s*\\{[^}]*var\\(--attn-${kind}\\)`), `strip colour for ${kind}`);
      assert.match(css, new RegExp(`\\.dot-${kind}\\s*\\{[^}]*var\\(--attn-${kind}\\)`), `dot colour for ${kind}`);
    }
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

  it('stop the flowing motion for people who ask for less motion', () => {
    assert.match(css, /prefers-reduced-motion[\s\S]*\.seg\s*\{\s*animation:\s*none/);
  });
});
