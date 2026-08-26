import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R3-061 (M-08 / R-15) — the canary's decisions, tested without a CLI, a
 * network, or credentials.
 *
 * The point of the separation: a canary whose logic can only be exercised by a
 * scheduled run against a live service is a canary nobody can reason about, and
 * its most common state -- no credentials -- is the one least likely to be
 * checked.
 */
async function loadCanary() {
  return import('../../../scripts/backend-canary.mjs');
}

let canary: Awaited<ReturnType<typeof loadCanary>>;

beforeAll(async () => {
  canary = await loadCanary();
});

const version = (v: string) => ({ ok: true, version: v });

describe('the backend canary reports what it actually established', () => {
  it('reports ok when the version probe and the live probe both pass', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: true },
      credentialPresent: true
    });
    expect(verdict.state).toBe('ok');
  });

  it('reports skipped-no-credentials, and says the run made no behavioural claim', () => {
    // The most common state in practice, and the one that must never read as a
    // pass. A canary that reports success because it did nothing is worse than
    // one that does not run.
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: null,
      credentialPresent: false
    });
    expect(verdict.state).toBe('skipped-no-credentials');
    expect(verdict.detail).toContain('NOT run');
    expect(verdict.detail).toContain('says nothing about protocol');
  });

  it('reports unavailable when the CLI is absent, not drifted', () => {
    // A missing CLI and a changed CLI are different findings. Reporting the first
    // as the second sends someone looking for a protocol change that never
    // happened.
    expect(canary.decideBackendState({ versionProbe: { ok: false, detail: 'ENOENT' } }).state).toBe(
      'unavailable'
    );
    expect(canary.decideBackendState({ versionProbe: null }).state).toBe('unavailable');
  });

  it('reports drift when the version leaves the recorded prefix', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('2.0.0'),
      expectedVersionPrefix: '1.'
    });
    expect(verdict.state).toBe('drifted');
    expect(verdict.detail).toContain('protocol shape');
  });

  it('reports drift when the live probe fails', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, detail: 'auth rejected' },
      credentialPresent: true
    });
    expect(verdict.state).toBe('drifted');
    expect(verdict.detail).toContain('auth rejected');
  });

  it('never turns a finding into a red gate through its exit code', () => {
    // The review's explicit constraint. A drift must not fail the workflow, or the
    // canary becomes a PR-adjacent gate depending on a third-party service.
    const drifted = [{ backend: 'claude', state: 'drifted', detail: 'x' }];
    expect(canary.canaryExitCode(drifted)).toBe(0);
    expect(canary.canaryExitCode([])).toBe(0);
    // Non-zero only when the canary itself is broken.
    expect(canary.canaryExitCode(undefined)).toBe(2);
  });

  it('says in its report that a degraded run qualified nothing', () => {
    const report = canary.formatReport([
      { backend: 'claude', state: 'skipped-no-credentials', detail: 'd' },
      { backend: 'codex', state: 'drifted', detail: 'd' }
    ]);
    expect(report).toContain('version probe only');
    expect(report).toContain('No behavioural claim');
    expect(report).toContain('not gate failures');
  });
});

/**
 * FR-R3-072 — the runner cannot report a pass it did not run.
 *
 * The runner fabricated a liveProbe result whenever a credential env var was
 * set, so exporting ANTHROPIC_API_KEY made the canary report `ok` for a live
 * phase that does not exist. These tests pin the fix: the runner's whole
 * decision is `runnerBackendResult`, it constructs no probe result, and no
 * input it can receive reaches `ok`.
 */
describe('the runner cannot report a pass it did not run', () => {
  // Every input the runner can hand the decision: the credential env var is
  // unset, empty, or set; the version probe succeeded, failed, or never ran.
  const credentialValues: Array<string | undefined> = [undefined, '', 'a-real-looking-secret'];
  const versionProbes = [version('1.2.3'), { ok: false, detail: 'ENOENT' }, null];

  it('never reports ok from any runner-reachable input', () => {
    for (const credentialValue of credentialValues) {
      for (const versionProbe of versionProbes) {
        const verdict = canary.runnerBackendResult({
          backend: 'claude',
          versionProbe,
          credentialValue
        });
        expect(verdict.state).not.toBe('ok');
        expect(canary.PROBE_STATES).toContain(verdict.state);
      }
    }
  });

  it('names what a credentialed skip leaves unestablished', () => {
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      credentialValue: 'a-real-looking-secret'
    });
    expect(verdict.state).toBe('skipped-no-live-path');
    expect(verdict.detail).toContain('credential is present');
    expect(verdict.detail).toContain('no live invocation is implemented');
    for (const unestablished of ['protocol', 'auth', 'prompt', 'cost']) {
      expect(verdict.detail).toContain(unestablished);
    }
  });

  it('treats an empty-string credential as absent', () => {
    // `KEY=` in a workflow env block is a missing secret, not a present one.
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      credentialValue: ''
    });
    expect(verdict.state).toBe('skipped-no-credentials');
  });

  it('counts both skip states as version-probe-only in the report', () => {
    const report = canary.formatReport([
      { backend: 'claude', state: 'skipped-no-live-path', detail: 'd' },
      { backend: 'codex', state: 'skipped-no-credentials', detail: 'd' }
    ]);
    expect(report).toContain('2 backend(s) ran the version probe only');
    expect(report).toContain('No behavioural claim');
  });

  it('contains no fabricated live-probe result in the canary sources', () => {
    // The defect was the literal `'live phase reached'` attached to a probe
    // result no probe produced. Reads exactly the two canary sources; the
    // literal in THIS file is the assertion's own needle, not a match.
    // Widened from the two canary files to the whole scripts/ directory after
    // review: the literal's realistic reintroduction site is any script that
    // feeds the decision layer, and a two-file check would stay green for a
    // sibling. Hermetic: one readdir of a small first-party directory.
    const scriptsDir = resolve(__dirname, '../../../scripts');
    const sources = readdirSync(scriptsDir).filter((name) => /\.(mjs|mts|js|ts|sh)$/.test(name));
    expect(sources.length).toBeGreaterThan(5); // non-vacuity: the sweep saw the directory
    for (const source of sources) {
      expect(
        readFileSync(resolve(scriptsDir, source), 'utf8'),
        `${source} must not construct a live-probe result`
      ).not.toContain('live phase reached');
    }
  });
});

/**
 * FR-R3-084 — the blocked live phase, pinned so it stays blocked HONESTLY.
 *
 * The item forbids writing a live invocation that has never been run by hand,
 * and no credential exists in this checkout, so none is written. What CAN be
 * pinned is that the no-credential behaviour is unchanged and that the reasons
 * are on record rather than in someone's memory — because the failure mode here
 * is not a broken canary, it is a canary that quietly starts claiming more than
 * it ran.
 */
describe('FR-R3-084 — the live phase is blocked on an operator action, not omitted', () => {
  it('behaviour with no credential is unchanged: skipped-no-credentials, exit 0', async () => {
    const canary = await import('../../../scripts/backend-canary.mjs');
    for (const backend of ['claude', 'codex', 'agy']) {
      const result = canary.runnerBackendResult({
        backend,
        versionProbe: { ok: true, version: '1.2.3' },
        credentialValue: undefined
      });
      expect(result.state).toBe('skipped-no-credentials');
    }
    const results = ['claude', 'codex', 'agy'].map((backend) =>
      canary.runnerBackendResult({
        backend,
        versionProbe: { ok: true, version: '1.2.3' },
        credentialValue: ''
      })
    );
    // An empty-string credential is ABSENT, not present-and-broken.
    for (const result of results) expect(result.state).toBe('skipped-no-credentials');
    expect(canary.canaryExitCode(results)).toBe(0);
  });

  it('a drift still exits 0 — a finding must not become a red gate by accident', async () => {
    // FR-R3-084 §4. Non-zero stays reserved for the canary itself being broken.
    const canary = await import('../../../scripts/backend-canary.mjs');
    const drifted = canary.decideBackendState({
      versionProbe: { ok: true, version: '9.9.9' },
      credentialPresent: false,
      expectedVersionPrefix: '1.'
    });
    expect(canary.canaryExitCode([{ backend: 'claude', ...drifted }])).toBe(0);
  });

  it('the credential request itemizes every credential with scope, reader and leak cost', () => {
    const request = readFileSync(
      resolve(__dirname, '../../../docs/release/canary-credential-request.md'),
      'utf8'
    );
    for (const env of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGY_API_KEY']) {
      expect(request, `${env} must be named`).toContain(env);
    }
    expect(request).toContain('Minimum scope needed');
    expect(request).toContain('What a leak costs');
    expect(request).toContain('Read by');
    // The env var names must be the ones the runner ACTUALLY reads, or the
    // request asks for a secret nothing would consume.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    for (const env of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGY_API_KEY']) {
      expect(runner, `${env} must be what the runner reads`).toContain(env);
    }
  });

  it('no live invocation was written — the precondition is recorded instead', () => {
    // The assertion that keeps this honest. If someone later adds a live call
    // without running it by hand, this is what refuses.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // A live phase would need to spawn the CLI with a prompt. The version probe
    // is the only spawn, and it passes `--version`.
    const spawns = [...runner.matchAll(/spawnSync\([^)]*\)/g)].map((match) => match[0]);
    expect(spawns.length).toBeGreaterThan(0);
    for (const spawn of spawns) {
      expect(spawn, 'the only spawn is the version probe').toContain("'--version'");
    }
    const request = readFileSync(
      resolve(__dirname, '../../../docs/release/canary-credential-request.md'),
      'utf8'
    );
    expect(request).toContain('No live invocation');
    expect(request).toContain('precondition on an operator action');
  });

  it('the expected-version prefix is still absent, with the reason recorded', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // Nothing supplies a prefix, so drift detection stays structural.
    expect(runner).not.toMatch(/expectedVersionPrefix:\s*'[^']+'/);
    const request = readFileSync(
      resolve(__dirname, '../../../docs/release/canary-credential-request.md'),
      'utf8'
    );
    // Matched on a phrase that survives a line wrap: the document is prose and
    // a multi-word assertion that spans a wrap point is a brittle test, not a
    // strict one.
    expect(request).toContain('qualified baseline');
    expect(request).toContain('no prefix, structural drift detection');
  });
});
