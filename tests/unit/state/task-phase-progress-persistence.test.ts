// FR-R3-158 (T009, FR-009) — `FeatureRequest.phaseProgress` is additive, so
// nothing persisted before this feature changes on a read or a write.
//
// The argument for leaving `STATE_SCHEMA_VERSION` alone is the feature-082 and
// feature-087 one, pinned next door in `workflow-run-additive-fields.test.ts`:
// an optional field written only when present gives a migrator nothing to do.
// That argument is a claim about *reads* and *writes*, so both go through the
// real `WorkspaceStateStore` here, against the same captured pre-082 memento —
// a record that predates this feature as surely as it predates that one.
//
// The second describe is the half that can genuinely fail. The pair is only
// worth persisting if it survives the trip: a store that rebuilt each request
// from a known field list would drop it silently, and the row would go back to
// reporting nothing the moment the run was disposed of — the exact defect this
// feature exists to end, reintroduced one layer down.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { projectQueue } from '../../../src/ui/sidebar/queue-projector';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

const FIXTURE_PATH = join(__dirname, '../../fixtures/state/pre-082-workspace-state.json');

/** The one key this feature introduces — it may not appear on a pre-feature read. */
const QUEUE_ITEM_KEY = 'phaseProgress';

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

function loadFixture(): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  delete parsed._comment;
  return parsed;
}

async function seededStore(): Promise<{
  store: WorkspaceStateStore;
  memento: FakeMemento;
  fixture: Record<string, unknown>;
}> {
  const fixture = loadFixture();
  const memento = new FakeMemento();
  for (const [key, value] of Object.entries(fixture)) {
    await memento.update(key, value);
  }
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento, fixture };
}

/**
 * One indexed read, narrowed — the fixture's size is a real precondition, and a
 * missing row must be a loud failure rather than a silently skipped assertion.
 *
 * Written as a parameter that declares the union rather than as an inline
 * `=== undefined` guard, because the tree's two lint gates disagree about the
 * inline form and only this shape satisfies both. Under the build's tsconfig
 * `requests[0]` is typed non-nullable, so an inline check is dead code that
 * `no-unnecessary-condition` counts as a regression; under
 * `noUncheckedIndexedAccess` — which `tests/lint/compiler-strictness-ratchet.test.ts`
 * measures the whole tree against — the same read is `| undefined` and an
 * unguarded use is a diagnostic against a pinned, shrink-only count. A declared
 * `T | undefined` parameter makes the check necessary for the signature and
 * lets the call site hand over an indexed read untouched. The idiom is the one
 * at `tests/integration/process-yaml/examples-round-trip.test.ts:120`.
 */
function required(request: FeatureRequest | undefined, what: string): FeatureRequest {
  if (request === undefined) throw new Error(what);
  return request;
}

/** The precondition every case here shares, stated once. */
const FIXTURE_HAS_A_ROW = 'fixture must persist a queue item';

function storedRequests(memento: FakeMemento): readonly FeatureRequest[] {
  // Feature 092 — `KEYS.queue` holds `Record<queueId, QueueState>`; the fixture
  // seeds the pre-v10 singular shape, which `initialize()` lifts.
  const stored = memento.get<Record<string, { requests: readonly FeatureRequest[] }>>(KEYS.queue);
  const queue = stored?.[DEFAULT_QUEUE_ID];
  if (queue === undefined) throw new Error('setQueue must persist');
  return queue.requests;
}

describe('FR-R3-158 — a queue item persisted before this feature reads back unchanged', () => {
  it('injects no phaseProgress on any queue item', async () => {
    const { store } = await seededStore();
    const requests = store.getQueue(DEFAULT_QUEUE_ID).requests;

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).not.toHaveProperty(QUEUE_ITEM_KEY);
    }
  });

  it('re-persists it with the same fields it was read with', async () => {
    // Deep equality rather than a byte comparison, for the reason the 087 suite
    // gives: `setQueue` re-stamps `updatedAt` and normalizes key order. What is
    // asserted here is that no field appears or disappears.
    const { store, memento, fixture } = await seededStore();

    await store.setQueue(store.getQueue(DEFAULT_QUEUE_ID));

    const persisted = fixture[KEYS.queue] as { requests: readonly unknown[] };
    expect(storedRequests(memento)).toEqual(persisted.requests);
  });

  it('omits the key entirely rather than writing it as undefined', async () => {
    // `{...request, phaseProgress: progress ?? undefined}` writes
    // `phaseProgress: undefined`, which `toEqual` treats as absent and
    // `JSON.stringify` drops — but `Object.keys` does not, and neither does a
    // memento that stores the object as-is. Pinning the key set is what makes
    // "written only when present" checkable.
    const { store, memento } = await seededStore();

    await store.setQueue(store.getQueue(DEFAULT_QUEUE_ID));

    for (const request of storedRequests(memento)) {
      expect(Object.keys(request)).not.toContain(QUEUE_ITEM_KEY);
    }
  });
});

describe('FR-R3-158 — a recorded pair survives the round trip', () => {
  it('reads back the same two numbers it was written with', async () => {
    // The point of persisting at all (FR-009). The run that produced these
    // numbers is disposed of when the task reaches a terminal status; if the
    // pair did not survive the write, the row would be back to reporting
    // nothing the moment that happened.
    const { store, memento } = await seededStore();
    const queue = store.getQueue(DEFAULT_QUEUE_ID);

    // `map` rather than a destructure-and-respread: it is `QueueManager`'s own
    // idiom for rewriting one row, and it reaches the element without an indexed
    // read, so it costs the strictness ratchet nothing.
    await store.setQueue({
      ...queue,
      requests: queue.requests.map((request, index) =>
        index === 0 ? { ...request, phaseProgress: { settled: 5, total: 7 } } : request
      )
    });

    const reloaded = new WorkspaceStateStore(memento);
    await reloaded.initialize();
    const reread = required(
      reloaded.getQueue(DEFAULT_QUEUE_ID).requests[0],
      FIXTURE_HAS_A_ROW
    );

    expect(reread.phaseProgress).toEqual({ settled: 5, total: 7 });
  });

  it('keeps a zero count distinguishable from an absent one', async () => {
    // `{ settled: 0, total: 7 }` is a real answer — a task that failed in its
    // first phase — and absence is "unknown". A store that dropped falsy values
    // would collapse the two, which is precisely the conflation FR-010 forbids.
    const { store, memento } = await seededStore();
    const queue = store.getQueue(DEFAULT_QUEUE_ID);

    await store.setQueue({
      ...queue,
      requests: queue.requests.map((request, index) =>
        index === 0 ? { ...request, phaseProgress: { settled: 0, total: 7 } } : request
      )
    });

    const stored = storedRequests(memento);
    const persisted = required(stored[0], FIXTURE_HAS_A_ROW);
    expect(persisted).toHaveProperty(QUEUE_ITEM_KEY);
    expect(persisted.phaseProgress).toEqual({ settled: 0, total: 7 });
    for (const untouched of stored.slice(1)) {
      expect(untouched).not.toHaveProperty(QUEUE_ITEM_KEY);
    }
  });
});

/**
 * FR-R3-158 (T028, FR-009, SC-005) — persisted **and** projected, end to end.
 *
 * The two describes above each prove half of SC-005: the store keeps the pair,
 * and the projector reads it (`task-phase-progress-projection.test.ts`). Halves
 * that pass separately still leave the operator's claim unproven, because the
 * defect SC-005 guards against lives in the join — a reload rebuilds the queue
 * from the memento with no runs in the store at all, which is the one arrangement
 * neither half exercises on its own.
 *
 * So this walks the whole path: write a pair, drop the store, build a new one
 * from the same memento, and project the reloaded requests with **no run and no
 * catalog** in the context. What comes out must be the numbers that went in.
 *
 * `tasks.md` T028 offered `tests/integration/history-replay-roundtrip.test.ts` or
 * a sibling; it lives here instead because this file already holds the real
 * `WorkspaceStateStore` against the pre-082 fixture, and the missing link is the
 * projection, not more persistence plumbing. Noted rather than assumed.
 */
describe('FR-R3-158 (T028) — the figure survives a reload and reaches the row', () => {
  it('projects the same pair after the queue is rebuilt from the memento (SC-005)', async () => {
    const { store, memento } = await seededStore();
    const queue = store.getQueue(DEFAULT_QUEUE_ID);
    const first = required(queue.requests[0], FIXTURE_HAS_A_ROW);

    // Two failures at different points — the pair of readings US1 exists for:
    // one task that got most of the way, one that failed in its first phase.
    //
    // The second row is DERIVED from the first rather than destructured off the
    // array. An earlier draft read a `second` out of `queue.requests` and wrote
    // it only `if (second !== undefined)` — but the fixture seeds exactly one
    // request, so that branch never ran and the `settled: 0` reading this test
    // names in its title was asserted on no run at all. `no-unnecessary-condition`
    // is what surfaced it: the guard was dead to the compiler as well as to the
    // fixture.
    const second: FeatureRequest = {
      ...first,
      id: `${first.id}-second`,
      position: first.position + 1
    };
    await store.setQueue({
      ...queue,
      requests: [
        { ...first, status: 'failed', phaseProgress: { settled: 5, total: 7 } },
        { ...second, status: 'failed', phaseProgress: { settled: 0, total: 7 } },
        ...queue.requests.slice(1)
      ]
    });

    const reloaded = new WorkspaceStateStore(memento);
    await reloaded.initialize();

    // A cold host: no run survived the reload, and no catalog is wired in. The
    // recorded pair is the only source there is, which is the whole point.
    const rows = projectQueue(reloaded.getQueue(DEFAULT_QUEUE_ID), {
      sanitize: (input: string) => input,
      inFlightPhase: null,
      inFlightId: null
    }).orderedItems;

    expect(rows.find((row) => row.id === first.id)?.phaseProgress).toEqual({
      settled: 5,
      total: 7
    });
    expect(rows.find((row) => row.id === second.id)?.phaseProgress).toEqual({
      settled: 0,
      total: 7
    });
  });

  it('projects no figure for a task record that predates the feature (SC-008)', async () => {
    // The same cold reload, over the untouched fixture. Nothing was ever
    // recorded for these tasks and no run remains to re-derive from, so every
    // row reports `null` — unknown — rather than a zero pair standing in for it.
    const { store } = await seededStore();

    const rows = projectQueue(store.getQueue(DEFAULT_QUEUE_ID), {
      sanitize: (input: string) => input,
      inFlightPhase: null,
      inFlightId: null
    }).orderedItems;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.phaseProgress).toBeNull();
    }
  });
});
