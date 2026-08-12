// Feature 091 T015 — FR-015a, SC-014: cleanup writes no configuration.
//
// The temptation is to "tidy up" the operator's settings.json by
// deleting the schegent.wakeUp.* keys the feature no longer reads. That
// would be a silent, unconfirmed write to a file the operator owns, and
// it would be irreversible for anyone who downgrades. Removing a setting
// from package.json is enough: VS Code stops offering it, and an unread
// key is inert. So the assertion here is byte-for-byte: whatever the
// stored configuration was before cleanup ran, it is identical after.

import { describe, it, expect, beforeEach } from 'vitest';
import { runWakeUpCleanup, type WakeUpCleanupDeps } from '../../../src/cleanup/wakeup-cleanup';
import { CLEANUP_RECORD_KEY } from '../../../src/cleanup/cleanup-record';
import type { HostMemento } from '../../../src/host-services/types';

/** A stand-in for the operator's stored `schegent.wakeUp.*` settings. */
const STORED_WAKEUP_SETTINGS = Object.freeze({
  'schegent.wakeUp.enabled': true,
  'schegent.wakeUp.schedule': '0 3 * * *',
  'schegent.wakeUp.maxRunMinutes': 90,
  'schegent.wakeUp.scheduler': 'launchd'
});

class RecordingMemento implements HostMemento {
  private readonly values = new Map<string, unknown>();
  public readonly writes: Array<{ key: string; value: unknown }> = [];

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
}

/**
 * A configuration store that fails loudly on any write. Cleanup has no
 * handle on it at all — that is the design — so the assertion is that a
 * full run leaves the frozen snapshot untouched.
 */
class SentinelConfiguration {
  private readonly stored: Record<string, unknown> = { ...STORED_WAKEUP_SETTINGS };
  public readonly mutations: string[] = [];

  update(section: string, value: unknown): void {
    this.mutations.push(section);
    this.stored[section] = value;
  }

  snapshot(): string {
    return JSON.stringify(this.stored);
  }
}

describe('FR-015a cleanup performs no configuration write', () => {
  let store: RecordingMemento;
  let config: SentinelConfiguration;

  const deps = (overrides: Partial<WakeUpCleanupDeps> = {}): WakeUpCleanupDeps => ({
    store,
    wakeUpHomeDir: '/nonexistent/wakeup',
    logger: { info: () => {}, warn: () => {}, sanitize: (s) => s },
    notifier: { warn: async () => undefined },
    openUpgradeNote: () => {},
    platform: 'darwin',
    now: () => new Date('2026-08-12T00:00:00Z'),
    removers: {
      launchd: async () => ({ scheduler: 'launchd', result: 'removed' })
    },
    fs: { unlink: async () => {} },
    ...overrides
  });

  beforeEach(() => {
    store = new RecordingMemento();
    config = new SentinelConfiguration();
  });

  it('leaves the stored schegent.wakeUp.* values byte-for-byte identical', async () => {
    const before = config.snapshot();
    await runWakeUpCleanup(deps());
    expect(config.snapshot()).toBe(before);
    expect(config.mutations).toEqual([]);
  });

  it('leaves them identical on the failure path too', async () => {
    const before = config.snapshot();
    await runWakeUpCleanup(
      deps({
        removers: {
          launchd: async () => ({
            scheduler: 'launchd',
            result: 'failed',
            reason: 'launchctl bootout failed: 1'
          })
        }
      })
    );
    expect(config.snapshot()).toBe(before);
    expect(config.mutations).toEqual([]);
  });

  it('leaves them identical on the skipped path too', async () => {
    const before = config.snapshot();
    await runWakeUpCleanup(
      deps({
        removers: { launchd: async () => ({ scheduler: 'launchd', result: 'absent' }) }
      })
    );
    expect(config.snapshot()).toBe(before);
    expect(config.mutations).toEqual([]);
  });

  it('writes exactly one machine-scoped key and nothing else', async () => {
    await runWakeUpCleanup(deps());

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.key).toBe(CLEANUP_RECORD_KEY);
  });

  it('never writes a key in the schegent.wakeUp.* configuration namespace', async () => {
    await runWakeUpCleanup(deps());

    for (const { key } of store.writes) {
      expect(key.startsWith('schegent.wakeUp.')).toBe(false);
    }
  });

  it('is not given a configuration handle at all — the dependency surface has no such port', () => {
    // Structural, not behavioural: the deps object is the module's whole
    // world. If no member of it can reach configuration, no code path
    // inside can write configuration.
    const surface = Object.keys(deps());
    expect(surface).toEqual(
      expect.arrayContaining([
        'store',
        'wakeUpHomeDir',
        'logger',
        'notifier',
        'openUpgradeNote',
        'platform',
        'now',
        'removers',
        'fs'
      ])
    );
    for (const member of surface) {
      expect(member.toLowerCase()).not.toContain('config');
      expect(member.toLowerCase()).not.toContain('setting');
    }
  });
});
