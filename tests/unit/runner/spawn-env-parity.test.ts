import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpawnEnv,
  policyRequestFields,
  type ProcessEnvironmentPolicy
} from '../../../src/runner/spawn-env';
import type { InvocationRequest } from '../../../src/runner/invocation-result';
import { ENV_POLICY_CALL_SITES } from '../../fixtures/env-policy-call-sites';

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

/**
 * Names a CLI needs to start at all; a restriction that drops these is an outage.
 *
 * `USER` joined the pair on 2026-08-31. It is here rather than only in
 * `spawn-env.test.ts` because the outage it caused was per call site: the macOS
 * Keychain lookup that resolves the CLI's OAuth credential identifies the account
 * by `USER`, so any site that forwards a policy without it spawns a child that
 * cannot authenticate — while still reading the right `~/.claude` through `HOME`,
 * which is what made it present as an expired login instead of a stripped spawn.
 */
const BOOTSTRAP = ['PATH', 'HOME', 'USER'] as const;

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
    name: ENV_POLICY_CALL_SITES[0],
    request: (p) => ({
      env: { SCHEGENT_PHASE: 'implement' },
      // The same helper production calls, so this model cannot drift from it.
      ...policyRequestFields(p)
    })
  },
  {
    name: ENV_POLICY_CALL_SITES[1],
    request: (p) => ({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' },
      ...policyRequestFields(p)
    })
  },
  {
    name: ENV_POLICY_CALL_SITES[2],
    request: (p) => ({
      ...policyRequestFields(p)
    })
  }
];

describe('every production call site obeys the policy (SC-002)', () => {
  it('models every call site the lint guard enumerates', () => {
    // The shared list is what the two gates cross-check through, so a site added
    // to one and not the other fails here rather than shrinking coverage quietly.
    // It lives in `tests/fixtures/` and not in either test file: importing a
    // `*.test.ts` from another test file re-registers its suites in the importer,
    // which ran this file's fourteen cases twice.
    expect(CALL_SITES.map((site) => site.name)).toEqual([...ENV_POLICY_CALL_SITES]);
  });

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

  it('inherit-nothing yields the overlay and nothing ambient — bootstrap included', () => {
    const env = buildSpawnEnv({ env: { ONLY: 'this' }, inheritProcessEnv: false });
    expect(sentinelsIn(env)).toBe(0);
    expect(env.ONLY).toBe('this');
    // Pinned deliberately: inherit-nothing drops the bootstrap names too, so a
    // bare `cli.path` cannot be resolved under it at any call site. That is the
    // shipped meaning of the mode, and threading the policy into the poll brings
    // the poll under it. Asserting it here is what stops the spec's "bootstrap
    // names survive every mode" reading from re-appearing as an untested claim.
    for (const name of BOOTSTRAP) expect(name in env).toBe(false);
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

describe('the change is strictly narrowing (security)', () => {
  /**
   * The security property the whole feature rests on: threading a policy must
   * never let a spawn read MORE than it read before. This is the direction that
   * would turn a privacy fix into a privacy regression, and it is not obvious by
   * inspection — the watchdog's environment changes shape entirely, so "smaller"
   * has to be demonstrated rather than assumed.
   *
   * The complementary risk — a restriction so tight the CLI cannot start — is
   * covered by the bootstrap-name cases above and, for inherit-nothing mode, is a
   * pre-existing defect on all three paths that is filed as its own item.
   */
  const MODES: ReadonlyArray<readonly [string, ProcessEnvironmentPolicy]> = [
    ['allowlist excluding the sentinels', { mode: 'allowlist', inheritProcessEnv: false, processEnvAllowlist: ['ANTHROPIC_API_KEY'] }],
    ['allowlist including one sentinel', { mode: 'allowlist', inheritProcessEnv: false, processEnvAllowlist: ['NPM_TOKEN'] }],
    ['inherit-nothing', { mode: 'minimal', inheritProcessEnv: false }],
    ['inherit (the documented default)', { mode: 'inherit', inheritProcessEnv: true }]
  ];

  for (const [modeName, policy] of MODES) {
    it(`no call site reads more than it did before: ${modeName}`, () => {
      for (const site of CALL_SITES) {
        // "Before" for the watchdog was forwarding nothing at all; for the other
        // two it was the same hand-rolled spread the helper now produces.
        const beforeKeys = new Set(
          Object.keys(buildSpawnEnv(site.name === 'credit watchdog poll' ? {} : site.request(policy)))
        );
        const afterKeys = Object.keys(buildSpawnEnv(site.request(policy)));
        const widened = afterKeys.filter((key) => !beforeKeys.has(key));
        expect(widened).toEqual([]);
      }
    });
  }
});
