import { afterEach, describe, expect, it } from 'vitest';

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

  it('falls back to compatibility inheritance for an invalid mode', () => {
    expect(resolveProcessEnvironmentPolicy({
      inheritEnvironment: true,
      mode: 'unexpected',
      allowlist: []
    })).toEqual({ mode: 'inherit', inheritProcessEnv: true });
  });
});
