// Feature 091 T011 — contract C-01: the cleanup record's shape,
// validation rules, and the compare-then-write guard.
//
// The load-bearing rule here is that a malformed or unknown-version
// record is treated as ABSENT rather than as an error. That is what
// keeps a corrupted value from affecting startup (FR-011), and it is
// only safe because every removal operation is idempotent — so the
// tests below assert the "treated as absent" behaviour for each way a
// record can be wrong, not just for one representative case.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CLEANUP_ARTEFACTS,
  CLEANUP_RECORD_KEY,
  CLEANUP_RECORD_VERSION,
  commitCleanupRecord,
  isTerminalOutcome,
  parseCleanupRecord,
  readCleanupRecord,
  type WakeUpCleanupRecord
} from '../../../src/cleanup/cleanup-record';
import type { HostMemento } from '../../../src/host-services/types';

class FakeMemento implements HostMemento {
  private readonly values = new Map<string, unknown>();
  public updates = 0;

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updates += 1;
    // Mirrors VS Code's Memento: the in-memory value is visible to the
    // next synchronous read, before the persistence promise settles.
    this.values.set(key, value);
  }
}

const VALID: WakeUpCleanupRecord = {
  version: 1,
  outcome: 'succeeded',
  attemptedAt: '2026-08-12T00:00:00Z',
  attemptCount: 1,
  schedulers: [{ scheduler: 'launchd', result: 'removed' }],
  artefactsRemoved: ['runner.js']
};

describe('C-01 cleanup record', () => {
  let store: FakeMemento;

  beforeEach(() => {
    store = new FakeMemento();
  });

  describe('key and version', () => {
    it('is stored under the versioned machine-scoped key', () => {
      expect(CLEANUP_RECORD_KEY).toBe('schegent.wakeUpCleanup.v1');
      expect(CLEANUP_RECORD_VERSION).toBe(1);
    });

    it('names exactly the three invocable artefacts', () => {
      expect([...CLEANUP_ARTEFACTS]).toEqual([
        'runner.js',
        'settings.json',
        'workspace-roots.json'
      ]);
    });
  });

  describe('parsing a well-formed record', () => {
    it('round-trips every required field', () => {
      expect(parseCleanupRecord({ ...VALID })).toEqual(VALID);
    });

    it('carries notifiedAt when present', () => {
      const withNotify = { ...VALID, outcome: 'failed' as const, notifiedAt: '2026-08-12T01:02:03Z' };
      expect(parseCleanupRecord(withNotify)).toEqual(withNotify);
    });

    it('omits notifiedAt rather than storing undefined when absent', () => {
      const parsed = parseCleanupRecord({ ...VALID });
      expect(parsed).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(parsed!, 'notifiedAt')).toBe(false);
    });

    it('accepts an empty scheduler list — the unsupported-platform shape', () => {
      const parsed = parseCleanupRecord({
        ...VALID,
        outcome: 'skipped',
        schedulers: [],
        artefactsRemoved: []
      });
      expect(parsed?.outcome).toBe('skipped');
    });

    it('accepts a scheduler attempt carrying a reason', () => {
      const parsed = parseCleanupRecord({
        ...VALID,
        outcome: 'failed',
        schedulers: [{ scheduler: 'cron', result: 'failed', reason: 'crontab write failed: 1' }]
      });
      expect(parsed?.schedulers[0]).toEqual({
        scheduler: 'cron',
        result: 'failed',
        reason: 'crontab write failed: 1'
      });
    });
  });

  describe('a malformed record is treated as absent, never as an error', () => {
    const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a string', 'succeeded'],
      ['a number', 7],
      ['an array', []],
      ['an unknown future version', { ...VALID, version: 2 }],
      ['a missing version', { ...VALID, version: undefined }],
      ['an unknown outcome', { ...VALID, outcome: 'attempted' }],
      ['a missing outcome', { ...VALID, outcome: undefined }],
      ['a non-ISO attemptedAt', { ...VALID, attemptedAt: '12 Aug 2026' }],
      ['a local-time attemptedAt', { ...VALID, attemptedAt: '2026-08-12T00:00:00+02:00' }],
      ['an impossible attemptedAt', { ...VALID, attemptedAt: '2026-13-45T99:99:99Z' }],
      ['a zero attemptCount', { ...VALID, attemptCount: 0 }],
      ['a negative attemptCount', { ...VALID, attemptCount: -1 }],
      ['a fractional attemptCount', { ...VALID, attemptCount: 1.5 }],
      ['a NaN attemptCount', { ...VALID, attemptCount: Number.NaN }],
      ['a string attemptCount', { ...VALID, attemptCount: '1' }],
      ['a non-array schedulers', { ...VALID, schedulers: {} }],
      ['an unknown scheduler name', { ...VALID, schedulers: [{ scheduler: 'anacron', result: 'absent' }] }],
      ['an unknown scheduler result', { ...VALID, schedulers: [{ scheduler: 'cron', result: 'partial' }] }],
      ['a non-string reason', { ...VALID, schedulers: [{ scheduler: 'cron', result: 'failed', reason: 500 }] }],
      ['a non-array artefactsRemoved', { ...VALID, artefactsRemoved: 'runner.js' }],
      ['an artefact outside the closed set', { ...VALID, artefactsRemoved: ['session.log'] }],
      ['a full path in artefactsRemoved', { ...VALID, artefactsRemoved: ['/Users/someone/wakeup/runner.js'] }],
      ['a non-ISO notifiedAt', { ...VALID, notifiedAt: 'yesterday' }]
    ];

    for (const [label, raw] of REJECTED) {
      it(`treats ${label} as absent`, () => {
        expect(parseCleanupRecord(raw)).toBeUndefined();
      });
    }

    it('reads as absent through the store rather than throwing', () => {
      const throwing: HostMemento = {
        get: () => {
          throw new Error('globalState unavailable');
        },
        update: async () => {}
      };
      expect(readCleanupRecord(throwing)).toBeUndefined();
    });
  });

  describe('terminality (plan D-03)', () => {
    it('succeeded and skipped are terminal; failed is not', () => {
      expect(isTerminalOutcome('succeeded')).toBe(true);
      expect(isTerminalOutcome('skipped')).toBe(true);
      expect(isTerminalOutcome('failed')).toBe(false);
    });
  });

  describe('compare-then-write (plan D-04)', () => {
    const draft = {
      outcome: 'succeeded' as const,
      attemptedAt: '2026-08-12T00:00:00Z',
      schedulers: [{ scheduler: 'launchd' as const, result: 'removed' as const }],
      artefactsRemoved: ['runner.js' as const]
    };

    it('starts attemptCount at 1 when nothing is stored', async () => {
      const { record } = await commitCleanupRecord(store, draft, { nowIso: '2026-08-12T00:00:00Z' });
      expect(record.attemptCount).toBe(1);
      expect(readCleanupRecord(store)).toEqual(record);
    });

    it('increases attemptCount monotonically across attempts', async () => {
      const counts: number[] = [];
      for (let i = 0; i < 4; i++) {
        const { record } = await commitCleanupRecord(store, draft, {
          nowIso: '2026-08-12T00:00:00Z'
        });
        counts.push(record.attemptCount);
      }
      expect(counts).toEqual([1, 2, 3, 4]);
    });

    it('lifts attemptCount above a concurrent writer rather than overwriting it', async () => {
      // A second window wrote count 9 while this run was in flight.
      await store.update(CLEANUP_RECORD_KEY, { ...VALID, outcome: 'failed', attemptCount: 9 });

      const { record } = await commitCleanupRecord(store, draft, { nowIso: '2026-08-12T00:00:00Z' });
      expect(record.attemptCount).toBe(10);
    });

    it('sets notifiedAt exactly once and reports which commit did it', async () => {
      const failing = { ...draft, outcome: 'failed' as const };

      const first = await commitCleanupRecord(store, failing, { nowIso: '2026-08-12T00:00:00Z' });
      expect(first.shouldNotify).toBe(true);
      expect(first.record.notifiedAt).toBe('2026-08-12T00:00:00Z');

      const second = await commitCleanupRecord(store, failing, { nowIso: '2026-08-12T00:05:00Z' });
      expect(second.shouldNotify).toBe(false);
      // Carried forward, not restamped — the operator was told once.
      expect(second.record.notifiedAt).toBe('2026-08-12T00:00:00Z');
    });

    it('never notifies for a succeeded or skipped outcome', async () => {
      const succeeded = await commitCleanupRecord(store, draft, { nowIso: '2026-08-12T00:00:00Z' });
      expect(succeeded.shouldNotify).toBe(false);
      expect(succeeded.record.notifiedAt).toBeUndefined();

      const skipped = await commitCleanupRecord(
        store,
        { ...draft, outcome: 'skipped', schedulers: [], artefactsRemoved: [] },
        { nowIso: '2026-08-12T00:00:00Z' }
      );
      expect(skipped.shouldNotify).toBe(false);
      expect(skipped.record.notifiedAt).toBeUndefined();
    });

    it('carries notifiedAt forward when a later attempt succeeds', async () => {
      await commitCleanupRecord(store, { ...draft, outcome: 'failed' }, {
        nowIso: '2026-08-12T00:00:00Z'
      });
      const { record } = await commitCleanupRecord(store, draft, {
        nowIso: '2026-08-12T00:05:00Z'
      });

      expect(record.outcome).toBe('succeeded');
      expect(record.notifiedAt).toBe('2026-08-12T00:00:00Z');
    });

    it('writes a record that parses back cleanly', async () => {
      const { record } = await commitCleanupRecord(store, { ...draft, outcome: 'failed' }, {
        nowIso: '2026-08-12T00:00:00Z'
      });
      expect(parseCleanupRecord(record)).toEqual(record);
    });

    it('performs exactly one store write per commit', async () => {
      await commitCleanupRecord(store, draft, { nowIso: '2026-08-12T00:00:00Z' });
      expect(store.updates).toBe(1);
    });

    it('stores no filesystem path anywhere in the record', async () => {
      const { record } = await commitCleanupRecord(
        store,
        {
          ...draft,
          outcome: 'failed',
          schedulers: [{ scheduler: 'cron', result: 'failed', reason: 'crontab write failed: 1' }]
        },
        { nowIso: '2026-08-12T00:00:00Z' }
      );

      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/\//);
      expect(serialized).not.toMatch(/\\\\/);
    });
  });
});
