import { afterEach, describe, expect, it } from 'vitest';

import { policyFingerprint } from '../../../src/contracts/process-environment-policy';
import {
  buildSpawnEnv,
  resolveProcessEnvironmentPolicy,
  sanitizeProcessEnvAllowlist
} from '../../../src/runner/spawn-env';

const TEST_NAMES = [
  'SCHEGENT_ENV_ALLOWED_TEST',
  'SCHEGENT_ENV_BLOCKED_TEST',
  'LC_SCHEGENT_TEST',
  'PATH',
  'USER'
] as const;
const ORIGINAL = new Map(TEST_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of TEST_NAMES) {
    const value = ORIGINAL.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('buildSpawnEnv', () => {
  it('preserves compatibility by inheriting ambient values by default', () => {
    process.env.SCHEGENT_ENV_BLOCKED_TEST = 'ambient-secret';

    const env = buildSpawnEnv({ env: { SCHEGENT_PHASE: 'plan' } });

    expect(env.SCHEGENT_ENV_BLOCKED_TEST).toBe('ambient-secret');
    expect(env.SCHEGENT_PHASE).toBe('plan');
  });

  it('preserves the legacy minimal opt-out exactly', () => {
    process.env.PATH = '/ambient/bin';
    process.env.SCHEGENT_ENV_BLOCKED_TEST = 'ambient-secret';

    const env = buildSpawnEnv({
      env: { SCHEGENT_PHASE: 'plan' },
      inheritProcessEnv: false
    });

    expect(env).toEqual({ SCHEGENT_PHASE: 'plan' });
  });

  it('forwards bootstrap, locale, and approved names but excludes other ambient values', () => {
    process.env.PATH = '/ambient/bin';
    process.env.SCHEGENT_ENV_ALLOWED_TEST = 'approved-value';
    process.env.SCHEGENT_ENV_BLOCKED_TEST = 'ambient-secret';
    process.env.LC_SCHEGENT_TEST = 'locale-value';

    const env = buildSpawnEnv({
      env: { PATH: '/controlled/bin', SCHEGENT_PHASE: 'plan' },
      inheritProcessEnv: false,
      processEnvAllowlist: ['SCHEGENT_ENV_ALLOWED_TEST']
    });

    expect(env.PATH).toBe('/controlled/bin');
    expect(env.SCHEGENT_ENV_ALLOWED_TEST).toBe('approved-value');
    expect(env.LC_SCHEGENT_TEST).toBe('locale-value');
    expect(env.SCHEGENT_ENV_BLOCKED_TEST).toBeUndefined();
    expect(env.SCHEGENT_PHASE).toBe('plan');
  });

  /**
   * The shipped default is `allowlist` with an EMPTY list, so this case is not an
   * edge -- it is what every operator who has configured nothing actually spawns
   * with, and `REQUIRED_PROCESS_ENV_NAMES` is the whole of it.
   *
   * `USER` was missing from that set. On macOS the Claude CLI resolves its OAuth
   * credential from the login Keychain, and that lookup identifies the account by
   * `USER`; without it the CLI finds no credential at all and exits in ~87ms with
   * `Not logged in - Please run /login`. That reads as an expired session rather
   * than a stripped environment, which is why it cost two runs to attribute.
   *
   * `HOME` alone is not enough and is the reason the failure was confusing: with
   * `HOME` forwarded the child still reads the right `~/.claude/*`, so settings,
   * plugins and skills all load correctly and only the credential is missing.
   */
  it('forwards the identity variables an OS credential store needs (default allowlist)', () => {
    process.env.USER = 'ambient-user';

    const env = buildSpawnEnv({
      env: {},
      inheritProcessEnv: false,
      processEnvAllowlist: []
    });

    expect(env.USER).toBe('ambient-user');
  });
});

describe('process environment policy', () => {
  it('accepts variable names only and removes invalid or duplicate entries', () => {
    expect(sanitizeProcessEnvAllowlist([
      'HTTPS_PROXY',
      'HTTPS_PROXY',
      'TOKEN=value',
      'bad-name',
      '',
      42
    ])).toEqual(['HTTPS_PROXY']);
  });

  it('lets the legacy false toggle force minimal mode', () => {
    expect(resolveProcessEnvironmentPolicy({
      inheritEnvironment: false,
      mode: 'allowlist',
      allowlist: ['HTTPS_PROXY']
    })).toEqual({ mode: 'minimal', inheritProcessEnv: false });
  });

  // FR-R4-F06 (FR-001, FR-002; T1; contract E, E1 and E2) -- the old case here
  // pinned the opposite: an unknown mode fell through to `inherit`, so a typo in
  // a safety setting forwarded every credential in the host environment. A
  // malformed mode now resolves to the shipped allowlist default, and only the
  // exact string `'inherit'` inherits.
  describe('a malformed mode resolves to the shipped allowlist default (T1)', () => {
    // The shape an explicit `'allowlist'` already resolves to. A malformed mode
    // must produce the same value, not a lookalike.
    const ALLOWLIST_RESULT = {
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['HTTPS_PROXY']
    } as const;
    const MALFORMED_MODES: ReadonlyArray<readonly [label: string, mode: unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', {}],
      ['an array', []],
      ['true', true],
      ['an unknown string', 'unexpected'],
      ['a typo', 'inherits'],
      ['a capitalised inherit', 'Inherit'],
      ['an upper-case inherit', 'INHERIT'],
      ['a leading-space inherit', ' inherit'],
      ['the empty string', '']
    ];

    it.each(MALFORMED_MODES)('resolves %s to allowlist', (_label, mode) => {
      expect(resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode,
        allowlist: ['HTTPS_PROXY', 'bad name']
      })).toEqual(ALLOWLIST_RESULT);
    });

    it('resolves a missing mode key to allowlist', () => {
      const input = { inheritEnvironment: true, allowlist: ['HTTPS_PROXY'] };
      expect(resolveProcessEnvironmentPolicy(input as never)).toEqual(ALLOWLIST_RESULT);
    });

    it('gives a malformed mode the same value an explicit allowlist gives', () => {
      const explicit = resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'allowlist',
        allowlist: ['HTTPS_PROXY']
      });
      for (const [, mode] of MALFORMED_MODES) {
        expect(resolveProcessEnvironmentPolicy({
          inheritEnvironment: true,
          mode,
          allowlist: ['HTTPS_PROXY']
        })).toEqual(explicit);
      }
    });

    it('still inherits for the exact string inherit', () => {
      expect(resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'inherit',
        allowlist: ['HTTPS_PROXY']
      })).toEqual({ mode: 'inherit', inheritProcessEnv: true });
    });

    it('resolves allowlist to allowlist and minimal to minimal', () => {
      expect(resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'allowlist',
        allowlist: ['HTTPS_PROXY']
      })).toEqual(ALLOWLIST_RESULT);
      expect(resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'minimal',
        allowlist: ['HTTPS_PROXY']
      })).toEqual({ mode: 'minimal', inheritProcessEnv: false });
    });

    it('lets the legacy false toggle force minimal over every mode', () => {
      const modes: readonly unknown[] = [
        'inherit',
        'allowlist',
        ...MALFORMED_MODES.map(([, mode]) => mode)
      ];
      for (const mode of modes) {
        expect(resolveProcessEnvironmentPolicy({
          inheritEnvironment: false,
          mode,
          allowlist: ['HTTPS_PROXY']
        })).toEqual({ mode: 'minimal', inheritProcessEnv: false });
      }
    });
  });
});

describe('policyFingerprint (T1; data-model section 1)', () => {
  it('names the mode and the sorted allowlist names, and nothing else', () => {
    expect(policyFingerprint({ mode: 'minimal', inheritProcessEnv: false })).toBe('minimal:');
    expect(policyFingerprint({ mode: 'inherit', inheritProcessEnv: true })).toBe('inherit:');
    expect(policyFingerprint({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['B', 'A']
    })).toBe('allowlist:A,B');
    expect(policyFingerprint({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: []
    })).toBe('allowlist:');
  });

  it('is the same for two orderings of one allowlist', () => {
    const forward = policyFingerprint({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['A', 'B']
    });
    const reversed = policyFingerprint({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['B', 'A']
    });
    expect(forward).toBe(reversed);
  });

  it('never reads the process environment', () => {
    const realEnv = process.env;
    let reads = 0;
    process.env = new Proxy(realEnv, {
      get: (target, key, receiver) => {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
      has: (target, key) => {
        reads += 1;
        return Reflect.has(target, key);
      },
      ownKeys: (target) => {
        reads += 1;
        return Reflect.ownKeys(target);
      }
    });
    try {
      policyFingerprint({
        mode: 'allowlist',
        inheritProcessEnv: false,
        processEnvAllowlist: ['PATH', 'HOME']
      });
    } finally {
      process.env = realEnv;
    }
    expect(reads).toBe(0);
  });
});
