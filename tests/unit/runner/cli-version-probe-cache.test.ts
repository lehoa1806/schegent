import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  CLI_VERSION_TTL_MS,
  cliVersionCacheKey,
  createCliVersionProbe
} from '../../../src/runner/cli-version-probe';
import type { ProcessEnvironmentPolicy } from '../../../src/runner/spawn-env';

/**
 * FR-R4-F06 (FR-005, SC-002; T3; contract E, E5) -- the version cache follows the
 * policy.
 *
 * The cache was keyed by `cliPath` alone, so a version observed under one environment
 * policy was served to a lookup under another for the whole ten-minute TTL. Today the
 * policy is resolved once at activation and a change needs a reload, so the defect is
 * latent in the shipped wiring; the probe cannot know that, and a key makes the leaf
 * itself correct instead of leaving it to its one caller. The key is the path plus a
 * fingerprint of the policy's NAMES. It never holds an environment value (R3).
 *
 * Everything is injected: a counting probe and a fake clock, so no process is spawned.
 */
const ALLOWLIST_A: ProcessEnvironmentPolicy = {
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: ['HTTPS_PROXY']
};
const ALLOWLIST_B: ProcessEnvironmentPolicy = {
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: ['HTTPS_PROXY', 'NO_PROXY']
};
const INHERIT: ProcessEnvironmentPolicy = { mode: 'inherit', inheritProcessEnv: true };

function harness(initial: ProcessEnvironmentPolicy) {
  let policy = initial;
  let nowMs = 1_000;
  const spawned: string[] = [];
  let outcome: (cliPath: string) => Promise<string> = async () => '1.2.3 (Fake)';
  const probe = createCliVersionProbe({
    environmentPolicy: () => policy,
    monotonicNow: () => nowMs,
    probe: async (cliPath) => {
      spawned.push(cliPath);
      return outcome(cliPath);
    }
  });
  return {
    probe,
    spawned,
    setPolicy: (next: ProcessEnvironmentPolicy) => {
      policy = next;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    setOutcome: (next: (cliPath: string) => Promise<string>) => {
      outcome = next;
    }
  };
}

describe('the version cache is keyed by path and policy fingerprint (T3)', () => {
  it('spawns twice for one path under two fingerprints inside the TTL', async () => {
    const h = harness(ALLOWLIST_A);
    await h.probe.observe('/bin/fake-claude');
    h.setPolicy(ALLOWLIST_B);
    await h.probe.observe('/bin/fake-claude');
    expect(h.spawned).toEqual(['/bin/fake-claude', '/bin/fake-claude']);
  });

  it('spawns once for one path under one fingerprint inside the TTL', async () => {
    const h = harness(ALLOWLIST_A);
    await h.probe.observe('/bin/fake-claude');
    h.advance(CLI_VERSION_TTL_MS - 1);
    await h.probe.observe('/bin/fake-claude');
    expect(h.spawned).toHaveLength(1);
  });

  it('treats two orderings of one allowlist as one fingerprint', async () => {
    const h = harness({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['B', 'A']
    });
    await h.probe.observe('/bin/fake-claude');
    h.setPolicy({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['A', 'B']
    });
    await h.probe.observe('/bin/fake-claude');
    expect(h.spawned).toHaveLength(1);
  });

  it('probes again once the TTL has passed, as before', async () => {
    const h = harness(ALLOWLIST_A);
    await h.probe.observe('/bin/fake-claude');
    h.advance(CLI_VERSION_TTL_MS);
    await h.probe.observe('/bin/fake-claude');
    expect(h.spawned).toHaveLength(2);
  });

  it('caches a failure for its own key only', async () => {
    const h = harness(ALLOWLIST_A);
    h.setOutcome(async () => {
      throw new Error('not runnable');
    });
    expect(await h.probe.observe('/bin/fake-claude')).toBeNull();
    // Same key: the cached failure is served, with no second spawn.
    expect(await h.probe.observe('/bin/fake-claude')).toBeNull();
    expect(h.spawned).toHaveLength(1);

    // Another key: the failure is not served; the probe runs and now succeeds.
    h.setOutcome(async () => '4.5.6');
    h.setPolicy(INHERIT);
    expect(await h.probe.observe('/bin/fake-claude')).toBe('4.5.6');
    expect(h.spawned).toHaveLength(2);
  });

  it('shares one in-flight spawn between concurrent lookups under one key', async () => {
    const h = harness(ALLOWLIST_A);
    let release: (stdout: string) => void = () => undefined;
    h.setOutcome(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const first = h.probe.observe('/bin/fake-claude');
    const second = h.probe.observe('/bin/fake-claude');
    await Promise.resolve();
    release('7.8.9');
    expect(await Promise.all([first, second])).toEqual(['7.8.9', '7.8.9']);
    expect(h.spawned).toHaveLength(1);
  });

  it('does not share an in-flight spawn between two keys', async () => {
    const h = harness(ALLOWLIST_A);
    const releases: Array<(stdout: string) => void> = [];
    h.setOutcome(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        })
    );
    const first = h.probe.observe('/bin/fake-claude');
    h.setPolicy(INHERIT);
    const second = h.probe.observe('/bin/fake-claude');
    await Promise.resolve();
    expect(h.spawned).toHaveLength(2);
    for (const release of releases) release('1.0.0');
    await Promise.all([first, second]);
  });

  it('never puts an environment value into the cache key', () => {
    const secretName = `SCHEGENT_TEST_SECRET_${randomBytes(6).toString('hex').toUpperCase()}`;
    const secretValue = randomBytes(12).toString('hex');
    process.env[secretName] = secretValue;
    try {
      const key = cliVersionCacheKey('/bin/fake-claude', {
        mode: 'allowlist',
        inheritProcessEnv: false,
        processEnvAllowlist: [secretName]
      });
      // The variable's NAME is part of the policy and so of its fingerprint. Its
      // VALUE is ambient state the key must never see.
      const separator = String.fromCharCode(0);
      expect(key.split(separator)).toEqual(['/bin/fake-claude', `allowlist:${secretName}`]);
      expect(key).not.toContain(secretValue);
    } finally {
      delete process.env[secretName];
    }
  });
});
