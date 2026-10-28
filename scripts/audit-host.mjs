// Gates the Windows host's dependencies at high severity, except three named advisories.
//
// The host bundles Kokoro for on-device speech. Kokoro's tree pulls in `sharp`, which has three
// high-severity advisories with no fix yet, all in its image decoders. The evidence that speech never
// reaches that code is in docs/audit-exceptions.md. Only these exact advisories are accepted, by id,
// with the highest severity they are accepted at. Anything else fails: a new advisory (even in sharp),
// a higher severity, a vulnerable package outside the Kokoro chain, or an audit that could not run.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Advisory id -> the highest severity accepted. Remove an entry when sharp is fixed. */
export const ACCEPTED = new Map([
  ['GHSA-F88M-G3JW-G9CJ', 'high'], // sharp: libvips
  ['GHSA-RGJ7-G3M4-5G8C', 'high'], // sharp: libheif
  ['GHSA-WQ5F-XC86-PV6W', 'high'], // sharp: librsvg
]);

/** The packages that carry those advisories into the host: sharp itself and what depends on it. */
export const KOKORO_CHAIN = new Set(['sharp', '@huggingface/transformers', 'kokoro-js']);

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const advisoryId = (url) => /GHSA-[a-z0-9-]+/i.exec(String(url ?? ''))?.[0]?.toUpperCase();

/**
 * Judges an `npm audit --json` report. Returns { ok, problems, accepted, stale }.
 * A report that is not recognisably an audit report is a problem, never a pass.
 */
export function evaluate(report) {
  if (!report || typeof report !== 'object' || report.error || !report.metadata || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    return { ok: false, problems: [`the audit did not produce a usable report${report?.error?.summary ? `: ${report.error.summary}` : ''}`], accepted: [], stale: [] };
  }

  const problems = [];
  const seen = new Set();
  for (const vuln of Object.values(report.vulnerabilities)) {
    if ((RANK[vuln.severity] ?? 4) < RANK.high) continue;
    if (!KOKORO_CHAIN.has(vuln.name)) problems.push(`${vuln.name} [${vuln.severity}] is outside the Kokoro chain`);
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string') continue; // a package that depends on another vulnerable one
      if ((RANK[via.severity] ?? 4) < RANK.high) continue;
      const id = advisoryId(via.url);
      if (!id || !ACCEPTED.has(id)) {
        problems.push(`${vuln.name}: ${id ?? via.title ?? 'an advisory without an id'} is not an accepted advisory`);
      } else if (RANK[via.severity] > RANK[ACCEPTED.get(id)]) {
        problems.push(`${vuln.name}: ${id} is now ${via.severity}, above the accepted ${ACCEPTED.get(id)}`);
      } else {
        seen.add(id);
      }
    }
  }
  const stale = [...ACCEPTED.keys()].filter((id) => !seen.has(id));
  return { ok: problems.length === 0, problems, accepted: [...seen], stale };
}

function main() {
  const run = spawnSync('npm audit --json -w @cruzclaw/windows-voice-host', { encoding: 'utf8', shell: true });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error('Could not read the npm audit report.');
    console.error(run.stderr || run.stdout);
    process.exit(2);
  }
  const result = evaluate(report);
  for (const id of result.accepted) console.log(`accepted (see docs/audit-exceptions.md): ${id}`);
  for (const id of result.stale) console.log(`note: ${id} is no longer reported. Remove it from ACCEPTED.`);
  if (!result.ok) {
    for (const p of result.problems) console.error(`NOT accepted: ${p}`);
    process.exit(1);
  }
  console.log(`host audit ok: ${result.accepted.length} accepted advisories, nothing else at high or critical`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
