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
      liveProbe: { ok: true }
    });
    expect(verdict.state).toBe('ok');
  });

  it('reports skipped-not-authenticated, and says the run made no behavioural claim', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, notAuthenticated: true, detail: 'not signed in' }
    });
    expect(verdict.state).toBe('skipped-not-authenticated');
    for (const unestablished of ['protocol', 'auth', 'prompt', 'cost']) {
      expect(verdict.detail).toContain(unestablished);
    }
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
      { backend: 'claude', state: 'skipped-not-authenticated', detail: 'd' },
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
  // REWRITTEN 2026-08-26. This block used to assert that `ok` was unreachable
  // from every runner-reachable input, because no live invocation existed. One
  // does now, it has been run by hand against two authenticated CLIs, and `ok` is
  // reachable on purpose. Asserting it is still unreachable would pin the absence
  // of the feature rather than the safety of it.
  //
  // What still holds, and is what actually mattered: `ok` requires BOTH a
  // positive authentication answer and a real live-probe result. Neither alone,
  // and neither fabricated.
  const versionProbes = [version('1.2.3'), { ok: false, detail: 'ENOENT' }, null];

  it('never reports ok without a live probe result', () => {
    for (const versionProbe of versionProbes) {
      const verdict = canary.runnerBackendResult({ backend: 'claude', versionProbe });
      expect(verdict.state).not.toBe('ok');
      expect(canary.PROBE_STATES).toContain(verdict.state);
    }
  });

  it('never reports ok without a live probe result', () => {
    // `ok` is a claim that a turn completed. Nothing but a real live result may
    // produce it — the defect this block was originally written for was a
    // fabricated probe result attached to a phase that never ran.
    for (const versionProbe of versionProbes) {
      const verdict = canary.runnerBackendResult({ backend: 'claude', versionProbe });
      expect(verdict.state).not.toBe('ok');
      expect(canary.PROBE_STATES).toContain(verdict.state);
    }
  });

  it('reports ok only from a real live probe result', () => {
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: true, detail: 'answered in 6 chars' }
    });
    expect(verdict.state).toBe('ok');
  });

  it('names what an unauthenticated skip leaves unestablished', () => {
    const verdict = canary.runnerBackendResult({
      backend: 'agy',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, notAuthenticated: true, detail: 'not signed in' }
    });
    expect(verdict.state).toBe('skipped-not-authenticated');
    expect(verdict.detail).toContain('not signed in');
    for (const unestablished of ['protocol', 'auth', 'prompt', 'cost']) {
      expect(verdict.detail).toContain(unestablished);
    }
  });

  it('treats an unrecognised failure as drift, not as a skip', () => {
    // A skip is a shrug nobody reads. A failure this canary cannot explain is a
    // finding, and calling it "probably just auth" would convert real protocol
    // drift into silence — which is what the classifier is kept narrow to avoid.
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, detail: 'exit 7' }
    });
    expect(verdict.state).toBe('drifted');
  });

  it('reads a sign-in refusal out of real CLI output, and nothing wider', () => {
    // Fixtures are the ACTUAL strings observed on 2026-08-26. `agy models`
    // printed its refusal beside exit 0, which is why output is the signal and
    // status is not.
    expect(canary.saysNotAuthenticated('Error: Please sign in to view available models.', '')).toBe(
      true
    );
    expect(canary.saysNotAuthenticated('', 'Not logged in')).toBe(true);
    expect(canary.saysNotAuthenticated('unauthorized', '')).toBe(true);
    // Narrow on purpose: an ordinary failure must NOT be excused as auth.
    expect(canary.saysNotAuthenticated('exit 7', '')).toBe(false);
    expect(canary.saysNotAuthenticated('canary', '')).toBe(false);
    expect(canary.saysNotAuthenticated('', '')).toBe(false);
  });


  it('counts both skip states as version-probe-only in the report', () => {
    const report = canary.formatReport([
      { backend: 'claude', state: 'skipped-no-live-path', detail: 'd' },
      { backend: 'codex', state: 'skipped-not-authenticated', detail: 'd' }
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
describe('FR-R3-084 — the live phase, written after it was run', () => {
  // REWRITTEN 2026-08-26, and the reason is the point of the item.
  //
  // This block used to pin that NO live invocation existed and that the reason
  // was recorded — because the item forbids shipping a live call that has never
  // run. That guard did its job: it stood until the call had actually been made.
  //
  // The premise it rested on was wrong, and the operator said so: these backends
  // authenticate by SUBSCRIPTION, not by API key. `claude auth status` reports
  // `authMethod: "claude.ai"`, `codex login status` reports "Logged in using
  // ChatGPT", and no `*_API_KEY` variable exists on the machine this is developed
  // on. The canary had been asking whether a key was set as a proxy for whether a
  // live call was possible, and the proxy was false while the truth was true.
  //
  // The live phase was then written, RUN BY HAND, and observed:
  //   claude: ok — version 2.1.246, live probe passed
  //   codex:  ok — version 0.149.0, live probe passed
  //   agy:    skipped-not-authenticated — not signed in on this machine
  //
  // So what is pinned now is what still needs protecting: `ok` requires a real
  // live result, the prompt discloses nothing, the deadline is bounded, and a
  // drift is never an exit code.
  it('the live invocation is bounded, fixed, and discloses nothing', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // One turn, a fixed trivial prompt, and a hard wall-clock deadline. A prompt
    // built from anything in the workspace would send workspace content to a
    // provider, which is the failure this pins against.
    expect(runner).toContain("const CANARY_PROMPT = 'Reply with exactly one word: canary'");
    expect(runner).toMatch(/LIVE_TIMEOUT_MS\s*=\s*\d/);
    expect(runner).toContain('timeout: LIVE_TIMEOUT_MS');
    // The prompt is a constant, never interpolated.
    expect(runner).not.toMatch(/CANARY_PROMPT\s*\+/);
    expect(runner).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*`\s*\]\s*\}/);
  });

  it('reads no API key, because none is what this product uses', () => {
    // The correction of 2026-08-26. A request for a secret nothing consumes is
    // worse than no request: it asks an operator to create a live credential for
    // no reason.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    for (const env of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGY_API_KEY']) {
      expect(runner, `${env} is not how these CLIs authenticate here`).not.toContain(env);
    }
    expect(runner).toContain('auth');
  });

  it('never asks a CLI that is not installed for a turn', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // The only ordering left. There is no auth gate, because the auth gate was a
    // proxy and proxies were the defect twice over — see backend-canary.mjs.
    expect(runner).toContain('version.ok === true ? liveProbe(');
    expect(runner).not.toContain('authProbe');
  });

  it('skipped-no-live-path is unreachable: every backend has a live path', () => {
    // FR-R3-084 §4, verbatim: "`skipped-no-live-path` becomes unreachable for a
    // backend that has one, and the unit table asserts that." All three have one
    // now, so the state survives only for a backend added without one — which is
    // exactly when it should fire, and never for the three that ship.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    const declared = [...runner.matchAll(/backend: '([a-z]+)'/g)].map((m) => m[1]);
    const withLivePath = [...runner.matchAll(/backend: '[a-z]+',[^}]*live: \[/g)].length;
    expect(declared.sort()).toEqual(['agy', 'claude', 'codex']);
    expect(withLivePath, 'every declared backend needs a live path').toBe(declared.length);
  });

  it('a drift is a finding, never an exit code', async () => {
    const canary = await import('../../../scripts/backend-canary.mjs');
    expect(
      canary.canaryExitCode([{ backend: 'claude', state: 'drifted', detail: 'd' }])
    ).toBe(0);
    expect(
      canary.canaryExitCode([{ backend: 'agy', state: 'skipped-not-authenticated', detail: 'd' }])
    ).toBe(0);
  });

  it('the qualification run is recorded, and no prefix is enforced from it', () => {
    const request = readFileSync(
      resolve(__dirname, '../../../docs/release/canary-credential-request.md'),
      'utf8'
    );
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // A first observation on one machine is not a qualified baseline, and pinning
    // a prefix from it would make every routine CLI update report drift. The run
    // is recorded as evidence; the pin stays absent, which is what the item asks.
    expect(request).toContain('2026-08-26');
    expect(request).toContain('2.1.246');
    expect(runner).not.toMatch(/expectedVersionPrefix:\s*'[^']+'/);
  });
});
