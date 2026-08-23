import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpawnEnv,
  policyRequestFields,
  type ProcessEnvironmentPolicy
} from '../../../src/runner/spawn-env';
import type { InvocationRequest } from '../../../src/runner/invocation-result';

/**
 * FR-R3-049 / M-11 — the operator's environment policy must reach every spawn.
 *
 * WHY THIS FILE ASSERTS PER CALL SITE
 *
 * Three production call sites spawn a backend CLI. Two forwarded the policy; the
 * credit watchdog's automatic `/status` poll forwarded none of the three fields,
 * so `buildSpawnEnv` fell through every branch and returned `process.env` itself.
 *
 * An aggregate assertion would have PASSED on that code: two of three sites were
 * correct, so the behaviour looked correct. So every case below names its call
 * site, and the guard in tests/lint asserts the same three sites forward a policy.
 * Neither half is the claim on its own -- this file proves that forwarding a given
 * policy yields the intended environment, and the guard proves each site forwards.
 * A unit test cannot drive the phase runner without becoming an integration test,
 * so it models each site's request; the guard is what closes that gap.
 *
 * SENTINELS
 *
 * Credential-shaped NAMES with obviously synthetic values, and assertions that
 * compare a presence COUNT rather than a value. A test that prints the credential
 * it protects leaks in CI.
 */

const SENTINEL_NAMES = ['AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'ARTIFACT_SIGNING_KEY'] as const;
const SENTINEL_VALUE = 'not-a-real-credential-synthetic-fixture';

/** Names a CLI needs to start at all; a restriction that drops these is an outage. */
const BOOTSTRAP = ['PATH', 'HOME'] as const;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const name of SENTINEL_NAMES) process.env[name] = SENTINEL_VALUE;
  for (const name of BOOTSTRAP) process.env[name] = process.env[name] ?? '/fixture';
});

afterEach(() => {
  // Restored wholesale: one case must not be able to poison the next.
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** How many sentinels a computed environment leaked. Never the values. */
function sentinelsIn(env: NodeJS.ProcessEnv): number {
  return SENTINEL_NAMES.filter((name) => name in env).length;
}

type PolicyFields = Pick<InvocationRequest, 'env' | 'inheritProcessEnv' | 'processEnvAllowlist'>;

/** The allowlist an operator would configure: names one variable, none of them sentinels. */
const RESTRICTIVE: ProcessEnvironmentPolicy = {
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: ['ANTHROPIC_API_KEY']
};

/** What each production call site forwards, modelled. See the header note. */
const CALL_SITES: ReadonlyArray<{ name: string; request: (p: ProcessEnvironmentPolicy) => PolicyFields }> = [
  {
    name: 'phase runner',
    request: (p) => ({
      env: { SCHEGENT_PHASE: 'implement' },
      // The same helper production calls, so this model cannot drift from it.
      ...policyRequestFields(p)
    })
  },
  {
    name: 'session compactor',
    request: (p) => ({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' },
      ...policyRequestFields(p)
    })
  },
  {
    name: 'credit watchdog poll',
    request: (p) => ({
      ...policyRequestFields(p)
    })
  }
];

/** The parity test's own count, cross-checked by the lint guard so neither can shrink silently. */
export const PARITY_CALL_SITE_COUNT = CALL_SITES.length;

describe('every production call site obeys the policy (SC-002)', () => {
  for (const site of CALL_SITES) {
    it(`leaks no unlisted sentinel: ${site.name}`, () => {
      expect(sentinelsIn(buildSpawnEnv(site.request(RESTRICTIVE)))).toBe(0);
    });

    it(`keeps the bootstrap names it needs to start: ${site.name}`, () => {
      // The direction in which this feature can do harm is a restriction that is
      // too tight, which is an outage rather than a leak.
      const env = buildSpawnEnv(site.request(RESTRICTIVE));
      for (const name of BOOTSTRAP) expect(name in env).toBe(true);
    });
  }
});

describe('the fix restricts to the policy, it does not ignore it (SC-003)', () => {
  it('delivers a variable the allowlist names', () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-allowlisted-value';
    const env = buildSpawnEnv({ processEnvAllowlist: ['ANTHROPIC_API_KEY'] });
    expect('ANTHROPIC_API_KEY' in env).toBe(true);
    expect(sentinelsIn(env)).toBe(0);
  });

  it('inherit-nothing yields the overlay and nothing ambient', () => {
    const env = buildSpawnEnv({ env: { ONLY: 'this' }, inheritProcessEnv: false });
    expect(sentinelsIn(env)).toBe(0);
    expect(env.ONLY).toBe('this');
  });

  it('no configured policy inherits — the documented default is unchanged (FR-005)', () => {
    // This is what the watchdog was doing WRONGLY, and what a request with no
    // policy still does RIGHTLY: the defect was the watchdog ignoring a
    // configured policy, not the default itself.
    expect(sentinelsIn(buildSpawnEnv({}))).toBe(SENTINEL_NAMES.length);
  });

  it('does not materialise an allowlisted name that is absent (FR-018)', () => {
    delete process.env.DEFINITELY_ABSENT_NAME;
    const env = buildSpawnEnv({ processEnvAllowlist: ['DEFINITELY_ABSENT_NAME'] });
    expect('DEFINITELY_ABSENT_NAME' in env).toBe(false);
  });

  it('lets the overlay win over an allowlisted value of the same name (FR-019)', () => {
    process.env.SHARED_NAME = 'ambient';
    const env = buildSpawnEnv({
      env: { SHARED_NAME: 'overlay' },
      processEnvAllowlist: ['SHARED_NAME']
    });
    expect(env.SHARED_NAME).toBe('overlay');
  });
});

describe('the live environment is never handed to a spawn (SC-007)', () => {
  it('returns a copy, not process.env itself', () => {
    expect(buildSpawnEnv({})).not.toBe(process.env);
  });

  it('mutating a built environment leaves process.env alone', () => {
    const env = buildSpawnEnv({});
    env.INJECTED_BY_TEST = 'x';
    expect('INJECTED_BY_TEST' in process.env).toBe(false);
  });

  it('copies contents faithfully — identity changes, contents do not', () => {
    const env = buildSpawnEnv({});
    expect(env.PATH).toBe(process.env.PATH);
    expect(Object.keys(env).length).toBe(Object.keys(process.env).length);
  });
});
