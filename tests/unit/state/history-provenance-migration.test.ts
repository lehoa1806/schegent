// Feature 103 (T025, US2) — the two provenance fields are additive, so there is
// nothing to migrate, and this file exists to keep it that way.
//
// A migration would be a defensible-looking mistake here. Both fields describe
// what a run did, and no past run can be asked after the fact — the only honest
// back-fill is none. So the design constraint is that a pre-feature entry is
// still a valid entry: it reads back exactly as it was written, both fields
// absent, and `STATE_SCHEMA_VERSION` does not move.
//
// The version pin is the part that catches the mistake early. A bump would
// route every existing workspace through a migrator on next load; this feature
// ships no migrator, so the bump alone would be the bug.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';
import { HistoryStore } from '../../../src/state/history-store';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

/**
 * An entry exactly as FR-R3-010 wrote them, which is every entry in every
 * workspace that upgrades into this feature. Frozen as a literal rather than
 * built through `buildHistoryEntry`, because a builder that changes takes the
 * fixture with it and the comparison stops meaning anything.
 */
const PRE_FEATURE_ENTRY = Object.freeze({
  runId: 'run-legacy-1',
  featureId: 'feat-legacy-1',
  descriptionPreview: 'written before 103',
  terminalStatus: 'completed',
  startedAt: '2026-07-01T09:00:00.000Z',
  completedAt: '2026-07-01T09:04:12.000Z',
  durationMs: 252_000,
  lastErrorSummary: null,
  auditLogPointer: 'runId:run-legacy-1',
  descriptionRef: '.schegent/history/run-legacy-1.txt',
  descriptionLength: 61,
  pipelineId: 'pipe-deploy'
});

const QUEUE = 'queue-a';

let memento: FakeMemento;
let history: HistoryStore;

beforeEach(async () => {
  memento = new FakeMemento();
  await memento.update(KEYS.history, {
    [QUEUE]: [{ ...PRE_FEATURE_ENTRY } as unknown as PersistedHistoryEntry]
  });
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  history = new HistoryStore(store);
});

describe('a pre-feature history entry survives this feature untouched (Feature 103, T025)', () => {
  it('reads back field for field as it was written', () => {
    const [record] = history.listForQueue(QUEUE);
    expect(record).toBeDefined();

    // `queueId` is the map key, not a stored field — the normaliser puts it on
    // the record from the partition it came out of, so it is excluded from the
    // comparison rather than expected in the fixture.
    const { queueId, ...read } = record!;
    expect(queueId).toBe(QUEUE);
    expect(read).toEqual(PRE_FEATURE_ENTRY);
  });

  it('carries neither provenance field, not even as an undefined key', () => {
    const [record] = history.listForQueue(QUEUE);
    expect(Object.prototype.hasOwnProperty.call(record, 'catalogVersion')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'origin')).toBe(false);
  });

  it('leaves the persisted bytes untouched by a read', () => {
    const before = JSON.stringify(memento.get(KEYS.history));
    history.list();
    history.listForQueue(QUEUE);
    expect(JSON.stringify(memento.get(KEYS.history))).toBe(before);
  });

  it('does not move STATE_SCHEMA_VERSION', () => {
    // Feature 102 adds two optional fields to a record and nothing to the state
    // shape, so there is no migrator to run and no version to bump BY THIS
    // FEATURE. That is what this asserts, and it is still true.
    //
    // The literal was `13` and is now `14`: FR-R3-117 moved the head with a real
    // migrator of its own. Re-pinning rather than deleting keeps the "this feature
    // bumped nothing" claim asserted somewhere, which is the whole point of the
    // check. Changing this literal is a decision, not a typo — and the decision
    // here is that feature 102's own footprint is unchanged.
    expect(STATE_SCHEMA_VERSION).toBe(14);
  });
});
