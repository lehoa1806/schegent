// Feature 097 (T001, T002, FR-004, FR-005, US1 Acceptance Scenario 6) — the
// Queue Detail row's timing derivation.
//
// `deriveTaskTiming` reads only the row's own Task, never a sibling's
// `inFlightRun` — that non-borrowing rule is what FR-005 requires and what most
// of these cases exist to pin down. It takes `nowMs` as a parameter rather than
// reading the clock itself, so the retry-reinsertion case (Scenario 6: a retried
// Task keeps its original "waiting since" reading) is exact and deterministic
// here rather than a pattern match against live wall-clock text.
//
// FR-R3-158 (T033) — this file's `deriveTaskPhaseProgress` describe block is
// gone, together with the function it covered (T022, research.md D5). The row's
// settled-phase figure is now computed on the host and rendered verbatim, so
// there is no webview derivation left to test. None of its five cases was
// dropped: each is re-expressed against the new source, listed in T032 and in
// the deleting commit's body. `PipelineDefinition` is no longer imported because
// no derivation here resolves a pipeline any more — which is the point of D5.

import { describe, expect, it } from 'vitest';

import { deriveTaskTiming } from '../task-row-view';
import type { QueueItem } from '../snapshot-types';

function task(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'a',
    label: 'task a',
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    phaseProgress: null,
    ...overrides
  };
}

describe('deriveTaskTiming', () => {
  it('reports elapsed time from startedAt to now while the Task is still running', () => {
    const running = task({ startedAt: '2026-08-12T00:00:00.000Z', completedAt: null });
    const nowMs = Date.parse('2026-08-12T01:00:00.000Z');

    expect(deriveTaskTiming(running, nowMs)).toEqual({ kind: 'elapsed', value: 60 * 60 * 1000 });
  });

  it('freezes elapsed time at completedAt rather than growing past it', () => {
    const finished = task({
      startedAt: '2026-08-12T00:00:00.000Z',
      completedAt: '2026-08-12T00:30:00.000Z'
    });
    const wellAfterCompletion = Date.parse('2026-08-13T00:00:00.000Z');

    expect(deriveTaskTiming(finished, wellAfterCompletion)).toEqual({
      kind: 'elapsed',
      value: 30 * 60 * 1000
    });
  });

  it('reports waiting time from enqueuedAt when the Task has not started', () => {
    const waiting = task({ enqueuedAt: '2026-08-12T00:00:00.000Z', startedAt: null });
    const nowMs = Date.parse('2026-08-12T00:15:00.000Z');

    expect(deriveTaskTiming(waiting, nowMs)).toEqual({ kind: 'waiting', value: 15 * 60 * 1000 });
  });

  it('keeps a retried, reinserted Task\'s original "waiting since" reading (US1 Scenario 6)', () => {
    // The Task was first added three hours ago, retried twice, and reinserted
    // immediately behind the Task now running — its position and retryCount
    // changed, but nothing re-enqueues it, so `enqueuedAt` is untouched and
    // "waiting since" must still read from the original moment.
    const retriedAndReinserted = task({
      enqueuedAt: '2026-08-12T00:00:00.000Z',
      startedAt: null,
      retryCount: 2,
      position: 1
    });
    const nowMs = Date.parse('2026-08-12T03:00:00.000Z');

    expect(deriveTaskTiming(retriedAndReinserted, nowMs)).toEqual({
      kind: 'waiting',
      value: 3 * 60 * 60 * 1000
    });
  });
});
