// Feature 031 T005 — unit tests for the new `model` field on
// `WakeUpSettings` and the matching `'invalid-model'` validator
// rejection. Mirrors the contract diff at
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-settings-ipc.diff.md.
//
// Coverage:
//   (a) `readSettings` parses `'claude-sonnet-4-6'` from the (fake)
//       settings-mirror config slice.
//   (b) `readSettings` defaults to `'runner-default'` when the slice
//       has no `wakeUp.model` key (legacy 014/024 install) OR when the
//       value is syntactically invalid (corrupted mirror file).
//   (c) `validateSettings` accepts every member of
//       `WAKEUP_SUPPORTED_MODELS` + the `'runner-default'` sentinel.
//   (d) `validateSettings` rejects an unknown identifier with
//       reason `'invalid-model'`.
//
// These tests MUST stay green after the T010-T011 implementation
// (`WakeUpSettings.model` field + validator extension) is in place.

import { describe, it, expect } from 'vitest';
import {
  readSettings,
  validateSettings,
  SettingsValidationError,
  WAKEUP_SUPPORTED_MODELS,
  RUNNER_DEFAULT_MODEL,
  type WakeUpConfig,
  type WakeUpSettings,
  type WakeUpModelSelection
} from '../../../src/wakeup/settings';

class FakeConfig implements WakeUpConfig {
  private values: Map<string, unknown> = new Map();

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(): Promise<void> {
    /* not exercised in these tests */
  }
}

function baseValidSettings(over: Partial<WakeUpSettings> = {}): WakeUpSettings {
  return {
    enabled: true,
    schedulerType: 'chronological',
    chronologicalTime: '04:00',
    periodicInterval: 'Every 4h',
    model: RUNNER_DEFAULT_MODEL,
    ...over
  };
}

describe('Feature 031 — WakeUpSettings.model field (read path)', () => {
  it('parses an explicit `claude-sonnet-4-6` from the config slice', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', 'claude-sonnet-4-6');
    const out = readSettings(cfg);
    expect(out.model).toBe('claude-sonnet-4-6');
  });

  it('parses an explicit `claude-opus-4-7` from the config slice', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', 'claude-opus-4-7');
    expect(readSettings(cfg).model).toBe('claude-opus-4-7');
  });

  it('parses an explicit `claude-haiku-4-6` from the config slice', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', 'claude-haiku-4-6');
    expect(readSettings(cfg).model).toBe('claude-haiku-4-6');
  });

  it('returns `runner-default` for a legacy slice with no `wakeUp.model` key', () => {
    const cfg = new FakeConfig();
    // Do NOT set `wakeUp.model` — simulates a 014/024 install.
    expect(readSettings(cfg).model).toBe(RUNNER_DEFAULT_MODEL);
  });

  it('returns `runner-default` for a corrupted slice (non-string value)', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', 42 as unknown as string);
    expect(readSettings(cfg).model).toBe(RUNNER_DEFAULT_MODEL);
  });

  it('returns `runner-default` for an unknown model identifier (hand-edited)', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', 'claude-bogus-9000');
    expect(readSettings(cfg).model).toBe(RUNNER_DEFAULT_MODEL);
  });

  it('returns `runner-default` for the explicit sentinel string', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.model', RUNNER_DEFAULT_MODEL);
    expect(readSettings(cfg).model).toBe(RUNNER_DEFAULT_MODEL);
  });
});

describe('Feature 031 — validateSettings (write path)', () => {
  it('accepts every member of WAKEUP_SUPPORTED_MODELS', () => {
    for (const id of WAKEUP_SUPPORTED_MODELS) {
      expect(() =>
        validateSettings(baseValidSettings({ model: id }))
      ).not.toThrow();
    }
  });

  it('accepts the `runner-default` sentinel', () => {
    expect(() =>
      validateSettings(baseValidSettings({ model: RUNNER_DEFAULT_MODEL }))
    ).not.toThrow();
  });

  it('rejects an unknown model identifier with `invalid-model`', () => {
    try {
      validateSettings(
        baseValidSettings({
          model: 'claude-bogus-9000' as unknown as WakeUpModelSelection
        })
      );
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsValidationError);
      expect((err as SettingsValidationError).reason).toBe('invalid-model');
    }
  });

  it('rejects an empty string with `invalid-model`', () => {
    try {
      validateSettings(
        baseValidSettings({ model: '' as unknown as WakeUpModelSelection })
      );
      throw new Error('did not throw');
    } catch (err) {
      expect((err as SettingsValidationError).reason).toBe('invalid-model');
    }
  });

  it('preserves the existing validator order — invalid-scheduler-type beats invalid-model', () => {
    try {
      validateSettings(
        baseValidSettings({
          schedulerType: 'weekly' as unknown as 'chronological',
          model: 'claude-bogus-9000' as unknown as WakeUpModelSelection
        })
      );
      throw new Error('did not throw');
    } catch (err) {
      // The existing 014 validator runs first, so we see invalid-scheduler-type
      // even though the model is also wrong — this pins the rule ordering.
      expect((err as SettingsValidationError).reason).toBe('invalid-scheduler-type');
    }
  });
});
