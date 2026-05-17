// Feature 012 — sanitized reader for `schegent.claude.autoCompactPctOverride`.
//
// Covers:
//   - `readAutoCompactPctOverride` returns `undefined` for unset / null /
//     non-integer / out-of-range / wrong-type values.
//   - The integer in `[1, 100]` is returned verbatim.
//   - The `warn-once` cache de-duplicates by `<cause>:<valueStr>`; the
//     warning fires exactly once per unique cause+value across many reads.
//   - The accessor factory threads through the configProvider and is
//     never cached internally.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readAutoCompactPctOverride,
  createAutoCompactOverrideAccessor,
  __resetAutoCompactOverrideWarnCache
} from '../../../src/lib/auto-compact-override';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { GeneralSettingsConfig } from '../../../src/config/general-settings';

class FakeConfig {
  constructor(private readonly raw: unknown) {}

  get<T>(_key: string, fallback: T): T {
    return (this.raw === undefined ? fallback : (this.raw as unknown)) as T;
  }

  inspect<T>(_key: string):
    | {
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      }
    | undefined {
    return undefined;
  }

  update(): Promise<void> {
    return Promise.resolve();
  }
}

function makeConfig(raw: unknown): GeneralSettingsConfig {
  return new FakeConfig(raw) as unknown as GeneralSettingsConfig;
}

function makeLogger(): { logger: SanitizedLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger = new SanitizedLogger();
  // Override `warn` directly to observe call counts without setting up sinks.
  (logger as unknown as { warn: (m: string) => void }).warn = warn;
  return { logger, warn };
}

describe('Feature 012 — readAutoCompactPctOverride accepts valid integers', () => {
  beforeEach(() => __resetAutoCompactOverrideWarnCache());

  it.each([1, 50, 80, 99, 100])('returns %s for valid integers in [1,100]', (value) => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(value), logger)).toBe(value);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Feature 012 — readAutoCompactPctOverride rejects bad values', () => {
  beforeEach(() => __resetAutoCompactOverrideWarnCache());

  it('returns undefined for unset (config returns undefined)', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(undefined), logger)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined for null (cleared) without warning', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(null), logger)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns on non-integer numbers (50.5)', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(50.5), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-an-integer'));
  });

  it('returns undefined and warns on out-of-range low (0)', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(0), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('out-of-range'));
  });

  it('returns undefined and warns on out-of-range high (101)', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(101), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('out-of-range'));
  });

  it('returns undefined and warns on non-number ("abc")', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig('abc'), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong-type'));
  });

  it('returns undefined and warns on NaN', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(NaN), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong-type'));
  });

  it('returns undefined and warns on Infinity', () => {
    const { logger, warn } = makeLogger();
    expect(readAutoCompactPctOverride(makeConfig(Number.POSITIVE_INFINITY), logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('Feature 012 — warn-once de-duplication', () => {
  beforeEach(() => __resetAutoCompactOverrideWarnCache());

  it('warns exactly once for the same cause+value across many reads', () => {
    const { logger, warn } = makeLogger();
    for (let i = 0; i < 5; i++) {
      readAutoCompactPctOverride(makeConfig(101), logger);
    }
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns separately for distinct causes (out-of-range vs not-an-integer)', () => {
    const { logger, warn } = makeLogger();
    readAutoCompactPctOverride(makeConfig(0), logger);
    readAutoCompactPctOverride(makeConfig(0.5), logger);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns separately for distinct values of the same cause (101 vs 200)', () => {
    const { logger, warn } = makeLogger();
    readAutoCompactPctOverride(makeConfig(101), logger);
    readAutoCompactPctOverride(makeConfig(200), logger);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('Feature 012 — createAutoCompactOverrideAccessor re-reads via thunk', () => {
  beforeEach(() => __resetAutoCompactOverrideWarnCache());

  it('invokes the configProvider on every call (never cached)', () => {
    const { logger } = makeLogger();
    let current: unknown = 50;
    const provider = vi.fn(() => makeConfig(current));
    const accessor = createAutoCompactOverrideAccessor(provider, logger);

    expect(accessor.readAutoCompactPctOverride()).toBe(50);
    current = 80;
    expect(accessor.readAutoCompactPctOverride()).toBe(80);
    current = undefined;
    expect(accessor.readAutoCompactPctOverride()).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(3);
  });
});
