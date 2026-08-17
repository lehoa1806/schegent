// Feature 097 (T001, T002, FR-004, FR-005, US1 Acceptance Scenario 6) — the
// Queue Detail row's phase-progress and timing derivation.
//
// Both functions read only the row's own Task and its own resolved Pipeline,
// never a sibling's `inFlightRun` — that non-borrowing rule is what FR-005
// requires and what most of these cases exist to pin down. `deriveTaskTiming`
// in particular takes `nowMs` as a parameter rather than reading the clock
// itself, so the retry-reinsertion case (Scenario 6: a retried Task keeps its
// original "waiting since" reading) is exact and deterministic here rather
// than a pattern match against live wall-clock text.

import { describe, expect, it } from 'vitest';

import { deriveTaskPhaseProgress, deriveTaskTiming } from '../task-row-view';
import type { PipelineDefinition, QueueItem } from '../snapshot-types';

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
    ...overrides
  };
}

const PIPELINE: PipelineDefinition = {
  id: 'standard',
  name: 'Standard',
  phases: ['speckit-specify', 'speckit-plan', 'speckit-tasks']
};

describe('deriveTaskPhaseProgress', () => {
  it('reports zero of zero when the Task\'s Pipeline cannot be resolved', () => {
    expect(deriveTaskPhaseProgress(task(), undefined)).toEqual({ completed: 0, total: 0 });
  });

  it('reports every phase completed once the Task is completed, regardless of currentPhase', () => {
    const completed = task({ status: 'completed', currentPhase: 'speckit-specify' });

    expect(deriveTaskPhaseProgress(completed, PIPELINE)).toEqual({ completed: 3, total: 3 });
  });

  it('counts the phases strictly before the current phase for an in-flight Task', () => {
    const inFlight = task({ status: 'in-flight', currentPhase: 'speckit-tasks' });

    expect(deriveTaskPhaseProgress(inFlight, PIPELINE)).toEqual({ completed: 2, total: 3 });
  });

  it('reports zero completed for a pending Task with no current phase yet', () => {
    const pending = task({ status: 'pending', currentPhase: null });

    expect(deriveTaskPhaseProgress(pending, PIPELINE)).toEqual({ completed: 0, total: 3 });
  });

  it('reports zero completed when currentPhase does not belong to the resolved Pipeline', () => {
    const stale = task({ status: 'in-flight', currentPhase: 'not-in-this-pipeline' });

    expect(deriveTaskPhaseProgress(stale, PIPELINE)).toEqual({ completed: 0, total: 3 });
  });
});

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
