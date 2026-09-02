// FR-R3-152 (T1631) — extracted from `auto-drain.test.ts` so `makeCoordinator`
// can be reused by `queue-lifecycle.test.ts` (research.md D7) without
// re-executing `auto-drain.test.ts`'s own `describe`/`it` blocks a second
// time. Importing a `.test.ts` file for a named export still runs every
// top-level `describe()` call in it at import time, registering its suite
// again under the importing file — this module holds no test registrations,
// only the fixture, so it can be imported freely.
//
// `auto-drain.test.ts` remains the one place this fixture's shape is decided;
// it now imports from here too, so there is exactly one definition.

import { vi } from 'vitest';
import { AutoDrainCoordinator } from '../../../src/services/auto-drain-coordinator';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueLifecycle } from '../../../src/queue/feature-request';

export interface StepSpies {
  readonly getQueue: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly hasQueueCapacity: ReturnType<typeof vi.fn>;
  readonly hasExecutionCapacity: ReturnType<typeof vi.fn>;
  readonly hasWorkspaceCapacity: ReturnType<typeof vi.fn>;
  readonly peekNextPending: ReturnType<typeof vi.fn>;
  readonly tryAcquire: ReturnType<typeof vi.fn>;
  readonly admitNew: ReturnType<typeof vi.fn>;
}

/**
 * A coordinator whose every step is a spy, so a test can assert both what was
 * consulted and what was not. Each `stopAt` value fails exactly one step.
 */
export function makeCoordinator(
  stopAt:
    | 'none'
    | 'lifecycle'
    | 'paused'
    | 'queue-capacity'
    | 'queue-run-slot'
    | 'execution-capacity'
    | 'workspace-capacity'
    | 'pending'
    | 'lease',
  queueId: string = DEFAULT_QUEUE_ID
): { coord: AutoDrainCoordinator; spies: StepSpies } {
  // FR-R3-011 — both stop conditions are now the same field. `'paused'` used to
  // be seeded through the legacy `paused` mirror while the lifecycle stayed
  // `active-empty`; step 2 reads `queueLifecycle` like step 1 does, so the
  // scenario has to say `operator-paused` or it seeds nothing at all.
  const lifecycle: QueueLifecycle =
    stopAt === 'lifecycle' ? 'idle-pending' : stopAt === 'paused' ? 'operator-paused' : 'active-empty';
  const spies: StepSpies = {
    getQueue: vi.fn(() => ({
      queueLifecycle: lifecycle,
      pauseSource: stopAt === 'paused' ? 'operator' : null,
      inFlightId: null
    })),
    // BUG-003 — step 3's second reading. A paused Run holds its queue's one Run
    // slot while leaving the in-flight Task count that `hasQueueCapacity` reads,
    // so the two readings answer "is this queue busy?" from different sides.
    getRun: vi.fn(() =>
      stopAt === 'queue-run-slot' ? { id: 'run-held', status: 'paused' } : null
    ),
    hasQueueCapacity: vi.fn(() => stopAt !== 'queue-capacity'),
    hasExecutionCapacity: vi.fn(() => stopAt !== 'execution-capacity'),
    hasWorkspaceCapacity: vi.fn(() => stopAt !== 'workspace-capacity'),
    peekNextPending: vi.fn(() =>
      stopAt === 'pending' ? null : { id: 'task-1', description: 'next', queueId }
    ),
    tryAcquire: vi.fn(async () => ({
      acquired: stopAt !== 'lease',
      ownerId: stopAt === 'lease' ? 'other-window' : 'this-window'
    })),
    admitNew: vi.fn(async () => ({ completed: Promise.resolve() }))
  };
  const coord = new AutoDrainCoordinator({
    store: { getQueue: spies.getQueue, getRun: spies.getRun } as never,
    queue: {
      peekNextPending: spies.peekNextPending,
      hasQueueCapacity: spies.hasQueueCapacity,
      hasExecutionCapacity: spies.hasExecutionCapacity,
      hasWorkspaceCapacity: spies.hasWorkspaceCapacity
    } as never,
    executionLease: { tryAcquire: spies.tryAcquire, release: vi.fn(async () => undefined) } as never,
    controller: {
      admitNew: spies.admitNew,
      admitResume: vi.fn(async () => ({ resumed: false, completed: Promise.resolve() })),
      // A controller with no sessions genuinely drives nothing; every gate this
      // file pins is chosen by its own spy, not by the live-Run count.
      liveRunCount: 0
    } as never
  });
  return { coord, spies };
}
