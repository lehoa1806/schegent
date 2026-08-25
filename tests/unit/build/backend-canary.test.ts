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
