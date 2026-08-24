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
      liveProbe: { ok: true }
    });
    expect(verdict.state).toBe('ok');
  });

  it('reports skipped-no-credentials, and says the run made no behavioural claim', () => {
    // The most common state in practice, and the one that must never read as a
    // pass. A canary that reports success because it did nothing is worse than
    // one that does not run.
    const verdict = canary.decideBackendState({ versionProbe: version('1.2.3'), liveProbe: null });
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
      liveProbe: { ok: false, detail: 'auth rejected' }
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
