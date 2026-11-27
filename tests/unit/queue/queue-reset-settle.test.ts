// FR-R3-150 (T1619c) — the two rules `QueueManager.clearQueue` and
// `QueueManager.clearAll` share, tested directly.
//
// The integration suites for both methods assert the rules through a store and
// a memento, which is where the LC-Q-05 regressions would actually surface.
// These cases pin the rules themselves: the field set is complete (a reset
// that forgets a field is the defect LC-Q-05 was), the two pause-release modes
// differ in exactly one pair of fields, and the no-op predicate counts both
// held surfaces the workspace-wide gate used to read past.

import { describe, it, expect } from 'vitest';
import {
  hasResettableQueueState,
  queueResetFields,
  type PauseReleaseMode
} from '../../../src/queue/queue-reset-settle';
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';

const NOW = 1_700_000_000_000;

function task(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id: 'task-1',
    queueId: 'q1',
    description: 'a task',
    status: 'pending',
    position: 0,
    enqueuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...overrides
  };
}

function queueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    requests: [],
    inFlightId: null,
    pausedReason: null,
    updatedAt: NOW - 1,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...overrides
  };
}

describe('queueResetFields — the field rule both resets write', () => {
  it('settles every field a reset owns, for either mode', () => {
    const dirty = queueState({
      requests: [task(), task({ id: 'task-2', status: 'completed' })],
      inFlightId: 'task-1',
      pausedReason: 'maintenance',
      queueLifecycle: 'idle-pending',
      scheduledStartAt: NOW + 60_000,
      scheduledStartSource: 'operator-chooser'
    });

    for (const mode of ['release-pause', 'defer-pause-release'] as PauseReleaseMode[]) {
      const fields = queueResetFields(dirty, NOW, mode);
      expect(fields.requests).toEqual([]);
      expect(fields.inFlightId).toBeNull();
      expect(fields.pausedReason).toBeNull();
      expect(fields.pauseSource).toBeNull();
      expect(fields.queueLifecycle).toBe('active-empty');
      expect(fields.scheduledStartAt).toBeNull();
      expect(fields.scheduledStartSource).toBeNull();
      expect(fields.updatedAt).toBe(NOW);
      // The exact key set, so a field added to `QueueState` that a reset must
      // clear cannot be silently omitted here.
      expect(Object.keys(fields).sort()).toEqual([
        'inFlightId',
        'pauseSource',
        'pausedReason',
        'queueLifecycle',
        'requests',
        'scheduledStartAt',
        'scheduledStartSource',
        'updatedAt'
      ]);
    }
  });

  it('leaves the schedule fields null even when the lifecycle is preserved', () => {
    // The pairing rule (AGENTS 31-33) runs the other way too: a preserved
    // `operator-paused` must not carry a schedule, and a pause never coexists
    // with one anyway — but the rule holds regardless of the input.
    const paused = queueState({
      queueLifecycle: 'operator-paused',
      pauseSource: 'operator',
      scheduledStartAt: NOW + 60_000,
      scheduledStartSource: 'operator-chooser'
    });
    const fields = queueResetFields(paused, NOW, 'defer-pause-release');
    expect(fields.queueLifecycle).toBe('operator-paused');
    expect(fields.scheduledStartAt).toBeNull();
    expect(fields.scheduledStartSource).toBeNull();
  });

  it('release-pause clears an operator pause; defer-pause-release preserves it', () => {
    const paused = queueState({
      queueLifecycle: 'operator-paused',
      pauseSource: 'cascade',
      pausedReason: 'retry-cap-exhausted:run-1'
    });

    const released = queueResetFields(paused, NOW, 'release-pause');
    expect(released.queueLifecycle).toBe('active-empty');
    expect(released.pauseSource).toBeNull();

    // Deferred: the lifecycle and the source survive for the later
    // `setQueuePausedState(false, …)` step, whose already-not-paused early
    // return would otherwise swallow the pause release entirely.
    const deferred = queueResetFields(paused, NOW, 'defer-pause-release');
    expect(deferred.queueLifecycle).toBe('operator-paused');
    expect(deferred.pauseSource).toBe('cascade');
    // `pausedReason` is cleared by both — it is not what the deferred step
    // reads to decide whether a pause is live.
    expect(deferred.pausedReason).toBeNull();
  });

  it('defer-pause-release preserves nothing on a queue that is not paused', () => {
    const running = queueState({ queueLifecycle: 'running', inFlightId: 'task-1' });
    const fields = queueResetFields(running, NOW, 'defer-pause-release');
    expect(fields.queueLifecycle).toBe('active-empty');
    expect(fields.pauseSource).toBeNull();
  });

  it('never writes the retired `paused` mirror (FR-R3-011)', () => {
    const fields = queueResetFields(queueState({ paused: true }), NOW, 'release-pause');
    expect('paused' in fields).toBe(false);
  });
});

describe('hasResettableQueueState — the no-op predicate both resets read', () => {
  it('a fully settled queue holds nothing to reset', () => {
    expect(hasResettableQueueState(queueState())).toBe(false);
  });

  it.each([
    ['pending tasks', queueState({ requests: [task()] })],
    ['terminal tasks only', queueState({ requests: [task({ status: 'completed' })] })],
    ['an in-flight id', queueState({ inFlightId: 'task-1', queueLifecycle: 'running' })],
    ['an operator pause', queueState({ queueLifecycle: 'operator-paused', pauseSource: 'operator' })],
    ['idle-pending with no schedule', queueState({ queueLifecycle: 'idle-pending' })],
    [
      'an armed schedule',
      queueState({
        queueLifecycle: 'idle-pending',
        scheduledStartAt: NOW + 60_000,
        scheduledStartSource: 'operator-chooser'
      })
    ]
  ])('counts %s as state to reset', (_label, state) => {
    expect(hasResettableQueueState(state)).toBe(true);
  });

  it('an armed schedule alone is dirty state — the LC-Q-05 case', () => {
    // The exact shape the workspace-wide gate reported as already clean: no
    // tasks, nothing in flight, no pause. Only the held lifecycle and the
    // armed timestamp, and the timer they stood for outlived the reset.
    const scheduleOnly = queueState({
      queueLifecycle: 'idle-pending',
      scheduledStartAt: NOW + 60_000,
      scheduledStartSource: 'operator-chooser'
    });
    expect(scheduleOnly.requests).toEqual([]);
    expect(scheduleOnly.inFlightId).toBeNull();
    expect(hasResettableQueueState(scheduleOnly)).toBe(true);
  });
});
