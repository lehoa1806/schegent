// FR-R5-F21 (FR-015 to FR-017) -- the absolute audit behind `npm run security:audit`, which never
// reports clean when it did not look.
//
// The old body was `npm audit --audit-level=low`, once per tree. npm reads `offline` and `omit` from
// the environment and from any `.npmrc`. With `offline` set it writes a valid, empty report without
// contacting the registry, and with `omit=dev` it skips the development tree, and in both cases it
// exits 0. So the audit could say clean having audited nothing. The capture (feature 249) already
// defeats both paths with `AUDIT_ARGV` and decides an outcome from the report, never from npm's
// exit status. This script uses that argv and that decision (`decideOutcome`), so the two cannot
// disagree about what a usable report is, and adds two rules of its own:
//
//   - a succeeded report over zero dependencies is incomplete: npm looked at nothing;
//   - any advisory at `low` or above is a finding, as `--audit-level=low` was.
//
// It audits the working tree's own manifest and lockfile, in place, and writes no file. It stays
// outside every chain that gives a verdict; the advisory comparison's report-only lint gate pins its
// body, and that this file never names the comparison. Contract:
// `specs/282-dependency-review-cadence/contracts/security-audit.md` in the workspace.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideOutcome } from './advisory-capture.mjs';
import { AUDIT_ARGV, BOUNDS } from './advisory-model.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The two trees audited by default, in order. */
const DEFAULT_TREES = Object.freeze([
  { name: 'root', dir: REPO_ROOT },
  { name: 'webview-ui', dir: join(REPO_ROOT, 'webview-ui') }
]);

/** The severities that fail the audit, as `--audit-level=low` did. `info` alone never does. */
const FAILING_SEVERITIES = Object.freeze(['critical', 'high', 'moderate', 'low']);
const COUNTED_SEVERITIES = Object.freeze([...FAILING_SEVERITIES, 'info']);

/** The reason when a report's counts are missing or disagree with the advisories it lists. */
const REPORT_INCONSISTENT = 'report-inconsistent';

const EXIT_CLEAN = 0;
const EXIT_NOT_CLEAN = 1;
const EXIT_USAGE = 2;

/** The argv every tree is audited with: the capture's, so `offline` and `omit` are overridden. */
export function auditArgv() {
  return [...AUDIT_ARGV];
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countOf(record, key) {
  const value = isRecord(record) ? record[key] : undefined;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The report's dependency total, or `null` when it is not a non-negative integer. */
function dependencyTotal(report) {
  const deps = isRecord(report) && isRecord(report['metadata']) ? report['metadata']['dependencies'] : undefined;
  const total = isRecord(deps) ? deps['total'] : undefined;
  return Number.isInteger(total) && total >= 0 ? total : null;
}

/**
 * Classify one tree's audit: `clean`, `findings`, or `incomplete` with a reason. The outcome is the
 * capture's (`decideOutcome`); a failed or rejected one is incomplete with its reason.
 *
 * @param {{ stdout: string, spawnError?: boolean, timedOut?: boolean, overflow?: boolean }} audit
 * @param {unknown} lockfile The tree's parsed `package-lock.json`.
 */
export function classifyAudit(audit, lockfile) {
  const rootManifest = isRecord(lockfile) && isRecord(lockfile['packages']) ? lockfile['packages'][''] : undefined;
  const { outcome, findings } = decideOutcome(audit, lockfile, rootManifest);
  if (outcome.status !== 'succeeded') return { status: 'incomplete', reason: outcome.reason };
  // Parsed again rather than threaded out of `decideOutcome`, so the capture's contract is unchanged.
  const report = JSON.parse(audit.stdout);
  const dependencies = dependencyTotal(report);
  if (dependencies === null || dependencies === 0) return { status: 'incomplete', reason: 'no-dependencies' };
  const vulnerabilities = isRecord(report['metadata']) ? report['metadata']['vulnerabilities'] : undefined;
  if (!isRecord(vulnerabilities)) return { status: 'incomplete', reason: REPORT_INCONSISTENT };
  const counts = Object.fromEntries(COUNTED_SEVERITIES.map((severity) => [severity, countOf(vulnerabilities, severity)]));
  const failing = FAILING_SEVERITIES.some((severity) => counts[severity] > 0);
  // The counts are the verdict, but they never outvote the advisories themselves: a report that lists
  // an advisory above `info` (or of a severity npm did not name) while its counts show none failing
  // contradicts itself, and is not read as clean.
  if (!failing && findings.some((finding) => finding.severity !== 'info')) {
    return { status: 'incomplete', reason: REPORT_INCONSISTENT };
  }
  return { status: failing ? 'findings' : 'clean', counts, dependencies };
}

/** One tree's line, in the contract's format. An incomplete tree never carries the word clean. */
export function formatLine(tree, result) {
  const parts = [`security-audit: ${tree}`, result.status];
  if (result.reason !== undefined) parts.push(`reason=${result.reason}`);
  if (result.counts !== undefined) {
    parts.push(COUNTED_SEVERITIES.map((severity) => `${severity}=${String(result.counts[severity])}`).join(' '));
  }
  parts.push(`dependencies=${result.dependencies === undefined ? '-' : String(result.dependencies)}`);
  return parts.join('  ');
}

function readLockfile(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * npm, bound as the capture's own CLI binds it: no shell, npm's stderr never read,
 * the capture's timeout, and one byte over the report bound so an overflow is seen, not truncated.
 */
function runNpmAudit(dir) {
  const child = spawnSync('npm', auditArgv(), {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: BOUNDS.auditTimeoutMs,
    maxBuffer: BOUNDS.reportBytes + 1
  });
  const code = child.error?.code;
  return {
    stdout: typeof child.stdout === 'string' ? child.stdout : '',
    timedOut: code === 'ETIMEDOUT',
    spawnError: child.error !== undefined && code !== 'ETIMEDOUT' && code !== 'ENOBUFS',
    overflow: code === 'ENOBUFS'
  };
}

/**
 * Audit one tree in place. A missing or unreadable lockfile, or a missing manifest, is incomplete
 * without running npm: there is nothing of this tree for the audit to read.
 *
 * @param {string} dir
 * @param {{ runAudit?: (dir: string) => { stdout: string, spawnError?: boolean, timedOut?: boolean, overflow?: boolean } }} [seams]
 */
export function auditTree(dir, seams = {}) {
  const lockfile = readLockfile(dir);
  // Without its own manifest npm walks up and audits a parent project instead (review S3).
  if (!isRecord(lockfile) || !existsSync(join(dir, 'package.json'))) return { status: 'incomplete', reason: 'tree-missing' };
  const run = seams.runAudit ?? runNpmAudit;
  return classifyAudit(run(dir), lockfile);
}

/** The trees named by `--dir`, or the default two; `null` on a usage error. */
export function parseArgs(argv) {
  const dirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg !== '--dir' || value === undefined || value.startsWith('--')) return null;
    dirs.push(value);
    index += 1;
  }
  return dirs.length === 0 ? [...DEFAULT_TREES] : dirs.map((dir) => ({ name: dir, dir: resolve(dir) }));
}

function main() {
  const trees = parseArgs(process.argv.slice(2));
  if (trees === null) {
    process.stdout.write('security-audit: usage: node scripts/security-audit.mjs [--dir <path>]...\n');
    return EXIT_USAGE;
  }
  const tally = { clean: 0, findings: 0, incomplete: 0 };
  for (const tree of trees) {
    const result = auditTree(tree.dir);
    tally[result.status] += 1;
    process.stdout.write(`${formatLine(tree.name, result)}\n`);
  }
  process.stdout.write(
    `security-audit: ${String(trees.length)} tree(s): ${String(tally.clean)} clean, ` +
      `${String(tally.findings)} with findings, ${String(tally.incomplete)} incomplete\n`
  );
  return tally.clean === trees.length ? EXIT_CLEAN : EXIT_NOT_CLEAN;
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main();
}
