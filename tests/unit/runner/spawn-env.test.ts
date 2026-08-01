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
  'PATH'
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
