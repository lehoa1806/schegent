// FR-R3-157 (T038, FR-011, SC-005, contract C3.7) — the degraded mark survives a
// workspace reload, on BOTH records that carry it.
//
// C3.7 names two fields, not one: `WorkflowRun.degradedPhases`, where the mark is
// accumulated while the run executes, and `FeatureRequest.degradedPhases`, where it
// is captured when the task ends. A test that exercised only the second would leave
// the interesting half unproven — the run field is the one a live host reads to
// present an in-flight degraded task (FR-011b), and a store that dropped it would
// blank that row on every window reload while every terminal row stayed correct.
//
// The claim under test is not "the store can hold an array". It is that neither
// name is lost: `phaseId` says which phase was let through, `condition` says what
// it failed. A store that kept the phase and dropped the condition would leave a
// row that says a phase degraded without saying what was wrong with it, which is
// exactly the "never indistinguishable from a clean one" guarantee half-kept.
//
// The pre-feature half is the no-schema-bump argument (D-I3), pinned the way
// `task-phase-progress-persistence.test.ts` and `workflow-run-additive-fields.test.ts`
// pin theirs: against a real `WorkspaceStateStore` over a captured record that
// predates the field, reading AND writing, with the key set asserted rather than
// deep equality alone — `toEqual` treats an explicit `undefined` as absent and a
// memento does not.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { DegradedPhaseEntry } from '../../../src/contracts/snapshot-projections';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const FIXTURE_PATH = join(__dirname, '../../fixtures/state/pre-082-workspace-state.json');

/** The one key this feature adds to both records. It may not appear on a pre-feature read. */
const FIELD = 'degradedPhases';

const AUDIT: DegradedPhaseEntry = { phaseId: 'audit', condition: 'open_questions > 0' };
const VERIFY: DegradedPhaseEntry = { phaseId: 'verify', condition: 'coverage < 80' };

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

async function seededStore(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  delete fixture._comment;
  const memento = new FakeMemento();
  for (const [key, value] of Object.entries(fixture)) {
    await memento.update(key, value);
  }
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento };
}

/**
 * One indexed read, narrowed — a missing row is a broken fixture and must fail
 * loudly rather than skip an assertion. Written as a `T | undefined` parameter for
 * the reason `task-phase-progress-persistence.test.ts:63-78` records: it is the one
 * shape both the `no-unnecessary-condition` rule and the `noUncheckedIndexedAccess`
 * ratchet accept.
 */
function required<T>(value: T | null | undefined, what: string): NonNullable<T> {
  // Both empties, not just `undefined`: the two readers here disagree about which
  // one they use for "no such record" — `getQueue().requests[i]` is `undefined` by
  // the `noUncheckedIndexedAccess` ratchet, while `getRun()` returns `null`. A
  // helper that narrowed only `undefined` would compile at the call site and then
  // hand a `null` straight into a spread, which is what it exists to prevent.
  if (value === undefined || value === null) throw new Error(what);
  return value;
}

function storedRequests(memento: FakeMemento): readonly FeatureRequest[] {
  const stored = memento.get<Record<string, { requests: readonly FeatureRequest[] }>>(KEYS.queue);
  const queue = required(stored?.[DEFAULT_QUEUE_ID], 'setQueue must persist');
  return queue.requests;
}

/** The Run the fixture's store loads, as the subject of a re-persist. */
function persistedRun(memento: FakeMemento): WorkflowRun {
  const runs = memento.get<Record<string, WorkflowRun>>(KEYS.run);
  return required(runs?.[DEFAULT_QUEUE_ID], 'setRun must persist');
}

describe('FR-R3-157 — a record persisted before this feature reads back unchanged', () => {
  it('injects no degradedPhases on any queue item', async () => {
    const { store } = await seededStore();
    const requests = store.getQueue(DEFAULT_QUEUE_ID).requests;

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).not.toHaveProperty(FIELD);
    }
  });

  it('injects no degradedPhases on a loaded Run', async () => {
    const { store } = await seededStore();
    const run = required(store.getRun(DEFAULT_QUEUE_ID), 'fixture must persist a run');

    expect(run).not.toHaveProperty(FIELD);
  });

  it('omits the key rather than writing it as undefined, on both records', async () => {
    // The assertion that makes "written only when present" checkable at all.
    // `{ ...run, degradedPhases: list ?? undefined }` produces a key `toEqual`
    // calls absent and `JSON.stringify` drops — but `Object.keys` keeps it, and so
    // does a memento that stores the object as handed over.
    const { store, memento } = await seededStore();
    const run = required(store.getRun(DEFAULT_QUEUE_ID), 'fixture must persist a run');

    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await store.setQueue(store.getQueue(DEFAULT_QUEUE_ID));

    expect(Object.keys(persistedRun(memento))).not.toContain(FIELD);
    for (const request of storedRequests(memento)) {
      expect(Object.keys(request)).not.toContain(FIELD);
    }
  });
});

describe('FR-R3-157 (T038) — a recorded mark survives a reload with both names (C3.7)', () => {
  it('reads back the run field it was written with', async () => {
    const { store, memento } = await seededStore();
    const run = required(store.getRun(DEFAULT_QUEUE_ID), 'fixture must persist a run');

    await store.setRun(
      DEFAULT_QUEUE_ID,
      { ...run, degradedPhases: [AUDIT, VERIFY] },
      unfencedCommit('test-fixture')
    );

    // A cold host: the store object is discarded and a new one is built over the
    // same memento, which is what a window reload does.
    const reloaded = new WorkspaceStateStore(memento);
    await reloaded.initialize();
    const reread = required(reloaded.getRun(DEFAULT_QUEUE_ID), 'run must survive the reload');

    // Order first, then both names — a reload that reversed the list would misreport
    // which phase degraded first, and one that kept `phaseId` alone would leave a row
    // naming a phase with nothing said about what was wrong with it.
    expect(reread.degradedPhases).toEqual([AUDIT, VERIFY]);
    expect(reread.degradedPhases?.map((entry) => entry.phaseId)).toEqual(['audit', 'verify']);
    expect(reread.degradedPhases?.map((entry) => entry.condition)).toEqual([
      'open_questions > 0',
      'coverage < 80'
    ]);
  });

  it('reads back the task field it was written with (SC-005)', async () => {
    const { store, memento } = await seededStore();
    const queue = store.getQueue(DEFAULT_QUEUE_ID);

    // `map` rather than destructure-and-respread: `QueueManager`'s own idiom for
    // rewriting one row, and it reaches the element without an indexed read.
    await store.setQueue({
      ...queue,
      requests: queue.requests.map((request, index) =>
        index === 0 ? { ...request, status: 'failed' as const, degradedPhases: [AUDIT] } : request
      )
    });

    const reloaded = new WorkspaceStateStore(memento);
    await reloaded.initialize();
    const reread = required(
      reloaded.getQueue(DEFAULT_QUEUE_ID).requests[0],
      'fixture must persist a queue item'
    );

    expect(reread.degradedPhases).toEqual([AUDIT]);
  });

  it('leaves every other row un-marked (C3.6)', async () => {
    // Absence means not degraded, so it is not enough that the marked row keeps its
    // mark: the unmarked ones must still have no key at all. A store that filled the
    // field in on write would make every task look degraded and nothing would fail.
    const { store, memento } = await seededStore();
    const queue = store.getQueue(DEFAULT_QUEUE_ID);
    const first = required(queue.requests[0], 'fixture must persist a queue item');
    const second: FeatureRequest = { ...first, id: `${first.id}-second`, position: first.position + 1 };

    await store.setQueue({
      ...queue,
      requests: [{ ...first, degradedPhases: [AUDIT] }, second, ...queue.requests.slice(1)]
    });

    const stored = storedRequests(memento);
    expect(required(stored[0], 'row must persist')).toHaveProperty(FIELD);
    for (const untouched of stored.slice(1)) {
      expect(untouched).not.toHaveProperty(FIELD);
    }
  });
});
