import { describe, expect, it, vi } from 'vitest';
import { TerminalTransitionCoordinator } from '../../../src/services/terminal-transition-coordinator';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';

function terminalRun(): WorkflowRun {
  return {
    id: 'run-1', featureId: 'task-1', featureDir: '', status: 'completed',
    currentPhase: 'done', currentIteration: 1, startedAt: 1, lastTransitionAt: 2,
    phasesCompleted: [], lastError: null, delayedRetryCount: 0,
    pendingRetryAt: null, pendingRetryCause: null, phaseOverrides: [],
    manualPauseAt: null, manualPauseCause: null, phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

describe('TerminalTransitionCoordinator', () => {
  it('persists intent before run and clears only after queue/history', async () => {
    const order: string[] = [];
    let intent: unknown = null;
    const store = {
      getTerminalTransitionIntent: () => intent as never,
      setTerminalTransitionIntent: vi.fn(async (next) => { order.push(next ? 'intent' : 'clear'); intent = next; }),
      setRun: vi.fn(async () => { order.push('run'); })
    };
    const queue = { finish: vi.fn(async () => { order.push('queue'); }) };
    const history = { record: vi.fn(async () => { order.push('history'); }) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );
    await coordinator.complete(terminalRun(), 'description');
    expect(order).toEqual(['intent', 'run', 'queue', 'history', 'clear']);
  });

  it('replays a persisted intent', async () => {
    const run = terminalRun();
    let intent: unknown = { schemaVersion: 1, run, createdAt: 1 };
    const store = {
      getTerminalTransitionIntent: () => intent as never,
      setTerminalTransitionIntent: vi.fn(async (next) => { intent = next; }),
      setRun: vi.fn(async () => undefined)
    };
    const queue = { finish: vi.fn(async () => undefined) };
    const history = { record: vi.fn(async () => undefined) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );
    await coordinator.replay();
    expect(queue.finish).toHaveBeenCalledWith('task-1', 'completed');
    expect(intent).toBeNull();
  });
});
