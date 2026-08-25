// FR-R3-011 (T426) — one persisted answer to "is this queue paused".
//
// The collapse moved pausedness from three persisted representations across two
// memento keys to one: `QueueState.queueLifecycle === 'operator-paused'`, with
// `QueueState.pauseSource` carrying the attribution beside it in the same entry
// of the same key. `QueueRegistryEntry.state` / `pauseSource` are derived on
// read by `projectQueueRegistry()`, and `QueueState.paused` / `pausedReason`
// became migration input.
//
// This file is the end-to-end half of that claim, and it asserts the two things
// unit tests over the migrator cannot:
//
//   - **Precedence survived the collapse.** Cascade and operator pause were
//     distinguished by `QueueRegistryEntry.pauseSource`, a field that no longer
//     persists. Every rule feature 028 stated — operator wins, operator is never
//     demoted to cascade, `cascadedResume` is a strict no-op on an operator
//     pause — has to hold when the same facts are read off the queue record.
//   - **The drain refuses on that one value.** `drainIfIdle` step 2 used to read
//     the legacy `paused` mirror. A record written after the collapse carries no
//     mirror, so the old read was `undefined` on every queue and the step
//     refused nothing; the gate is exercised here through the real coordinator
//     rather than a spy over its steps, because the defect was in what the step
//     read, not in whether it ran.
//
// The controller is a double for the same reason `concurrent-drain.test.ts`
// doubles it: what is under test is the admission *decision*, and a real
// `RunDriver` would spawn a CLI to answer a question the gate already settled.

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStateStore, KEYS, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { AutoDrainCoordinator } from '../../../src/services/auto-drain-coordinator';
import { findQueue, DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { FeatureRequest } from '../../../src/queue/feature-request';

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

interface Harness {
  readonly memento: FakeMemento;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly autoDrain: AutoDrainCoordinator;
  /** Every admission the drain performed, in order. */
  readonly admitted: string[];
  /** The single persisted answer, as the queue record holds it. */
  pauseOf(queueId?: string): { lifecycle: string; source: string | null };
  /** The registry-facing answer, as `projectQueueRegistry()` derives it. */
  projectedPauseOf(queueId?: string): { state: string | undefined; source: string | null | undefined };
}

async function makeHarness(memento: FakeMemento = new FakeMemento()): Promise<Harness> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const admitted: string[] = [];
  let runSeq = 0;
  let liveRuns = 0;

  const controller = {
    admitNew: async (request: FeatureRequest) => {
      await queue.markInFlight(request.id, `run-${++runSeq}`);
      liveRuns++;
      admitted.push(request.id);
      return { completed: Promise.resolve() };
    },
    admitResume: async () => ({ resumed: false, completed: Promise.resolve() }),
    get liveRunCount(): number {
      return liveRuns;
    }
  };

  const autoDrain = new AutoDrainCoordinator({
    store,
    queue,
    // Granting, and deliberately so: an execution lease that refused would make
    // every refusal below indistinguishable from a lost lease at step 6. The
    // only gate this file is entitled to attribute a refusal to is step 2.
    executionLease: {
      tryAcquire: async () => ({ acquired: true, ownerId: 'this-window' }),
      release: () => {},
      // FR-R3-077 — no lease record behind this double, so no claim to give. The
      // store's commit points record that as `lease-not-held` rather than
      // pretending to a fence this double never had.
      claimFor: () => null
    },
    controller: controller as unknown as SchegentWorkflowController
  });

  return {
    memento,
    store,
    queue,
    autoDrain,
    admitted,
    pauseOf(queueId: string = DEFAULT_QUEUE_ID) {
      const state = store.getQueue(queueId);
      return { lifecycle: state.queueLifecycle, source: state.pauseSource ?? null };
    },
    projectedPauseOf(queueId: string = DEFAULT_QUEUE_ID) {
      const entry = findQueue(store.getProjectedQueueRegistry(), queueId);
      return { state: entry?.state, source: entry?.pauseSource };
    }
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

describe('FR-R3-011 — cascade versus operator precedence on the single value', () => {
  it('a cascade pause over an operator pause is a no-op and never demotes the source', async () => {
    await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');
    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'operator' });

    const cascade = await h.queue.cascadedPause(DEFAULT_QUEUE_ID);

    // Feature 028's rule, restated on the surviving field: `operator-paused →
    // no-op (operator wins; never demoted to cascade)`. The attribution is what
    // makes the rule observable, and it now lives on the queue record.
    //
    // A no-op reports `ok: true` — the cascade asked for a paused queue and got
    // one, and `ok: false` is reserved for a request that could not be honoured
    // at all. The rule is therefore stated over the state, not the verdict.
    expect(cascade.ok).toBe(true);
    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'operator' });
    expect(h.projectedPauseOf()).toEqual({ state: 'manually-paused', source: 'operator' });
  });

  it('cascade-resume is a strict no-op against an operator pause', async () => {
    await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');

    const resumed = await h.queue.cascadedResume(DEFAULT_QUEUE_ID);

    // The operator asked for this pause; the phase that cascaded did not, and a
    // cascade ending is not consent to lift one. As above, the no-op is a
    // success — the caller is told nothing went wrong, and the pause stands.
    expect(resumed.ok).toBe(true);
    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'operator' });
  });

  it('cascade-resume lifts a cascade pause and clears the attribution', async () => {
    await h.queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'cascade' });
    expect(h.projectedPauseOf()).toEqual({ state: 'manually-paused', source: 'cascade' });

    await h.queue.cascadedResume(DEFAULT_QUEUE_ID);

    expect(h.pauseOf().lifecycle).not.toBe('operator-paused');
    expect(h.pauseOf().source).toBeNull();
    expect(h.projectedPauseOf()).toEqual({ state: 'active', source: null });
  });

  it('an operator pause over a cascade pause takes the attribution, and cascade-resume cannot lift it', async () => {
    await h.queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(h.pauseOf().source).toBe('cascade');

    // Not idempotent across sources: a pause whose source differs overwrites the
    // attribution rather than reporting `already-paused`, which is what lets the
    // resume side know what it is allowed to clear.
    const escalated = await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');
    expect(escalated.ok).toBe(true);
    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'operator' });

    await h.queue.cascadedResume(DEFAULT_QUEUE_ID);

    expect(h.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'operator' });
  });
});

describe('FR-R3-011 — the drain refuses on the same value it is written to', () => {
  it('promotes a pending head while the queue is not paused', async () => {
    // The control. Without it, every refusal below could be a harness that never
    // promotes anything.
    const task = await h.queue.enqueue('control task');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    expect(h.admitted).toEqual([task.id]);
  });

  it('refuses to promote a pending head on an operator-paused queue', async () => {
    const task = await h.queue.enqueue('task behind an operator pause');
    await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    expect(h.admitted).toEqual([]);
    // A refusal is a wait, not an error: nothing is written and the Task is
    // still the pending head for the next sweep.
    expect(h.queue.findById(task.id)?.status).toBe('pending');
  });

  it('refuses to promote a pending head on a cascade-paused queue, on the same field', async () => {
    const task = await h.queue.enqueue('task behind a cascade pause');
    await h.queue.cascadedPause(DEFAULT_QUEUE_ID);

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    // The drain does not read the attribution and must not learn to: pausedness
    // is one field, and a gate that distinguished the two sources would be a
    // second place where "is this queue paused" is decided.
    expect(h.admitted).toEqual([]);
    expect(h.queue.findById(task.id)?.status).toBe('pending');
  });

  it('still refuses immediately after a resume, at the idle-pending gate rather than the pause gate', async () => {
    await h.queue.enqueue('task that outlives the pause');
    await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');
    await h.queue.setQueuePausedState(false, DEFAULT_QUEUE_ID);

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    // Feature 065's FR-019, unchanged by the collapse and asserted here so it is
    // not mistaken for the pause refusal above and "fixed": a resume with
    // pending work lands in `idle-pending`, and leaving that state is an
    // operator or scheduled-start decision. The pause is genuinely gone — the
    // field says so — and the queue still does not promote itself.
    expect(h.pauseOf()).toEqual({ lifecycle: 'idle-pending', source: null });
    expect(h.admitted).toEqual([]);
  });
});

describe('FR-R3-011 — one write, so there is nothing left to reconcile', () => {
  it('persists the pause on the queue record only, and derives the registry answer on read', async () => {
    await h.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'retry cap reached', 'retry-cap');

    const persistedRegistry = h.memento.get<{ entries: readonly Record<string, unknown>[] }>(
      KEYS.queueRegistry
    );
    const persistedEntry = persistedRegistry?.entries.find((e) => e.id === DEFAULT_QUEUE_ID);

    // The registry entry is where two of the three old representations lived.
    // Their absence from the persisted record is the collapse: there is no
    // second copy to drift, so there is no divergence for a startup pass to
    // repair — which is why `reconcileQueuePauseStateIfDivergent()` could be
    // deleted rather than made stricter.
    expect(persistedEntry).toBeDefined();
    expect(persistedEntry).not.toHaveProperty('state');
    expect(persistedEntry).not.toHaveProperty('pauseSource');

    // And the derived answer still carries both halves, including a source the
    // registry never had a column for.
    expect(h.projectedPauseOf()).toEqual({ state: 'manually-paused', source: 'retry-cap' });
  });

  it('answers identically when the window is disposed mid-pause and the workspace is reopened', async () => {
    await h.queue.cascadedPause(DEFAULT_QUEUE_ID);

    // The window disposal the old dual-write could not survive. Under two keys
    // and no memento transaction, a disposal between the registry write and the
    // queue write left the pair split; one write cannot be split, so a reopened
    // store reads the same pause it was given.
    const reopened = await makeHarness(h.memento);

    expect(reopened.pauseOf()).toEqual({ lifecycle: 'operator-paused', source: 'cascade' });
    expect(reopened.projectedPauseOf()).toEqual({ state: 'manually-paused', source: 'cascade' });
  });

  it('leaves a queue that resolves to not-paused with its lifecycle untouched', async () => {
    // The half of the winner rule that is easy to lose: "any representation
    // reading paused wins" governs disagreement, and a queue that is not paused
    // keeps whatever lifecycle it holds. Re-deriving it from
    // `(inFlightId, paused, pendingCount)` is precisely what let the retired
    // reconciler overwrite a legitimately held `idle-pending`.
    await h.queue.enqueue('armed');
    await h.store.updateQueue(
      (current) => ({
        queue: {
          ...current,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: Date.now() + 60_000,
          // `ScheduledStartSource`, not `QueuePauseSource` — the two unions sit
          // side by side on `QueueState` and neither shares a member with the
          // other. This one is the operator arming a start from the chooser.
          scheduledStartSource: 'operator-chooser'
        },
        result: undefined
      }),
      DEFAULT_QUEUE_ID
    );

    const reopened = await makeHarness(h.memento);

    expect(reopened.pauseOf()).toEqual({ lifecycle: 'idle-pending', source: null });
    expect(reopened.store.getQueue(DEFAULT_QUEUE_ID).scheduledStartAt).not.toBeNull();
    expect(reopened.projectedPauseOf()).toEqual({ state: 'active', source: null });
  });
});
