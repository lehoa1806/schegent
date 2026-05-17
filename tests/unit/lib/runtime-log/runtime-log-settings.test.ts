// Feature 019 — Unit tests for `readRuntimeLogSettings` +
// `createRuntimeLogAccessor` (T020).
//
// Covered behavior:
//   - Accessor returns a FRESH `{level, path}` on every call. No
//     caching: a mid-session config change must take effect on the
//     very next read.
//   - Invalid level (`'debug'` lowercase, `'TRACE'`, non-string) falls
//     back to `'INFO'` and emits exactly one WARN per cause across N
//     reads.
//   - Relative path containing `..` returns `null` plus a one-shot
//     WARN; absolute paths pass through unchanged.
//   - The warn-once cache is `__resetRuntimeLogAccessorWarnCache()`
//     able for isolated test runs.

import { describe, it, expect, beforeEach } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  createRuntimeLogAccessor,
  readRuntimeLogSettings,
  __resetRuntimeLogAccessorWarnCache
} from '../../../../src/lib/runtime-log/runtime-log-settings';
import type { GeneralSettingsConfig } from '../../../../src/config/general-settings';

function makeConfig(state: {
  level?: unknown;
  pathValue?: unknown;
}): GeneralSettingsConfig {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (key === 'logging.runtimeLogLevel') {
        return (state.level !== undefined
          ? state.level
          : defaultValue) as T;
      }
      if (key === 'logging.runtimeLogFilePath') {
        return (state.pathValue !== undefined
          ? state.pathValue
          : defaultValue) as T;
      }
      return defaultValue as T;
    },
    update: async () => undefined
  } as unknown as GeneralSettingsConfig;
}

function makeLogger(): SanitizedLogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = new SanitizedLogger() as SanitizedLogger & {
    warnings: string[];
  };
  const orig = logger.warn.bind(logger);
  logger.warn = (msg: string) => {
    warnings.push(msg);
    orig(msg);
  };
  logger.warnings = warnings;
  return logger;
}

beforeEach(() => {
  __resetRuntimeLogAccessorWarnCache();
});

describe('readRuntimeLogSettings — happy path', () => {
  it('returns canonical level + absolute path unchanged', () => {
    const cfg = makeConfig({ level: 'WARN', pathValue: '/var/log/x.log' });
    const result = readRuntimeLogSettings(cfg, '/workspace', makeLogger());
    // Feature 056 Track 9 — the rotation fields default through the
    // accessor's clamp when the config key is absent. `toMatchObject`
    // here keeps this test focused on the original assertion (level +
    // path) while tolerating the additive rotation fields.
    expect(result).toMatchObject({ level: 'WARN', path: '/var/log/x.log' });
    expect(result?.maxBytes).toBe(5 * 1024 * 1024);
    expect(result?.maxGenerations).toBe(3);
  });

  it('defaults level to INFO when config returns the default sentinel', () => {
    const cfg = makeConfig({}); // level falls back to default INFO
    const result = readRuntimeLogSettings(
      cfg,
      '/workspace',
      makeLogger()
    );
    expect(result?.level).toBe('INFO');
  });

  it('resolves empty path to <workspaceRoot>/.schegent/syslog', () => {
    const cfg = makeConfig({ level: 'INFO', pathValue: '' });
    const result = readRuntimeLogSettings(cfg, '/work', makeLogger());
    expect(result?.path).toMatch(/.*\/work\/.schegent\/syslog$/);
  });
});

describe('readRuntimeLogSettings — invalid level fallback to INFO', () => {
  it('lowercase "debug" → INFO + one WARN', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'debug', pathValue: '/abs.log' });
    const r = readRuntimeLogSettings(cfg, null, logger);
    expect(r?.level).toBe('INFO');
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogLevel'))
    ).toHaveLength(1);
  });

  it('non-standard "TRACE" → INFO + one WARN', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'TRACE', pathValue: '/abs.log' });
    const r = readRuntimeLogSettings(cfg, null, logger);
    expect(r?.level).toBe('INFO');
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogLevel'))
    ).toHaveLength(1);
  });

  it('numeric value (wrong type) → INFO + one WARN', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 42, pathValue: '/abs.log' });
    const r = readRuntimeLogSettings(cfg, null, logger);
    expect(r?.level).toBe('INFO');
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogLevel'))
    ).toHaveLength(1);
  });

  it('WARN fires exactly once across N reads of the same bad level', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'TRACE', pathValue: '/abs.log' });
    for (let i = 0; i < 5; i++) {
      readRuntimeLogSettings(cfg, null, logger);
    }
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogLevel'))
    ).toHaveLength(1);
  });

  it('Different bad-level causes WARN separately (wrong-type vs unrecognized)', () => {
    const logger = makeLogger();
    const cfg1 = makeConfig({ level: 'TRACE', pathValue: '/abs.log' });
    const cfg2 = makeConfig({ level: 42, pathValue: '/abs.log' });
    readRuntimeLogSettings(cfg1, null, logger);
    readRuntimeLogSettings(cfg2, null, logger);
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogLevel'))
    ).toHaveLength(2);
  });
});

describe('readRuntimeLogSettings — invalid path fallback to null', () => {
  it('relative path with `..` → null + one WARN', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'INFO', pathValue: '../leaky.log' });
    const r = readRuntimeLogSettings(cfg, '/work', logger);
    expect(r).toBeNull();
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogFilePath'))
    ).toHaveLength(1);
  });

  it('relative path without workspace → null + one WARN', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'INFO', pathValue: 'sub/dir.log' });
    const r = readRuntimeLogSettings(cfg, null, logger);
    expect(r).toBeNull();
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogFilePath'))
    ).toHaveLength(1);
  });

  it('absolute path passes through even without workspace', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'INFO', pathValue: '/tmp/abs.log' });
    const r = readRuntimeLogSettings(cfg, null, logger);
    expect(r).not.toBeNull();
    expect(r?.path).toBe('/tmp/abs.log');
    expect(logger.warnings).toHaveLength(0);
  });

  it('WARN fires once across N reads of the same bad path', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'INFO', pathValue: '../escape.log' });
    for (let i = 0; i < 4; i++) {
      readRuntimeLogSettings(cfg, '/work', logger);
    }
    expect(
      logger.warnings.filter((w) => w.includes('runtimeLogFilePath'))
    ).toHaveLength(1);
  });
});

describe('createRuntimeLogAccessor — per-call freshness', () => {
  it('reflects mutations to the underlying state on every read', () => {
    const state: { level: unknown; pathValue: unknown } = {
      level: 'INFO',
      pathValue: '/a.log'
    };
    const logger = makeLogger();
    const accessor = createRuntimeLogAccessor(
      () => makeConfig(state),
      () => null,
      logger
    );

    expect(accessor.read()).toMatchObject({ level: 'INFO', path: '/a.log' });

    state.level = 'WARN';
    state.pathValue = '/b.log';
    expect(accessor.read()).toMatchObject({ level: 'WARN', path: '/b.log' });

    state.level = 'DEBUG';
    expect(accessor.read()?.level).toBe('DEBUG');
  });

  it('reflects a workspace-folder transition without recreating the accessor', () => {
    let workspaceRoot: string | null = null;
    const cfg = makeConfig({ level: 'INFO', pathValue: 'rel.log' });
    const logger = makeLogger();
    const accessor = createRuntimeLogAccessor(
      () => cfg,
      () => workspaceRoot,
      logger
    );

    // No workspace + relative path → null.
    expect(accessor.read()).toBeNull();

    // Operator opens a folder; the same accessor now resolves.
    workspaceRoot = '/opened';
    const r = accessor.read();
    expect(r).not.toBeNull();
    expect(r?.path).toMatch(/^\/opened\/rel\.log$/);
  });
});

describe('__resetRuntimeLogAccessorWarnCache', () => {
  it('clears the cache so the next bad read re-warns', () => {
    const logger = makeLogger();
    const cfg = makeConfig({ level: 'TRACE', pathValue: '/abs.log' });
    readRuntimeLogSettings(cfg, null, logger);
    expect(logger.warnings).toHaveLength(1);

    __resetRuntimeLogAccessorWarnCache();
    readRuntimeLogSettings(cfg, null, logger);
    expect(logger.warnings).toHaveLength(2);
  });
});
