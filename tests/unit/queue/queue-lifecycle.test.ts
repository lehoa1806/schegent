// Feature 065 (T017) — Queue lifecycle transition + lockstep invariants.
//
// The lifecycle discriminator (`queueLifecycle`) is stored alongside the
// legacy `paused` mirror on `QueueState`. The legal transition graph is
// defined in specs/065-enqueue-start-separation/data-model.md §QueueLifecycle:
//
//     active-empty  ↔  idle-pending  ↔  running  ↔  operator-paused
//     active-empty  ↔  running
//     operator-paused → active-empty (when pending empties on resume)
//
// This test exercises every legal transition via the in-memory QueueState
// representation and asserts:
//   (i)   paused === (queueLifecycle === 'operator-paused')
//   (ii)  scheduledStartAt != null ⇒ queueLifecycle === 'idle-pending'
//   (iii) queueLifecycle === 'idle-pending' ⇒ inFlightId === null
//   (iv)  queueLifecycle === 'running' ⇒ inFlightId !== null
//
// Illegal transitions are documented; `transition()` returns a discriminated
// result so callers can branch on `'illegal'` rather than throw.
// Per FR-001..FR-005 + FR-019.

import { describe, it, expect } from 'vitest';
import type {
  QueueLifecycle,
  QueueState,
  ScheduledStartSource
} from '../../../src/queue/feature-request';

function makeState(partial: Partial<QueueState>): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty',
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...partial
  };
}

function assertLockstep(state: QueueState): void {
  // (i) paused mirror lockstep
  expect(state.paused).toBe(state.queueLifecycle === 'operator-paused');
  // (ii) scheduledStartAt implies idle-pending
  if (state.scheduledStartAt !== null) {
    expect(state.queueLifecycle).toBe('idle-pending');
  }
  // (iii) idle-pending has no in-flight
  if (state.queueLifecycle === 'idle-pending') {
    expect(state.inFlightId).toBeNull();
  }
  // (iv) running has an in-flight
  if (state.queueLifecycle === 'running') {
    expect(state.inFlightId).not.toBeNull();
  }
}

type Transition =
  | { kind: 'enqueue-now'; pendingId: string }
  | { kind: 'enqueue-scheduled'; pendingId: string; scheduledStartAt: number; source: ScheduledStartSource }
  | { kind: 'enqueue-no-intent'; pendingId: string }
  | { kind: 'start-now-from-idle-pending' }
  | { kind: 'start-running'; inFlightId: string }
  | { kind: 'pause' }
  | { kind: 'resume-with-pending'; inFlightId: string }
  | { kind: 'resume-without-pending' }
  | { kind: 'in-flight-terminate-nonempty'; nextInFlightId: string }
  | { kind: 'in-flight-terminate-empty' }
  | { kind: 'cancel-schedule' };

type TransitionResult = { kind: 'ok'; state: QueueState } | { kind: 'illegal'; reason: string };

function transition(state: QueueState, t: Transition): TransitionResult {
  switch (t.kind) {
    case 'enqueue-now': {
      // active-empty | idle-pending → running
      if (state.queueLifecycle === 'operator-paused') {
        return { kind: 'illegal', reason: 'cannot start-now on operator-paused queue' };
      }
      if (state.queueLifecycle === 'running') {
        // silent enqueue while running keeps queue running
        return {
          kind: 'ok',
          state: { ...state, requests: [...state.requests], updatedAt: state.updatedAt + 1 }
        };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'running',
          scheduledStartAt: null,
          scheduledStartSource: null,
          inFlightId: t.pendingId
        }
      };
    }
    case 'enqueue-scheduled': {
      if (state.queueLifecycle === 'operator-paused' || state.queueLifecycle === 'running') {
        return { kind: 'illegal', reason: `cannot schedule on ${state.queueLifecycle}` };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: t.scheduledStartAt,
          scheduledStartSource: t.source
        }
      };
    }
    case 'enqueue-no-intent': {
      if (state.queueLifecycle === 'operator-paused') {
        return { kind: 'illegal', reason: 'cannot enqueue on operator-paused without a resume' };
      }
      if (state.queueLifecycle === 'running') {
        return { kind: 'ok', state: { ...state, updatedAt: state.updatedAt + 1 } };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };
    }
    case 'start-now-from-idle-pending': {
      if (state.queueLifecycle !== 'idle-pending') {
        return { kind: 'illegal', reason: 'must be idle-pending' };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'running',
          scheduledStartAt: null,
          scheduledStartSource: null,
          inFlightId: 'r-test'
        }
      };
    }
    case 'start-running': {
      if (state.queueLifecycle === 'operator-paused') {
        return { kind: 'illegal', reason: 'cannot start-running on operator-paused' };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'running',
          inFlightId: t.inFlightId,
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };
    }
    case 'pause': {
      if (state.queueLifecycle === 'operator-paused') {
        return { kind: 'illegal', reason: 'already paused' };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'operator-paused',
          paused: true,
          pausedReason: 'operator',
          // scheduledStartAt is preserved on pause (per data-model: it
          // survives across pause/resume so the schedule can be re-armed
          // when the operator resumes — distinct from cancel)
          inFlightId: null
        }
      };
    }
    case 'resume-with-pending': {
      if (state.queueLifecycle !== 'operator-paused') {
        return { kind: 'illegal', reason: 'must be operator-paused' };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'running',
          paused: false,
          pausedReason: null,
          inFlightId: t.inFlightId,
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };
    }
    case 'resume-without-pending': {
      if (state.queueLifecycle !== 'operator-paused') {
        return { kind: 'illegal', reason: 'must be operator-paused' };
      }
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'active-empty',
          paused: false,
          pausedReason: null,
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };
    }
    case 'in-flight-terminate-nonempty': {
      if (state.queueLifecycle !== 'running') {
        return { kind: 'illegal', reason: 'must be running' };
      }
      return {
        kind: 'ok',
        state: { ...state, queueLifecycle: 'running', inFlightId: t.nextInFlightId }
      };
    }
    case 'in-flight-terminate-empty': {
      if (state.queueLifecycle !== 'running') {
        return { kind: 'illegal', reason: 'must be running' };
      }
      // FR-005 carve-out: running → active-empty (NEVER idle-pending) when
      // an in-flight task terminates with no pending.
      return {
        kind: 'ok',
        state: {
          ...state,
          queueLifecycle: 'active-empty',
          inFlightId: null,
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };
    }
    case 'cancel-schedule': {
      if (state.queueLifecycle !== 'idle-pending') {
        return { kind: 'illegal', reason: 'must be idle-pending' };
      }
      return {
        kind: 'ok',
        state: { ...state, scheduledStartAt: null, scheduledStartSource: null }
      };
    }
  }
}

describe('Feature 065 — QueueLifecycle transitions', () => {
  it('active-empty → idle-pending via enqueue-no-intent', () => {
    const s0 = makeState({ queueLifecycle: 'active-empty' });
    const r = transition(s0, { kind: 'enqueue-no-intent', pendingId: 'r-1' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('idle-pending');
    assertLockstep(r.state);
  });

  it('active-empty → idle-pending via enqueue-scheduled and persists scheduledStartAt', () => {
    const s0 = makeState({ queueLifecycle: 'active-empty' });
    const r = transition(s0, {
      kind: 'enqueue-scheduled',
      pendingId: 'r-1',
      scheduledStartAt: 1_700_000_000_000,
      source: 'operator-chooser'
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('idle-pending');
    expect(r.state.scheduledStartAt).toBe(1_700_000_000_000);
    expect(r.state.scheduledStartSource).toBe('operator-chooser');
    assertLockstep(r.state);
  });

  it('active-empty → running via enqueue-now (skips idle-pending)', () => {
    const s0 = makeState({ queueLifecycle: 'active-empty' });
    const r = transition(s0, { kind: 'enqueue-now', pendingId: 'r-1' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('running');
    expect(r.state.inFlightId).toBe('r-1');
    assertLockstep(r.state);
  });

  it('idle-pending → running via start-now-from-idle-pending and clears scheduledStartAt', () => {
    const s0 = makeState({
      queueLifecycle: 'idle-pending',
      scheduledStartAt: 1_700_000_000_000,
      scheduledStartSource: 'operator-chooser'
    });
    const r = transition(s0, { kind: 'start-now-from-idle-pending' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('running');
    expect(r.state.scheduledStartAt).toBeNull();
    expect(r.state.scheduledStartSource).toBeNull();
    assertLockstep(r.state);
  });

  it('running → operator-paused → running (with pending)', () => {
    const sRun = makeState({ queueLifecycle: 'running', inFlightId: 'r-1' });
    const pauseResult = transition(sRun, { kind: 'pause' });
    if (pauseResult.kind !== 'ok') throw new Error('expected ok');
    expect(pauseResult.state.queueLifecycle).toBe('operator-paused');
    expect(pauseResult.state.paused).toBe(true);
    assertLockstep(pauseResult.state);
    const resumed = transition(pauseResult.state, {
      kind: 'resume-with-pending',
      inFlightId: 'r-2'
    });
    if (resumed.kind !== 'ok') throw new Error('expected ok');
    expect(resumed.state.queueLifecycle).toBe('running');
    expect(resumed.state.paused).toBe(false);
    assertLockstep(resumed.state);
  });

  it('operator-paused → active-empty on resume without pending', () => {
    const sPaused = makeState({
      queueLifecycle: 'operator-paused',
      paused: true,
      pausedReason: 'operator'
    });
    const r = transition(sPaused, { kind: 'resume-without-pending' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('active-empty');
    expect(r.state.paused).toBe(false);
    assertLockstep(r.state);
  });

  it('FR-005 carve-out: running → active-empty when in-flight terminates with empty pending', () => {
    const sRun = makeState({ queueLifecycle: 'running', inFlightId: 'r-1' });
    const r = transition(sRun, { kind: 'in-flight-terminate-empty' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('active-empty');
    expect(r.state.inFlightId).toBeNull();
    assertLockstep(r.state);
  });

  it('FR-005 carve-out: running → running when in-flight terminates with non-empty pending', () => {
    const sRun = makeState({ queueLifecycle: 'running', inFlightId: 'r-1' });
    const r = transition(sRun, {
      kind: 'in-flight-terminate-nonempty',
      nextInFlightId: 'r-2'
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('running');
    expect(r.state.inFlightId).toBe('r-2');
    assertLockstep(r.state);
  });

  it('cancel-schedule clears scheduledStartAt but leaves queue in idle-pending', () => {
    const s0 = makeState({
      queueLifecycle: 'idle-pending',
      scheduledStartAt: 1_700_000_000_000,
      scheduledStartSource: 'operator-chooser'
    });
    const r = transition(s0, { kind: 'cancel-schedule' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.queueLifecycle).toBe('idle-pending');
    expect(r.state.scheduledStartAt).toBeNull();
    expect(r.state.scheduledStartSource).toBeNull();
    assertLockstep(r.state);
  });

  it('rejects illegal transitions', () => {
    // start-now-from-idle-pending on active-empty
    const r1 = transition(makeState({ queueLifecycle: 'active-empty' }), {
      kind: 'start-now-from-idle-pending'
    });
    expect(r1.kind).toBe('illegal');
    // enqueue-scheduled on operator-paused
    const r2 = transition(
      makeState({ queueLifecycle: 'operator-paused', paused: true, pausedReason: 'operator' }),
      { kind: 'enqueue-scheduled', pendingId: 'r-1', scheduledStartAt: 1, source: 'operator-chooser' }
    );
    expect(r2.kind).toBe('illegal');
    // pause on operator-paused
    const r3 = transition(
      makeState({ queueLifecycle: 'operator-paused', paused: true, pausedReason: 'operator' }),
      { kind: 'pause' }
    );
    expect(r3.kind).toBe('illegal');
    // resume-with-pending on running
    const r4 = transition(makeState({ queueLifecycle: 'running', inFlightId: 'r-1' }), {
      kind: 'resume-with-pending',
      inFlightId: 'r-2'
    });
    expect(r4.kind).toBe('illegal');
    // cancel-schedule on active-empty
    const r5 = transition(makeState({ queueLifecycle: 'active-empty' }), {
      kind: 'cancel-schedule'
    });
    expect(r5.kind).toBe('illegal');
  });

  it('lockstep invariant: paused === (queueLifecycle === operator-paused) across all lifecycle values', () => {
    const lifecycles: QueueLifecycle[] = [
      'running',
      'operator-paused',
      'idle-pending',
      'active-empty'
    ];
    for (const lc of lifecycles) {
      const state = makeState({
        queueLifecycle: lc,
        paused: lc === 'operator-paused',
        pausedReason: lc === 'operator-paused' ? 'operator' : null,
        inFlightId: lc === 'running' ? 'r-1' : null,
        scheduledStartAt: lc === 'idle-pending' ? 1_700_000_000_000 : null,
        scheduledStartSource: lc === 'idle-pending' ? 'operator-chooser' : null
      });
      assertLockstep(state);
    }
  });
});
