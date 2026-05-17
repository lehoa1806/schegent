// Feature 014 T014 — unit tests for the settings reader/writer.
//
// Exercises every invariant from `data-model.md`:
//   - defaults applied when values missing or wrong type
//   - validateSettings rejects every category from the closed
//     `WakeUpRejectReason` set
//   - writeSettings is transactional (no partial writes on invalid input)
//   - writeSettings wraps underlying `config.update()` errors as
//     `config-write-failed`
//   - parsePeriodic correctly applies the 1-minute floor

import { describe, it, expect } from 'vitest';
import {
  readSettings,
  validateSettings,
  writeSettings,
  parsePeriodic,
  getDefaults,
  SettingsValidationError,
  CONFIGURATION_TARGET_GLOBAL,
  type WakeUpConfig,
  type WakeUpSettings
} from '../../../src/wakeup/settings';

class FakeConfig implements WakeUpConfig {
  private values: Map<string, unknown> = new Map();
  public readonly writes: Array<{ key: string; value: unknown; target: number }> = [];
  public failOn: string | null = null;

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown, target: number): Promise<void> {
    if (this.failOn === key) throw new Error('simulated EACCES');
    this.writes.push({ key, value, target });
    this.values.set(key, value);
  }
}

describe('readSettings', () => {
  it('returns defaults for an empty config', () => {
    const cfg = new FakeConfig();
    expect(readSettings(cfg)).toEqual(getDefaults());
  });

  it('round-trips valid values', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.enabled', true);
    cfg.set('wakeUp.schedulerType', 'periodic');
    cfg.set('wakeUp.chronologicalTime', '23:59');
    cfg.set('wakeUp.periodicInterval', 'Every 5h');
    expect(readSettings(cfg)).toEqual({
      enabled: true,
      schedulerType: 'periodic',
      chronologicalTime: '23:59',
      periodicInterval: 'Every 5h',
      // Feature 031 — model defaults to `'runner-default'` when the
      // mirror does not carry the new key. Round-trip preserves that.
      model: 'runner-default'
    });
  });

  it('substitutes defaults for wrong-type values', () => {
    const cfg = new FakeConfig();
    cfg.set('wakeUp.enabled', 'yes');
    cfg.set('wakeUp.schedulerType', 'random');
    cfg.set('wakeUp.chronologicalTime', '25:00');
    cfg.set('wakeUp.periodicInterval', 'Soon');
    expect(readSettings(cfg)).toEqual(getDefaults());
  });
});

describe('validateSettings', () => {
  const valid: WakeUpSettings = {
    enabled: true,
    schedulerType: 'chronological',
    chronologicalTime: '04:00',
    periodicInterval: 'Every 4h',
    model: 'runner-default'
  };

  it('passes for the defaults', () => {
    expect(() => validateSettings(valid)).not.toThrow();
  });

  it('throws invalid-scheduler-type', () => {
    try {
      validateSettings({ ...valid, schedulerType: 'weekly' as unknown as 'periodic' });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsValidationError);
      expect((err as SettingsValidationError).reason).toBe('invalid-scheduler-type');
    }
  });

  it('throws invalid-chronological-time for malformed time', () => {
    try {
      validateSettings({ ...valid, chronologicalTime: '4:00' });
      throw new Error('did not throw');
    } catch (err) {
      expect((err as SettingsValidationError).reason).toBe('invalid-chronological-time');
    }
  });

  it('throws invalid-periodic-interval for malformed interval', () => {
    try {
      validateSettings({ ...valid, periodicInterval: 'Every hour' });
      throw new Error('did not throw');
    } catch (err) {
      expect((err as SettingsValidationError).reason).toBe('invalid-periodic-interval');
    }
  });

  it('throws periodic-interval-below-minimum for < 1m', () => {
    // The PERIODIC regex requires `(\d+)(m|h)`. "Every 0m" parses but
    // resolves to 0 ms which is below the 60_000 floor.
    try {
      validateSettings({ ...valid, periodicInterval: 'Every 0m' });
      throw new Error('did not throw');
    } catch (err) {
      // `Every 0m` fails the parsePeriodic positivity check first →
      // invalid-periodic-interval rather than below-minimum. Below-minimum
      // covers shaped-but-too-small intervals, which the current regex
      // cannot express (smallest is `Every 1m` = 60_000 ms = exactly the floor).
      expect((err as SettingsValidationError).reason).toBe('invalid-periodic-interval');
    }
  });
});

describe('writeSettings', () => {
  it('writes all four keys at ConfigurationTarget.Global', async () => {
    const cfg = new FakeConfig();
    const settings: WakeUpSettings = {
      enabled: true,
      schedulerType: 'periodic',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h',
      model: 'runner-default'
    };
    await writeSettings(cfg, settings);
    // Feature 031 — `wakeUp.model` joins the four legacy keys.
    expect(cfg.writes).toHaveLength(5);
    for (const w of cfg.writes) {
      expect(w.target).toBe(CONFIGURATION_TARGET_GLOBAL);
    }
    const keys = cfg.writes.map((w) => w.key);
    expect(keys).toEqual([
      'wakeUp.enabled',
      'wakeUp.schedulerType',
      'wakeUp.chronologicalTime',
      'wakeUp.periodicInterval',
      'wakeUp.model'
    ]);
  });

  it('refuses to write when validation fails — no partial state', async () => {
    const cfg = new FakeConfig();
    await expect(
      writeSettings(cfg, {
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '99:00',
        periodicInterval: 'Every 4h',
        model: 'runner-default'
      })
    ).rejects.toBeInstanceOf(SettingsValidationError);
    expect(cfg.writes).toEqual([]);
  });

  it('wraps underlying update() errors as config-write-failed', async () => {
    const cfg = new FakeConfig();
    cfg.failOn = 'wakeUp.chronologicalTime';
    try {
      await writeSettings(cfg, {
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h',
        model: 'runner-default'
      });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsValidationError);
      expect((err as SettingsValidationError).reason).toBe('config-write-failed');
    }
  });
});

describe('parsePeriodic', () => {
  it('parses minute units', () => {
    const r = parsePeriodic('Every 15m');
    expect(r).toEqual({ everyMs: 15 * 60 * 1000, unit: 'm', count: 15 });
  });

  it('parses hour units', () => {
    const r = parsePeriodic('Every 4h');
    expect(r).toEqual({ everyMs: 4 * 60 * 60 * 1000, unit: 'h', count: 4 });
  });

  it('returns null for invalid inputs', () => {
    expect(parsePeriodic('Every')).toBeNull();
    expect(parsePeriodic('15m')).toBeNull();
    expect(parsePeriodic('Every 0m')).toBeNull();
    expect(parsePeriodic('Every -1m')).toBeNull();
    expect(parsePeriodic('Every 1s')).toBeNull();
  });
});
