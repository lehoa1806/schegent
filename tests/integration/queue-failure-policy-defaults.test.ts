// Feature 195 (T033, T034, FR-017, FR-018, SC-007) — a pre-feature record
// loads unchanged and adopts the workspace default, and the per-queue
// override/default relationship holds through changes to either side.
//
// T033 — the legacy-record scenario: a `QueueState` written before this
// feature (no `failurePolicy` key at all) loads without error under the
// current `STATE_SCHEMA_VERSION`, and reports an effective policy of
// `halt-on-failure` — the literal default, not merely "some default".
// `STATE_SCHEMA_VERSION` stays 14 and `store.initialize()` runs no migrator
// for it: the field's optionality is the whole compatibility story
// (data-model.md §2, research D2).
//
// T034 — the override-versus-default scenarios, exercised through the real
// production write path (`QueueManager.setFailurePolicy`) rather than the
// predicate alone, so the round trip through the store is what the
// assertions cover:
//   - a queue with no override follows the workspace default;
//   - an overridden queue keeps its own answer when the default changes;
//   - a queue returned to "follow the default" (`policy: null`) tracks the
//     workspace value again.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import { makeDefaultRegistry } from '../../src/queue/queue-registry';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import { STATE_SCHEMA_VERSION } from '../../src/contracts/state-schema';
import { effectiveQueueFailurePolicy } from '../../src/contracts/queue-failure-policy';
import { QueueManager } from '../../src/queue/queue-manager';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const NOW = 1_700_000_000_000;

function req(overrides: Partial<FeatureRequest>): FeatureRequest {
  return {
    id: 'r-default',
    description: 'sample',
    enqueuedAt: NOW,
    createdAt: NOW,
    startedAt: null,
    updatedAt: NOW,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position: 0,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...overrides
  } as FeatureRequest;
}

/**
 * A `QueueState` shaped exactly like a record written before this feature:
 * every field the v14 schema already required, and no `failurePolicy` key —
 * not `failurePolicy: undefined`, genuinely absent, the way a real Memento
 * value pre-dating the field would be.
 */
function legacyQueueState(): QueueState {
  // No `paused` field: that one is the *other* shape gate
  // (`migrateV12ToV13`'s collapse) and its presence, not its absence, is what
  // reads as "not yet migrated" — this fixture must not accidentally trip a
  // different migrator while simulating the one this feature added.
  const state: QueueState = {
    requests: [req({})],
    inFlightId: null,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
  expect('failurePolicy' in state).toBe(false);
  return state;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-195-defaults-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * A workspace at the current schema in every respect but this feature's
 * field: `KEYS.run` and `KEYS.history` are seeded in their already-migrated
 * map shape (`{}`), the same as a real workspace that has been opened before,
 * so `store.initialize()` has nothing else to normalise and the only
 * question this file's first scenario can be answering is the one about
 * `failurePolicy`.
 */
async function seedCurrentWorkspace(memento: FakeMemento): Promise<void> {
  await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  await memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
  await memento.update(KEYS.queueRegistry, makeDefaultRegistry(NOW));
  await memento.update(KEYS.queue, { [DEFAULT_QUEUE_ID]: legacyQueueState() });
  await memento.update(KEYS.run, {});
  await memento.update(KEYS.history, {});
}

describe('Feature 195 (T033) — a legacy record adopts the workspace default (FR-017, SC-007)', () => {
  it('loads without error under the current schema, with STATE_SCHEMA_VERSION unchanged and no migrator run', async () => {
    // 15: FR-R4-F02's credit-pause default moved the head, as each earlier bump moved this literal.
    // The claim this case pins is unchanged: feature 195 itself moved no version and ran no migrator.
    expect(STATE_SCHEMA_VERSION).toBe(15);

    const memento = new FakeMemento();
    await seedCurrentWorkspace(memento);

    const store = new WorkspaceStateStore(memento);
    const initResult = await store.initialize();

    // No migration ran: the record already satisfies the current schema
    // shape, because the new field is optional (research D2).
    expect(initResult.migrated).toBe(false);
    expect(STATE_SCHEMA_VERSION).toBe(15);

    const queueState = store.getQueue(DEFAULT_QUEUE_ID);
    expect(queueState.failurePolicy).toBeUndefined();
  });

  it("reports an effective policy of 'halt-on-failure' for a queue that has never stated an opinion", async () => {
    const memento = new FakeMemento();
    await seedCurrentWorkspace(memento);

    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    const queueState = store.getQueue(DEFAULT_QUEUE_ID);
    expect(effectiveQueueFailurePolicy(queueState.failurePolicy, 'halt-on-failure')).toBe(
      'halt-on-failure'
    );

    // The registry's own projection agrees — the same read the drain and the
    // sidebar make, not a second one this test invents.
    const projected = store.getProjectedQueueRegistry('halt-on-failure');
    const entry = projected.entries.find((e) => e.id === DEFAULT_QUEUE_ID)!;
    expect(entry.failurePolicy).toBe('halt-on-failure');
    expect(entry.failurePolicyOverride).toBeNull();
  });
});

describe('Feature 195 (T034) — override versus workspace default (FR-018)', () => {
  async function bootstrap(): Promise<{ store: WorkspaceStateStore; queue: QueueManager }> {
    const memento = new FakeMemento();
    await seedCurrentWorkspace(memento);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    return { store, queue: new QueueManager(store) };
  }

  it('a queue with no override follows the workspace default', async () => {
    const { store } = await bootstrap();

    expect(store.getProjectedQueueRegistry('halt-on-failure').entries[0]!.failurePolicy).toBe(
      'halt-on-failure'
    );
    expect(store.getProjectedQueueRegistry('continue').entries[0]!.failurePolicy).toBe('continue');
  });

  it('an overridden queue keeps its own answer when the default changes', async () => {
    const { store, queue } = await bootstrap();

    const result = await queue.setFailurePolicy(DEFAULT_QUEUE_ID, 'continue');
    expect(result.ok).toBe(true);

    // The default flips both ways; the override does not move.
    expect(store.getProjectedQueueRegistry('halt-on-failure').entries[0]!.failurePolicy).toBe(
      'continue'
    );
    expect(store.getProjectedQueueRegistry('continue').entries[0]!.failurePolicy).toBe('continue');
  });

  it('a queue returned to "follow the default" tracks the workspace value again', async () => {
    const { store, queue } = await bootstrap();

    await queue.setFailurePolicy(DEFAULT_QUEUE_ID, 'continue');
    expect(store.getProjectedQueueRegistry('halt-on-failure').entries[0]!.failurePolicy).toBe(
      'continue'
    );

    const cleared = await queue.setFailurePolicy(DEFAULT_QUEUE_ID, null);
    expect(cleared.ok).toBe(true);
    expect(store.getQueue(DEFAULT_QUEUE_ID).failurePolicy).toBeUndefined();

    // Tracks the default again — both readings, proving it is live rather
    // than pinned to whatever the default was at the moment of the clear.
    expect(store.getProjectedQueueRegistry('halt-on-failure').entries[0]!.failurePolicy).toBe(
      'halt-on-failure'
    );
    expect(store.getProjectedQueueRegistry('continue').entries[0]!.failurePolicy).toBe('continue');
  });
});
