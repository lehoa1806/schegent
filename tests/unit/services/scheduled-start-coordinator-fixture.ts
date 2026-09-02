// FR-R3-152 (T1634) — extracted from `scheduled-start-coordinator.test.ts` so
// `tests/integration/queue-runtime-schedule-isolation.test.ts` can reuse
// `makeHarness` (research.md D7) without re-running that file's own suite a
// second time. Importing a `.test.ts` file for a named export still executes
// every top-level `describe()` call in it at import time; this module holds
// no test registrations, only the fixture.
//
// `scheduled-start-coordinator.test.ts` remains the one place this fixture's
// shape is decided; it now imports from here too, so there is exactly one
// definition.

import { expect, vi } from 'vitest';
import {
  ScheduledStartCoordinator,
  type ScheduledStartCoordinatorDeps
} from '../../../src/services/scheduled-start-coordinator';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueState } from '../../../src/queue/feature-request';

export const QUEUE_A = DEFAULT_QUEUE_ID;
export const QUEUE_B = '11111111-2222-4333-8444-555555555555';
export const QUEUE_C = '22222222-3333-4444-8555-666666666666';

/** A fake timer handle that records nothing but its own identity. */
export type FakeHandle = { readonly id: number } & NodeJS.Timeout;

export interface Harness {
  readonly coord: ScheduledStartCoordinator;
  /** Handles handed out by `setTimer`, in creation order. */
  readonly created: FakeHandle[];
  /** Handles passed to `clearTimer`, in call order. */
  readonly cleared: FakeHandle[];
  /** Runs the callback registered for `handle`, as the event loop would. */
  runTimer(handle: FakeHandle): Promise<void>;
  /** Sets one queue's persisted state. */
  setQueueState(queueId: string, patch: Partial<QueueState>): void;
  readonly audits: Array<{ eventType: string; payload: Record<string, unknown> }>;
  readonly fired: string[];
  now(): number;
  advance(ms: number): void;
}

export const NOW_BASE = 1_700_000_000_000;

export function idlePending(scheduledStartAt: number): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW_BASE,
    queueLifecycle: 'idle-pending',
    pauseSource: null,
    scheduledStartAt,
    scheduledStartSource: 'operator-chooser',
    migrationNotice: null
  } as unknown as QueueState;
}

/**
 * `overrides` is Feature 098 (T082): the empty-catalog gate is an optional dep,
 * and every case above is written against a coordinator that does not carry
 * one. Merging at construction keeps those cases exercising exactly the deps
 * they always did.
 */
export function makeHarness(overrides: Partial<ScheduledStartCoordinatorDeps> = {}): Harness {
  let clock = NOW_BASE;
  const created: FakeHandle[] = [];
  const cleared: FakeHandle[] = [];
  const callbacks = new Map<FakeHandle, () => void>();
  const states = new Map<string, QueueState>();
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const fired: string[] = [];
  let nextId = 1;

  const deps: ScheduledStartCoordinatorDeps = {
    store: {
      // Feature 092 — addressed. A coordinator that ignored `queueId` here
      // would let queue A's lifecycle decide queue B's supersession.
      getQueue: ((queueId: string = DEFAULT_QUEUE_ID) =>
        states.get(queueId) ??
        ({
          requests: [],
          inFlightId: null,
          paused: false,
          pausedReason: null,
          updatedAt: clock,
          queueLifecycle: 'active-empty',
          pauseSource: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          migrationNotice: null
        } as unknown as QueueState)) as never,
      // Feature 092 — `reArm()` can no longer hardcode `'default'`; it has to
      // ask which queues carry persisted execution state.
      getQueueStates: (() => Object.fromEntries(states.entries())) as never
      // FR-R3-002 (T284) — no `updateQueue` double. The coordinator's store
      // Pick is read-only now that the lock-unavailable branch retains the
      // persisted deadline instead of erasing it, so a writer here would be a
      // seam the subject cannot reach.
    },
    auditWriter: {
      append: async (entry: { eventType: string; payload: Record<string, unknown> }) => {
        audits.push({ eventType: entry.eventType, payload: entry.payload });
      }
    } as never,
    logger: { warn: vi.fn() } as never,
    onFire: (queueId: string) => {
      fired.push(queueId);
    },
    now: () => clock,
    setTimer: (fn: () => void, _ms: number) => {
      const handle = { id: nextId++ } as FakeHandle;
      created.push(handle);
      callbacks.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: NodeJS.Timeout) => {
      cleared.push(handle as FakeHandle);
      callbacks.delete(handle as FakeHandle);
    }
  };

  const coord = new ScheduledStartCoordinator({ ...deps, ...overrides });

  return {
    coord,
    created,
    cleared,
    async runTimer(handle: FakeHandle): Promise<void> {
      const cb = callbacks.get(handle);
      expect(cb, `no callback registered for handle ${handle.id}`).toBeDefined();
      cb!();
      // `fire()` is dispatched with `void`; let its microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    setQueueState(queueId: string, patch: Partial<QueueState>): void {
      const base = states.get(queueId) ?? idlePending(NOW_BASE + 60_000);
      states.set(queueId, { ...base, ...patch } as QueueState);
    },
    audits,
    fired,
    now: () => clock,
    advance(ms: number): void {
      clock += ms;
    }
  };
}
