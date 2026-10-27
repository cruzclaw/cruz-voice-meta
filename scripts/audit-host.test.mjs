import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCEPTED, evaluate } from './audit-host.mjs';

const advisory = (id, severity = 'high') => ({ source: 1, name: 'sharp', severity, title: 'x', url: `https://github.com/advisories/${id}`, range: '<1' });
const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } });
const known = () =>
  report({
    sharp: { name: 'sharp', severity: 'high', via: [...ACCEPTED.keys()].map((id) => advisory(id)) },
    '@huggingface/transformers': { name: '@huggingface/transformers', severity: 'high', via: ['sharp'] },
    'kokoro-js': { name: 'kokoro-js', severity: 'high', via: ['@huggingface/transformers'] },
  });

describe('audit-host evaluate', () => {
  it('accepts exactly the three known sharp advisories and nothing else', () => {
    const r = evaluate(known());
    assert.equal(r.ok, true);
    assert.equal(r.accepted.length, 3);
    assert.deepEqual(r.stale, []);
  });

  it('passes a clean report, and notes the accepted entries that are no longer reported', () => {
    const r = evaluate(report({}));
    assert.equal(r.ok, true);
    assert.equal(r.stale.length, 3);
  });

  it('fails on a new advisory in sharp itself, so a package name is not a blanket pass', () => {
    const r = report({ sharp: { name: 'sharp', severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } });
    const out = evaluate(r);
    assert.equal(out.ok, false);
    assert.match(out.problems[0], /GHSA-AAAA-BBBB-CCCC is not an accepted advisory/);
  });

  it('fails when an accepted advisory rises to critical', () => {
    const r = report({ sharp: { name: 'sharp', severity: 'critical', via: [advisory([...ACCEPTED.keys()][0], 'critical')] } });
    const out = evaluate(r);
    assert.equal(out.ok, false);
    assert.match(out.problems.join(' '), /above the accepted high/);
  });

  it('fails on a high or critical advisory in any other package', () => {
    for (const severity of ['high', 'critical']) {
      const r = known();
      r.vulnerabilities.ws = { name: 'ws', severity, via: [{ ...advisory('GHSA-zzzz-zzzz-zzzz', severity), name: 'ws' }] };
      const out = evaluate(r);
      assert.equal(out.ok, false, severity);
      assert.match(out.problems.join(' '), /ws \[/);
    }
  });

  it('fails on an advisory with no id, rather than letting it through', () => {
    const r = report({ sharp: { name: 'sharp', severity: 'high', via: [{ name: 'sharp', severity: 'high', title: 'mystery', url: '' }] } });
    assert.equal(evaluate(r).ok, false);
  });

  it('ignores moderate and lower advisories, which this gate never covered', () => {
    const r = known();
    r.vulnerabilities.esbuild = { name: 'esbuild', severity: 'moderate', via: [{ ...advisory('GHSA-mmmm-mmmm-mmmm', 'moderate'), name: 'esbuild' }] };
    assert.equal(evaluate(r).ok, true);
  });

  it('fails when the audit did not run or the report is unusable', () => {
    for (const bad of [undefined, null, 'oops', {}, { error: { summary: 'network down' } }, { metadata: {} }, { vulnerabilities: {} }, { metadata: {}, vulnerabilities: null }]) {
      assert.equal(evaluate(bad).ok, false, JSON.stringify(bad));
    }
    assert.match(evaluate({ error: { summary: 'network down' } }).problems[0], /network down/);
  });
});
