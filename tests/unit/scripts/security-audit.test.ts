import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R5-F21 (FR-015 to FR-017, SC-004, SC-005) -- `npm run security:audit` never reports clean when
 * it did not look.
 *
 * The old body was `npm audit --audit-level=low` twice. npm reads `offline` and `omit` from the
 * environment and from `.npmrc`, and with either set it writes a valid, empty report and exits 0:
 * the audit said clean having audited nothing, or nothing of the development tree. The capture
 * (feature 249) already defeats both with `AUDIT_ARGV`, and decides the outcome from the report,
 * never from the exit status. `scripts/security-audit.mjs` uses both, and adds two rules: a report
 * over zero dependencies is incomplete, and any finding at `low` or above fails.
 *
 * (a) and (b) are pure. (c) spawns the real script against a fixture lockfile with a dead loopback
 * registry, so it needs npm but never the network. Contract: `contracts/security-audit.md`.
 */
async function loadAudit() {
  return import('../../../scripts/security-audit.mjs');
}
async function loadModel() {
  return import('../../../scripts/advisory-model.mjs');
}

let audit: Awaited<ReturnType<typeof loadAudit>>;
let model: Awaited<ReturnType<typeof loadModel>>;

beforeAll(async () => {
  audit = await loadAudit();
  model = await loadModel();
});

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'security-audit.mjs');
/** Port 9 (discard) on loopback: nothing listens, so npm fails at once and never leaves the machine. */
const DEAD_REGISTRY = 'http://127.0.0.1:9';
const SPAWN_TIMEOUT_MS = 30_000;

const MANIFEST = {
  name: 'security-audit-fixture',
  version: '1.0.0',
  private: true,
  devDependencies: { 'left-pad': '1.3.0' }
};

const LOCKFILE = {
  name: 'security-audit-fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'security-audit-fixture', version: '1.0.0', devDependencies: { 'left-pad': '1.3.0' } },
    'node_modules/left-pad': {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      dev: true,
      license: 'WTFPL'
    }
  }
};

interface Counts {
  readonly info: number;
  readonly low: number;
  readonly moderate: number;
  readonly high: number;
  readonly critical: number;
}

function report(counts: Partial<Counts>, total: number): string {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts };
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { ...vulnerabilities, total: Object.values(vulnerabilities).reduce((a, b) => a + b, 0) },
      dependencies: { prod: 0, dev: total, optional: 0, peer: 0, peerOptional: 0, total }
    }
  });
}

describe('(a) classification: incomplete is never clean', () => {
  it.each([
    ['a spawn error', { stdout: '', spawnError: true }, 'incomplete', 'tool-unavailable'],
    ['a timeout', { stdout: '', timedOut: true }, 'incomplete', 'audit-timeout'],
    ['an empty stdout', { stdout: '   \n' }, 'incomplete', 'no-report'],
    ['a stdout that is not JSON', { stdout: 'npm ERR! offline' }, 'incomplete', 'report-unparseable'],
    ['an npm error object', { stdout: JSON.stringify({ error: { code: 'ECONNREFUSED' } }) }, 'incomplete', 'audit-error'],
    ['a report over zero dependencies', { stdout: report({}, 0) }, 'incomplete', 'no-dependencies'],
    ['an output over the report bound', { stdout: '{}', overflow: true }, 'incomplete', 'over-bound']
  ])('reads %s as incomplete', (_label, input, status, reason) => {
    const result = audit.classifyAudit(input, LOCKFILE);
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
  });

  it('reads one low finding as findings, with its counts', () => {
    const result = audit.classifyAudit({ stdout: report({ low: 1 }, 2) }, LOCKFILE);
    expect(result.status).toBe('findings');
    expect(result.counts?.low).toBe(1);
    expect(result.dependencies).toBe(2);
  });

  it('reads a report with only info advisories as clean', () => {
    const result = audit.classifyAudit({ stdout: report({ info: 3 }, 2) }, LOCKFILE);
    expect(result.status).toBe('clean');
    expect(result.reason).toBeUndefined();
  });

  /** A report whose `vulnerabilities` map names one advisory on `left-pad`, with `metadata` as given. */
  function reportWithAdvisory(severity: string, metadataVulnerabilities: unknown): string {
    return JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'left-pad': {
          name: 'left-pad',
          severity,
          via: [{ source: 1001, title: 'fixture advisory', url: 'https://example.invalid/advisory', severity, range: '<2.0.0' }],
          effects: [],
          range: '<2.0.0',
          nodes: ['node_modules/left-pad']
        }
      },
      metadata: {
        vulnerabilities: metadataVulnerabilities,
        dependencies: { prod: 0, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 2 }
      }
    });
  }
  const ZERO_COUNTS = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };

  it.each([
    ['a high advisory with zeroed metadata counts', reportWithAdvisory('high', ZERO_COUNTS)],
    ['a high advisory with no metadata counts', reportWithAdvisory('high', undefined)],
    ['an advisory of unknown severity with zeroed counts', reportWithAdvisory('urgent', ZERO_COUNTS)]
  ])('reads %s as incomplete, never clean (review S1)', (_label, stdout) => {
    const result = audit.classifyAudit({ stdout }, LOCKFILE);
    expect(result).toMatchObject({ status: 'incomplete', reason: 'report-inconsistent' });
  });

  it('reads a report with no metadata counts and no advisories as incomplete (review S1)', () => {
    const stdout = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { dependencies: { prod: 0, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 2 } }
    });
    expect(audit.classifyAudit({ stdout }, LOCKFILE)).toMatchObject({ status: 'incomplete', reason: 'report-inconsistent' });
  });

  it('still reads an info advisory with an info count as clean, and a high one with its count as findings', () => {
    expect(audit.classifyAudit({ stdout: reportWithAdvisory('info', { ...ZERO_COUNTS, info: 1, total: 1 }) }, LOCKFILE)).toMatchObject({
      status: 'clean'
    });
    expect(audit.classifyAudit({ stdout: reportWithAdvisory('high', { ...ZERO_COUNTS, high: 1, total: 1 }) }, LOCKFILE)).toMatchObject({
      status: 'findings'
    });
  });

  it('formats an incomplete tree without the word clean', () => {
    const line = audit.formatLine('root', audit.classifyAudit({ stdout: '' }, LOCKFILE));
    expect(line).toBe('security-audit: root  incomplete  reason=no-report  dependencies=-');
  });

  it('formats a clean tree with its counts and dependencies', () => {
    const line = audit.formatLine('root', audit.classifyAudit({ stdout: report({}, 2) }, LOCKFILE));
    expect(line).toBe(
      'security-audit: root  clean  critical=0 high=0 moderate=0 low=0 info=0  dependencies=2'
    );
  });
});

describe('(a2) a tree needs its manifest and its lockfile before npm runs (review S3)', () => {
  function treeWith(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'security-audit-tree-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), `${JSON.stringify(body)}\n`);
    return dir;
  }

  it.each([
    ['a lockfile but no manifest', { 'package-lock.json': LOCKFILE }],
    ['a manifest but no lockfile', { 'package.json': MANIFEST }]
  ])('reads a directory with %s as tree-missing, without running npm', (_label, files) => {
    const runs: string[] = [];
    const result = audit.auditTree(treeWith(files), {
      runAudit: (dir: string) => {
        runs.push(dir);
        return { stdout: report({}, 2) };
      }
    });
    expect(result).toMatchObject({ status: 'incomplete', reason: 'tree-missing' });
    expect(runs).toEqual([]);
  });

  it('runs npm once for a directory with both', () => {
    const runs: string[] = [];
    const result = audit.auditTree(treeWith({ 'package.json': MANIFEST, 'package-lock.json': LOCKFILE }), {
      runAudit: (dir: string) => {
        runs.push(dir);
        return { stdout: report({}, 2) };
      }
    });
    expect(result.status).toBe('clean');
    expect(runs).toHaveLength(1);
  });
});

describe('(b) the argv is the capture argv', () => {
  it('deep-equals AUDIT_ARGV, so offline and omit are always overridden', () => {
    expect(audit.auditArgv()).toEqual([...model.AUDIT_ARGV]);
    expect(audit.auditArgv()).toContain('--offline=false');
    expect(audit.auditArgv()).toContain('--include=dev');
  });
});

describe('(c) a poisoned configuration is incomplete, never clean (FR-016)', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'security-audit-'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
    writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(LOCKFILE, null, 2)}\n`);
    return dir;
  }

  it.each([
    ['offline', { npm_config_offline: 'true' }],
    ['omit dev', { npm_config_omit: 'dev' }],
    ['an unreachable registry alone', {}]
  ])('reports %s as incomplete with exit 1', (_label, poison) => {
    const dir = fixture();
    const run = spawnSync(process.execPath, [SCRIPT, '--dir', dir], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        npm_config_registry: DEAD_REGISTRY,
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '2000',
        npm_config_cache: join(dir, '.npm-cache'),
        npm_config_update_notifier: 'false',
        ...poison
      }
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('incomplete');
    expect(run.stdout).not.toContain('  clean');
    expect(run.stdout).toContain('security-audit: 1 tree(s): 0 clean, 0 with findings, 1 incomplete');
  }, SPAWN_TIMEOUT_MS + 5_000);
});

describe('(d) usage', () => {
  it.each([[['--bogus']], [['--dir']]])('exits 2 on %j', (args) => {
    const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    expect(run.status).toBe(2);
    expect(run.stdout).not.toContain('clean');
  });
});
