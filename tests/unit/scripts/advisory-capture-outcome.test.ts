import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-003, FR-004, FR-026, P2) — what a capture records, and how its
 * outcome is decided.
 *
 * `captureTree` is pure over nine seams (git, npm, the temp directory, the clock), so every case
 * here runs without git, without npm and without the network. This pins contract T2: the outcome is
 * decided from the report and never from npm's exit status, the argv is the one that defeats npm's
 * offline and omit false-clean paths, nothing npm's error carried is recorded, and the temp
 * directory is removed whatever happens.
 *
 * Each outcome case reads a fixture under `tests/fixtures/advisory-diff/capture/` that declares its
 * own expectation. The npm report format is read from npm 11.17.0's source, not from an executed
 * audit.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadCapture() {
  return import('../../../scripts/advisory-capture.mjs');
}
async function loadModel() {
  return import('../../../scripts/advisory-model.mjs');
}

let capture: Awaited<ReturnType<typeof loadCapture>>;
let model: Awaited<ReturnType<typeof loadModel>>;

beforeAll(async () => {
  capture = await loadCapture();
  model = await loadModel();
});

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'advisory-diff', 'capture');

function readFixtureText(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

interface OutcomeFixture {
  readonly declares: {
    readonly description: string;
    readonly outcome: { readonly status: string; readonly reason?: string; readonly statusCode?: number; readonly bound?: string };
    readonly findingCount?: number;
    readonly registryHost?: string;
    readonly mustNotAppear?: readonly string[];
  };
  readonly registry: string | null;
  readonly npmVersion: string;
  readonly audit: {
    readonly stdout?: string;
    readonly stdoutJson?: unknown;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly spawnError: boolean;
    readonly overflow: boolean;
  };
}

function outcomeFixture(name: string): OutcomeFixture {
  return JSON.parse(readFixtureText(`${name}.json`)) as OutcomeFixture;
}

const COMMIT = '2222222222222222222222222222222222222222';
const MANIFEST_BLOB = '3333333333333333333333333333333333333333';
const LOCKFILE_BLOB = '4444444444444444444444444444444444444444';
const TEMP_DIR = '/fake-temp-root/advisory-7f3a';
const OBSERVED = new Date('2026-10-30T09:00:00.000Z');
const MIB = 1024 * 1024;

interface AuditResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnError: boolean;
  readonly overflow: boolean;
}

interface Overrides {
  readonly registry?: string | null;
  readonly npmVersion?: string | null;
  readonly audit?: () => AuditResult;
  readonly lockfileText?: string;
  readonly manifestText?: string;
  readonly lockfileBlob?: string | null;
  readonly lockfileSize?: number | null;
  readonly manifestSize?: number | null;
}

/** Fakes for the nine seams, recording every call in order. */
function makeSeams(overrides: Overrides = {}) {
  const calls: string[] = [];
  const revParseArgs: string[][] = [];
  const written: { dir: string; name: string; content: string }[] = [];
  const auditArgv: (readonly string[])[] = [];
  const removed: string[] = [];
  const blobReads: string[] = [];
  const lockfileText = overrides.lockfileText ?? readFixtureText('tree-lockfile.json');
  const manifestText = overrides.manifestText ?? readFixtureText('tree-manifest.json');
  const seams = {
    gitRevParse(args: readonly string[]): string | null {
      calls.push('gitRevParse');
      revParseArgs.push([...args]);
      const last = args[args.length - 1] ?? '';
      if (args[0] === '--show-object-format') return 'sha1';
      if (last.endsWith('^{commit}')) return COMMIT;
      if (last.endsWith('package-lock.json')) {
        return overrides.lockfileBlob === undefined ? LOCKFILE_BLOB : overrides.lockfileBlob;
      }
      if (last.endsWith('package.json')) return MANIFEST_BLOB;
      return null;
    },
    gitCatFileSize(spec: string): number | null {
      calls.push('gitCatFileSize');
      if (spec.endsWith('package-lock.json')) {
        return overrides.lockfileSize === undefined ? lockfileText.length : overrides.lockfileSize;
      }
      return overrides.manifestSize === undefined ? manifestText.length : overrides.manifestSize;
    },
    gitCatFileBlob(spec: string): string {
      calls.push('gitCatFileBlob');
      blobReads.push(spec);
      return spec.endsWith('package-lock.json') ? lockfileText : manifestText;
    },
    writeFile(dir: string, name: string, content: string): void {
      calls.push('writeFile');
      written.push({ dir, name, content });
    },
    npmVersion(): string | null {
      calls.push('npmVersion');
      return overrides.npmVersion === undefined ? '11.17.0' : overrides.npmVersion;
    },
    npmRegistry(): string | null {
      calls.push('npmRegistry');
      return overrides.registry === undefined ? 'https://registry.example.test/' : overrides.registry;
    },
    runAudit(_dir: string, argv: readonly string[]): AuditResult {
      calls.push('runAudit');
      auditArgv.push(argv);
      return (
        overrides.audit?.() ?? {
          stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
          exitCode: 0,
          timedOut: false,
          spawnError: false,
          overflow: false
        }
      );
    },
    makeTempDir(): string {
      calls.push('makeTempDir');
      return TEMP_DIR;
    },
    removeDir(dir: string): void {
      calls.push('removeDir');
      removed.push(dir);
    },
    now(): Date {
      calls.push('now');
      return OBSERVED;
    }
  };
  return { seams, calls, revParseArgs, written, auditArgv, removed, blobReads };
}

function auditFrom(fx: OutcomeFixture): AuditResult {
  return {
    stdout: fx.audit.stdoutJson === undefined ? (fx.audit.stdout ?? '') : JSON.stringify(fx.audit.stdoutJson),
    exitCode: fx.audit.exitCode,
    timedOut: fx.audit.timedOut,
    spawnError: fx.audit.spawnError,
    overflow: fx.audit.overflow
  };
}

function runFixture(name: string) {
  const fx = outcomeFixture(name);
  const harness = makeSeams({ registry: fx.registry, npmVersion: fx.npmVersion, audit: () => auditFrom(fx) });
  const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
  return { fx, harness, result };
}

describe('captureTree: the outcome is decided from the report, never from the exit status (T2)', () => {
  it('records a valid report as succeeded even when npm exits 1 (FR-004)', () => {
    const { fx, result } = runFixture('outcome-valid-exit-1');
    expect(result.outcome).toEqual(fx.declares.outcome);
    expect(result.findings).toHaveLength(fx.declares.findingCount ?? -1);
  });

  it('records a valid empty report as succeeded with zero findings', () => {
    const { fx, result } = runFixture('outcome-valid-empty');
    expect(result.outcome).toEqual(fx.declares.outcome);
    expect(result.findings).toEqual([]);
  });

  it('records empty output, output that is not JSON, and npm error JSON as failed', () => {
    for (const name of ['outcome-empty-stdout', 'outcome-not-json', 'outcome-error-503']) {
      const { fx, result } = runFixture(name);
      expect(result.outcome, name).toEqual(fx.declares.outcome);
      expect(result.findings, name).toEqual([]);
    }
  });

  it('records nothing of npm error JSON but its status code: no uri, headers or body (FR-026)', () => {
    const { fx, result } = runFixture('outcome-error-503');
    const text = JSON.stringify(result);
    expect(fx.declares.mustNotAppear?.length).toBeGreaterThan(0);
    for (const marker of fx.declares.mustNotAppear ?? []) expect(text).not.toContain(marker);
    expect(result.outcome).toMatchObject({ statusCode: 503 });
  });

  it('records a timeout and an npm that cannot be started as failed', () => {
    for (const name of ['outcome-timeout', 'outcome-spawn-error']) {
      const { fx, result } = runFixture(name);
      expect(result.outcome, name).toEqual(fx.declares.outcome);
    }
  });

  it('rejects a report that overflowed the buffer as over-bound, naming report-bytes', () => {
    const { fx, result } = runFixture('outcome-overflow');
    expect(result.outcome).toEqual(fx.declares.outcome);
    expect(result.findings).toEqual([]);
  });

  it('records only the registry host name, never its user information, port or path', () => {
    const { fx, result } = runFixture('outcome-registry-userinfo');
    expect(result.registryHost).toBe(fx.declares.registryHost);
    const text = JSON.stringify(result);
    for (const fragment of fx.declares.mustNotAppear ?? []) expect(text).not.toContain(fragment);
  });

  it('fails a capture whose registry setting is missing or is not a URL', () => {
    for (const name of ['outcome-registry-missing', 'outcome-registry-not-a-url']) {
      const { fx, harness, result } = runFixture(name);
      expect(result.outcome, name).toEqual(fx.declares.outcome);
      expect(harness.calls, `${name}: no audit is run without a registry`).not.toContain('runAudit');
    }
  });

  it('fails a capture whose npm version cannot be read, without running the audit', () => {
    const harness = makeSeams({ npmVersion: null });
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(result.outcome).toEqual({ status: 'failed', reason: 'tool-unavailable' });
    expect(harness.calls).not.toContain('runAudit');
  });
});

describe('captureTree: the commit, not the working tree, is the subject (FR-001, P2)', () => {
  it('rejects a lockfile over 16 MiB by size without ever reading a blob (D12)', () => {
    const harness = makeSeams({ lockfileSize: 16 * MIB + 1 });
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(result.outcome).toEqual({ status: 'rejected', reason: 'over-bound', bound: 'lockfile-bytes' });
    expect(harness.calls).not.toContain('gitCatFileBlob');
    expect(harness.calls).not.toContain('runAudit');
    expect(harness.removed).toEqual([]);
  });

  it('rejects a manifest over 16 MiB by size, naming manifest-bytes', () => {
    const harness = makeSeams({ manifestSize: 16 * MIB + 1 });
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(result.outcome).toEqual({ status: 'rejected', reason: 'over-bound', bound: 'manifest-bytes' });
    expect(harness.calls).not.toContain('gitCatFileBlob');
  });

  it('accepts a lockfile of exactly 16 MiB: the bound is inclusive', () => {
    const harness = makeSeams({ lockfileSize: 16 * MIB });
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(result.outcome.status).toBe('succeeded');
  });

  it('rejects a lockfile absent at the commit as tree-missing and records no blob for it', () => {
    const harness = makeSeams({ lockfileBlob: null });
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(result.outcome).toEqual({ status: 'rejected', reason: 'tree-missing' });
    expect(result.lockfile).toEqual({ path: 'package-lock.json', blob: null });
    expect(result.manifest).toEqual({ path: 'package.json', blob: MANIFEST_BLOB });
    expect(harness.calls).not.toContain('runAudit');
    expect(model.checkCapture(result)).toEqual({ ok: true });
  });

  it('rejects a lockfile that is not JSON as malformed, and a version 1 lockfile as unsupported', () => {
    const notJson = capture.captureTree(
      { tree: 'root', commit: 'HEAD' },
      makeSeams({ lockfileText: 'not json' }).seams
    );
    expect(notJson.outcome).toEqual({ status: 'rejected', reason: 'malformed' });
    const harness = makeSeams({
      lockfileText: JSON.stringify({ lockfileVersion: 1, dependencies: {} })
    });
    const oldFormat = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(oldFormat.outcome).toEqual({ status: 'rejected', reason: 'unsupported-format' });
    expect(harness.calls).not.toContain('runAudit');
  });

  it('asks git for each file as <commit>:<path> with the full commit id, and the webview paths', () => {
    const harness = makeSeams();
    const result = capture.captureTree({ tree: 'webview-ui', commit: 'HEAD' }, harness.seams);
    expect(result.manifest.path).toBe('webview-ui/package.json');
    expect(result.lockfile.path).toBe('webview-ui/package-lock.json');
    expect(harness.blobReads).toEqual([
      `${COMMIT}:webview-ui/package.json`,
      `${COMMIT}:webview-ui/package-lock.json`
    ]);
    expect(harness.revParseArgs[0]).toEqual(['--verify', '--end-of-options', 'HEAD^{commit}']);
  });

  it('refuses a rev beginning with a dash before it reaches git, and a rev git cannot resolve', () => {
    const dashed = makeSeams();
    expect(() => capture.captureTree({ tree: 'root', commit: '--output=x' }, dashed.seams)).toThrow();
    expect(dashed.calls).toEqual([]);

    const unresolved = makeSeams();
    const seams = { ...unresolved.seams, gitRevParse: () => null };
    expect(() => capture.captureTree({ tree: 'root', commit: 'no-such-rev' }, seams)).toThrow();
  });

  it('writes both files into the temp directory under their plain names, then removes it', () => {
    const harness = makeSeams();
    capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    expect(harness.written.map((w) => [w.dir, w.name])).toEqual([
      [TEMP_DIR, 'package.json'],
      [TEMP_DIR, 'package-lock.json']
    ]);
    expect(harness.removed).toEqual([TEMP_DIR]);
  });

  it('removes the temp directory when the audit seam throws (P2 step 8)', () => {
    const harness = makeSeams({
      audit: () => {
        throw new Error('seam failure');
      }
    });
    expect(() => capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams)).toThrow(
      'seam failure'
    );
    expect(harness.removed).toEqual([TEMP_DIR]);
  });

  it('takes observedAt immediately before the audit starts', () => {
    const harness = makeSeams();
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    const order = harness.calls.filter((c) => c === 'now' || c === 'runAudit' || c === 'npmRegistry');
    expect(order).toEqual(['npmRegistry', 'now', 'runAudit']);
    expect(result.observedAt).toBe(OBSERVED.toISOString());
  });
});

describe('captureTree: the argv and the record', () => {
  it('runs npm with exactly the argv that defeats the offline and omit false-clean paths (R2)', () => {
    const harness = makeSeams();
    const result = capture.captureTree({ tree: 'root', commit: 'HEAD' }, harness.seams);
    const expected = [
      'audit',
      '--json',
      '--offline=false',
      '--include=dev',
      '--include=optional',
      '--include=peer'
    ];
    expect(harness.auditArgv).toEqual([expected]);
    expect(model.AUDIT_ARGV).toEqual(expected);
    expect(result.command).toBe(`npm ${expected.join(' ')}`);
  });

  it('writes the capture keys in the contract order, with P1 limitations and provenance', () => {
    const { result } = runFixture('outcome-valid-exit-1');
    expect(Object.keys(result)).toEqual([
      'captureVersion',
      'tree',
      'ecosystem',
      'commit',
      'objectFormat',
      'manifest',
      'lockfile',
      'tool',
      'toolVersion',
      'command',
      'registryHost',
      'observedAt',
      'reportFormat',
      'outcome',
      'limitations',
      'findings'
    ]);
    expect(Object.keys(result.manifest)).toEqual(['path', 'blob']);
    expect(result).toMatchObject({
      captureVersion: 1,
      tree: 'root',
      ecosystem: 'npm',
      commit: COMMIT,
      objectFormat: 'sha1',
      tool: 'npm',
      toolVersion: '11.17.0',
      registryHost: 'registry.example.test',
      reportFormat: 'npm-audit-report-2'
    });
    expect(result.limitations).toEqual(capture.CAPTURE_LIMITATIONS);
    expect(result.limitations).toHaveLength(2);
  });

  it('writes a capture the compare side accepts, whatever the outcome', () => {
    for (const name of [
      'outcome-valid-exit-1',
      'outcome-valid-empty',
      'outcome-empty-stdout',
      'outcome-error-503',
      'outcome-timeout',
      'outcome-overflow',
      'outcome-registry-missing'
    ]) {
      const { result } = runFixture(name);
      expect(model.checkCapture(result), name).toEqual({ ok: true });
    }
  });

  it('records no absolute path, temp directory or environment value anywhere (FR-026)', () => {
    const { result } = runFixture('outcome-valid-exit-1');
    const text = JSON.stringify(result);
    expect(text).not.toContain(TEMP_DIR);
    expect(text).not.toContain('/fake-temp-root');
    expect(text).not.toMatch(/"(?:path|blob)":\s*"\//);
  });
});
