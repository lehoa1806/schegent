// Feature 087 (T035, T036, US4) — the three fields this feature persists are
// additive, so nothing persisted before it changes on a read or a write.
//
// `FeatureRequest.runPlan`, `WorkflowRun.runInputs`, and `WorkflowRun.runOutputs`
// are all optional and written only when present, which is the whole argument for
// leaving `STATE_SCHEMA_VERSION` alone (the feature-082 precedent, pinned next
// door in `pre-082-state-load.test.ts`). That argument is a claim about *reads*
// and *writes*, so this exercises both through the real `WorkspaceStateStore`:
//
//   * a captured pre-feature memento loads with none of the three keys injected,
//     and re-persisting it leaves the stored JSON byte-identical;
//   * a Run and a queue item constructed without them serialize without them —
//     no `runInputs: undefined` key appearing in the JSON, which is the shape a
//     spread-based writer produces and which a later `JSON.stringify` comparison
//     would then quietly disagree about.
//
// The fixture is the one 082 captured. It predates this feature just as surely,
// and a real captured memento is worth more than one hand-written to pass.

import { readFileSync } from 'node:fs';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION_V8 } from '../../../src/contracts/state-schema';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

const FIXTURE_PATH = join(__dirname, '../../fixtures/state/pre-082-workspace-state.json');

/** The exact keys feature 087 introduces — none may appear on a pre-feature read. */
const RUN_KEYS = ['runInputs', 'runOutputs'] as const;
const QUEUE_ITEM_KEY = 'runPlan';

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

describe('a Run persisted before feature 087 reads back unchanged (T036)', () => {
  // The fixture was captured at v8 and stays there. Feature 088 moved the
  // runtime to v9, which is exactly the situation the byte-for-byte assertions
  // below are for: a record persisted at an earlier version must survive the
  // bump untouched (088 FR-007). Pinning the fixture to the version it was
  // actually captured at keeps that a real cross-version test rather than one
  // that silently degrades to a same-version no-op on the next bump.
  it('is captured at the schema version this feature leaves alone', () => {
    expect(loadFixture()[KEYS.schemaVersionNumeric]).toBe(STATE_SCHEMA_VERSION_V8);
  });

  it('injects neither runInputs nor runOutputs', async () => {
    const { store } = await seededStore();
    const run = store.getRun(DEFAULT_QUEUE_ID);
    if (run === null) throw new Error('fixture must persist a Run');
    for (const key of RUN_KEYS) {
      expect(run, `${key} must not be injected on read`).not.toHaveProperty(key);
    }
  });

  it('injects no runPlan on any queue item', async () => {
    const { store } = await seededStore();
    const requests = store.getQueue(DEFAULT_QUEUE_ID).requests;
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).not.toHaveProperty(QUEUE_ITEM_KEY);
    }
  });

  it('returns the persisted Run and queue byte-for-byte', async () => {
    const { store, fixture } = await seededStore();
    expect(store.getRun(DEFAULT_QUEUE_ID)).toEqual(fixture[KEYS.run]);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual(
      (fixture[KEYS.queue] as { requests: readonly unknown[] }).requests
    );
  });

  it('writes the same bytes back when the loaded Run is re-persisted', async () => {
    // The read side proves nothing if the write side then adds the keys. This
    // round-trips through the real setter, which is the path a drain takes.
    const { store, memento, fixture } = await seededStore();
    const run = store.getRun(DEFAULT_QUEUE_ID);
    if (run === null) throw new Error('fixture must persist a Run');

    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));

    // Feature 093 (T027) — the byte comparison is against the Run under its
    // queue, because the record is now a map. Comparing the whole map to the
    // pre-feature fixture would only ever assert the reshape happened, which
    // `run-state-migrator-v10-to-v11.test.ts` already owns; the claim here is
    // that a write through the real setter adds no field to the Run itself.
    const persisted = memento.get<Record<string, unknown>>(KEYS.run);
    expect(JSON.stringify(persisted?.[DEFAULT_QUEUE_ID])).toBe(JSON.stringify(fixture[KEYS.run]));
  });

  it('re-persists every queue item with the same fields it was read with', async () => {
    // Deliberately deep equality on the requests rather than a byte comparison
    // of the whole queue: `setQueue` re-stamps the queue's own `updatedAt` and
    // normalizes key order on each request. That churn is pre-existing and
    // unrelated to this feature — what matters here is that no field appears or
    // disappears, which deep equality catches and byte comparison would drown.
    const { store, memento, fixture } = await seededStore();

    await store.setQueue(store.getQueue(DEFAULT_QUEUE_ID));

    // Feature 092 — `KEYS.queue` holds `Record<queueId, QueueState>`; the
    // fixture seeds the pre-v10 singular shape, which `initialize()` lifts.
    const stored = memento.get<Record<string, { requests: readonly FeatureRequest[] }>>(KEYS.queue);
    const persisted = fixture[KEYS.queue] as { requests: readonly unknown[] };
    expect(stored?.[DEFAULT_QUEUE_ID].requests).toEqual(persisted.requests);
  });
});

describe('a Run and a queue item built without the new fields serialize without them', () => {
  it('omits the keys entirely rather than writing them as undefined', async () => {
    // `{...run, runInputs: plan?.inputs}` writes `runInputs: undefined`, which
    // `toEqual` treats as absent and `JSON.stringify` drops — but `Object.keys`
    // does not, and neither does a memento that stores the object as-is. Pinning
    // the key set is what makes "written only when present" checkable.
    const { store, memento } = await seededStore();
    const run = store.getRun(DEFAULT_QUEUE_ID);
    if (run === null) throw new Error('fixture must persist a Run');

    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    const stored = memento.get<WorkflowRun>(KEYS.run);
    if (stored === undefined) throw new Error('setRun must persist');
    for (const key of RUN_KEYS) {
      expect(Object.keys(stored)).not.toContain(key);
    }

    const queue = store.getQueue(DEFAULT_QUEUE_ID);
    await store.setQueue(queue);
    const storedMap = memento.get<Record<string, { requests: readonly FeatureRequest[] }>>(KEYS.queue);
    const storedQueue = storedMap?.[DEFAULT_QUEUE_ID];
    if (storedQueue === undefined) throw new Error('setQueue must persist');
    for (const request of storedQueue.requests) {
      expect(Object.keys(request)).not.toContain(QUEUE_ITEM_KEY);
    }
  });
});
