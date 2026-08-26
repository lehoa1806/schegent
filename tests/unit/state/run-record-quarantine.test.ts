import { describe, expect, it } from 'vitest';
import { RUN_QUARANTINE_CAP } from '../../../src/contracts/audit-events';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { isWorkflowRun } from '../../../src/state/run-state-migrator';
import { migrateLegacyRun } from '../../../src/state/workflow-run-migrator';

/**
 * FR-R3-111 (FR-112, FR-113, FR-114) — a corrupt Run record is preserved and audited, not
 * destroyed in silence.
 *
 * THE DEFECT. Two branches of the Run load path threw records away. The map branch did
 * `changed = true; continue;` — dropped, written over, no audit event. The singular branch was
 * worse: `return []`, without even the `changed` flag. So a Run could vanish and leave nothing at
 * all for the operator to read, and no reader could tell a corrupt record from one that never
 * existed.
 *
 * THE ASYMMETRY THAT MADE IT VISIBLE. An unparseable QUEUE entry has been preserved for inspection
 * since the v9 -> v10 migrator (`KEYS.queueMigrationQuarantine`). Same store, same kind of
 * corruption, opposite treatment, no stated reason. Whatever the retention policy should be, the
 * silence was the defect — which is why the singular branch is fixed regardless.
 *
 * BOUNDED, because a corruption loop must not fill the Memento — the same shape the queue
 * quarantine already uses, and the reason `RUN_QUARANTINE_CAP` is small: these exist to be looked
 * at once.
 */
class FakeMemento implements Memento {
  public readonly map = new Map<string, unknown>();
  public keys(): readonly string[] {
    return [...this.map.keys()];
  }
  public get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

/**
 * A value `migrateLegacyRun` returns null for.
 *
 * It returns null only for `null`, `undefined`, or a non-object — so a STRING is the shape that
 * reaches the discard path. That is narrower than it looks, and the narrowness is the finding
 * recorded below.
 */
const CORRUPT = 'this was never a run record';

/**
 * A legacy numeric version low enough that `applyLegacyMigration` is true.
 *
 * `needsLegacyRunMigration` is true only when the persisted numeric version is absent or BELOW
 * v8 — an earlier draft used 9 and the discard path was simply never entered, so every assertion
 * here failed for the right reason and would have been easy to "fix" by weakening them.
 */
const LEGACY_NUMERIC = 7;

function storeWith(runValue: unknown): { store: WorkspaceStateStore; memento: FakeMemento } {
  const memento = new FakeMemento();
  memento.map.set(KEYS.run, runValue);
  memento.map.set(KEYS.schemaVersionNumeric, LEGACY_NUMERIC);
  return { store: new WorkspaceStateStore(memento), memento };
}

describe('FR-R3-111 — a corrupt Run record is quarantined, not discarded', () => {
  it('the singular branch preserves the record instead of returning silently', async () => {
    // The branch that was genuinely losing records: `return []`, without even the `changed` flag
    // the map branch set. A single legacy record that failed to migrate vanished with no trace.
    const { store, memento } = storeWith(CORRUPT);
    await store.initialize();
    const quarantine = memento.get<readonly unknown[]>(KEYS.runQuarantine);
    expect(quarantine, 'the corrupt record must be preserved somewhere').toBeDefined();
    expect((quarantine as readonly unknown[]).length).toBe(1);
  });

  it('emits an audit event, which was the missing half', async () => {
    const { store } = storeWith(CORRUPT);
    await store.initialize();
    const events = store.drainRunQuarantineEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe('run-record-quarantined');
    expect(events[0]?.payload.reason).toBe('unparseable');
    expect(events[0]?.payload.quarantineDepth).toBe(1);
  });

  it('the payload carries no raw record, because it is unvalidated data', async () => {
    // The rejected value lives in the Memento quarantine. Putting arbitrary persisted content in
    // the audit log would invert the payload discipline every other event follows.
    const { store } = storeWith(CORRUPT);
    await store.initialize();
    const drained = store.drainRunQuarantineEvents();
    // Asserted before it is read, so a drain that returned nothing fails here rather than
    // passing an empty key list through a `?? {}` that hid the absence.
    expect(drained, 'the quarantine must have recorded an event').toHaveLength(1);
    const payload = drained[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(['quarantineDepth', 'queueId', 'reason']);
    expect(JSON.stringify(payload)).not.toContain('never was a run');
  });

  it('THE MAP BRANCH IS UNREACHABLE, and this pins why', () => {
    // Item 111 §2 cites the discard at "both branches" as live. One of them is not, and the
    // reason is two predicates in two other files agreeing:
    //
    //   * `isRunStateMap` is true only when EVERY value satisfies `isWorkflowRun`, which requires
    //     a non-null, non-array object.
    //   * `migrateLegacyRun` returns null only for null, undefined, or a non-object.
    //
    // Mutually exclusive. So a corrupt entry inside an otherwise-valid map fails the map
    // predicate wholesale and falls to the singular branch instead. The quarantine is wired at
    // both sites anyway — it costs an array push — but nobody should read that site as a fix for
    // a live defect.
    //
    // Asserted rather than commented, because the unreachability is a COUPLING between two
    // files. If either predicate widens, this test says the branch became live.
    for (const value of [null, undefined, 'a string', 42, true, []]) {
      expect(
        isWorkflowRun(value),
        `${JSON.stringify(value)} must fail isWorkflowRun, or the map branch becomes reachable`
      ).toBe(false);
    }
    // ...and a value that PASSES isWorkflowRun must not be one migrateLegacyRun rejects.
    const valid = { id: 'r', featureId: 'f', status: 'completed' };
    expect(isWorkflowRun(valid)).toBe(true);
    expect(
      migrateLegacyRun(valid),
      'a value that satisfies isWorkflowRun must not be discarded by the legacy migrator; if it ' +
        'can be, the map-branch discard is live and its quarantine is load-bearing'
    ).not.toBeNull();
  });

  it('is bounded oldest-out, so a corruption loop cannot fill the Memento', async () => {
    const memento = new FakeMemento();
    memento.map.set(
      KEYS.runQuarantine,
      Array.from({ length: RUN_QUARANTINE_CAP }, (_, i) => ({
        queueId: `old-${i}`,
        capturedAtMs: i,
        reason: 'unparseable',
        raw: {}
      }))
    );
    memento.map.set(KEYS.run, CORRUPT);
    memento.map.set(KEYS.schemaVersionNumeric, LEGACY_NUMERIC);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    const kept = memento.get<ReadonlyArray<{ queueId: string }>>(KEYS.runQuarantine) ?? [];
    expect(kept.length, 'the cap must hold').toBe(RUN_QUARANTINE_CAP);
    expect(
      kept.some((entry) => entry.queueId === 'old-0'),
      'the OLDEST entry must be the one evicted'
    ).toBe(false);
  });

  it('draining is idempotent, so a forwarder cannot emit an event twice', async () => {
    const { store } = storeWith(CORRUPT);
    await store.initialize();
    expect(store.drainRunQuarantineEvents().length).toBe(1);
    expect(store.drainRunQuarantineEvents().length).toBe(0);
  });

  it('a clean load quarantines nothing and emits nothing', async () => {
    // The floor: if every load quarantined something, every assertion above would pass for the
    // wrong reason.
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(memento.get(KEYS.runQuarantine)).toBeUndefined();
    expect(store.drainRunQuarantineEvents().length).toBe(0);
  });
});
