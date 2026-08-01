// Feature 013 — Wave 7 (US7 / T102): unit tests for HistoryRecorder.
//
// The recorder is a thin wrapper around buildHistoryEntry + historyStore.append
// with try/catch around the append. It encapsulates the history-write side
// effects so the controller's driveRun() can call a single async method at
// each terminal transition instead of holding the plumbing inline.

import { describe, it, expect, vi } from 'vitest';
import { HistoryRecorder } from '../../../src/services/history-recorder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: 'specs/001-feat-1',
    status: 'completed',
    currentPhase: 'done',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_001_000,
    phasesCompleted: [],
    lastError: null,
    pipeline: undefined,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    ...overrides
  } as WorkflowRun;
}

describe('HistoryRecorder (T098 / T102)', () => {
  it('records a terminal entry to the history store', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const recorder = new HistoryRecorder({
      historyStore: { append } as never,
      logger: new SanitizedLogger()
    });
    await recorder.record(makeRun(), 'investigate auth flow', 'completed');
    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0][0];
    expect(entry.runId).toBe('run-1');
    expect(entry.featureId).toBe('feat-1');
    expect(entry.terminalStatus).toBe('completed');
    expect(entry.originalDescription).toBe('investigate auth flow');
  });

  it('records completion when a prior optional phase result is failed (076)', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const recorder = new HistoryRecorder({
      historyStore: { append } as never,
      logger: new SanitizedLogger()
    });
    const run = makeRun({
      phasesCompleted: [
        {
          phase: 'optional-audit',
          iteration: 1,
          startedAt: 1_700_000_000_100,
          endedAt: 1_700_000_000_200,
          result: 'failed',
          terminationReason: 'error',
          exitCode: 7,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: 'audit-optional'
        }
      ],
      lastError: null
    });

    await recorder.record(run, 'optional audit workflow', 'completed');

    expect(append.mock.calls[0][0]).toMatchObject({
      terminalStatus: 'completed',
      lastErrorSummary: null
    });
  });

  it('is a no-op when no history store is wired', async () => {
    const recorder = new HistoryRecorder({
      historyStore: null,
      logger: new SanitizedLogger()
    });
    await expect(recorder.record(makeRun(), 'desc', 'completed')).resolves.toBeUndefined();
  });

  it('swallows store.append errors and logs a sanitized warning', async () => {
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const append = vi.fn().mockRejectedValue(new Error('disk-full'));
    const recorder = new HistoryRecorder({
      historyStore: { append } as never,
      logger
    });
    await expect(recorder.record(makeRun(), 'desc', 'failed')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('history append failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disk-full'));
  });
});
