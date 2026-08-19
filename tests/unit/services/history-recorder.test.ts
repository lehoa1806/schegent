// Feature 013 — Wave 7 (US7 / T102): unit tests for HistoryRecorder.
//
// The recorder is a thin wrapper around buildHistoryEntry + historyStore.append
// with try/catch around the append. It encapsulates the history-write side
// effects so the controller's driveRun() can call a single async method at
// each terminal transition instead of holding the plumbing inline.

import { describe, it, expect, vi } from 'vitest';
import {
  HistoryRecorder,
  type HistoryRecorderDeps
} from '../../../src/services/history-recorder';
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

/**
 * FR-R3-010 (T405) — the two dependencies the recorder gained.
 *
 * `queueIdForTask` is the strict resolver: it answers `null` for a Task no
 * queue holds, and the recorder routes those to the unattributed partition
 * rather than guessing `'default'`. `descriptions` is the evidence-side store
 * the full description moved into; it is stubbed here because these cases are
 * about what reaches the history store, and the store's own behaviour has its
 * own file.
 */
function makeDeps(overrides: Partial<HistoryRecorderDeps> = {}): HistoryRecorderDeps {
  return {
    historyStore: { append: vi.fn().mockResolvedValue([]) } as never,
    logger: new SanitizedLogger(),
    queueIdForTask: () => 'queue-a',
    descriptions: {
      write: vi.fn().mockResolvedValue('.schegent/history/run-1.txt'),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    ...overrides
  };
}

describe('HistoryRecorder (T098 / T102)', () => {
  it('records a terminal entry to the history store', async () => {
    const append = vi.fn().mockResolvedValue([]);
    const recorder = new HistoryRecorder(makeDeps({ historyStore: { append } as never }));
    await recorder.record(makeRun(), 'investigate auth flow', 'completed');
    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0][1];
    expect(entry.runId).toBe('run-1');
    expect(entry.featureId).toBe('feat-1');
    expect(entry.terminalStatus).toBe('completed');
    // FR-R3-010: the full text went to the description store, not onto the
    // entry. What the entry keeps is the preview, the length, and the reference
    // the store handed back.
    expect(entry.originalDescription).toBeUndefined();
    expect(entry.descriptionPreview).toBe('investigate auth flow');
    expect(entry.descriptionLength).toBe('investigate auth flow'.length);
    expect(entry.descriptionRef).toBe('.schegent/history/run-1.txt');
    // and the partition it was filed under is the first argument
    expect(append.mock.calls[0][0]).toBe('queue-a');
  });

  it('records completion when a prior optional phase result is failed (076)', async () => {
    const append = vi.fn().mockResolvedValue([]);
    const recorder = new HistoryRecorder(makeDeps({ historyStore: { append } as never }));
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

    expect(append.mock.calls[0][1]).toMatchObject({
      terminalStatus: 'completed',
      lastErrorSummary: null
    });
  });

  it('is a no-op when no history store is wired', async () => {
    const recorder = new HistoryRecorder(makeDeps({ historyStore: null }));
    await expect(recorder.record(makeRun(), 'desc', 'completed')).resolves.toBeUndefined();
  });

  it('swallows store.append errors and logs a sanitized warning', async () => {
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const append = vi.fn().mockRejectedValue(new Error('disk-full'));
    const recorder = new HistoryRecorder(
      makeDeps({ historyStore: { append } as never, logger })
    );
    await expect(recorder.record(makeRun(), 'desc', 'failed')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('history append failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disk-full'));
  });
});

// Feature 091 (T006, US1) — FR-010. The recorder is the only writer of history
// entries, so it is the only place `run.runOutputs` can reach one. Nothing else
// in the terminal path carries it forward.

describe('the recorder carries what the Run recorded (Feature 091, FR-010)', () => {
  const RECORDED = [
    { name: 'report', status: 'resolved' as const, reference: 'out/report.md' },
    { name: 'summary', status: 'unresolved' as const }
  ];

  function appendedFor(run: WorkflowRun) {
    const append = vi.fn().mockResolvedValue([]);
    const recorder = new HistoryRecorder(makeDeps({ historyStore: { append } as never }));
    return { append, recorded: recorder.record(run, 'declared outputs', 'completed') };
  }

  it('puts the Run records on the history entry unchanged', async () => {
    const { append, recorded } = appendedFor(makeRun({ runOutputs: RECORDED }));
    await recorded;
    expect(append.mock.calls[0][1].runOutputs).toEqual(RECORDED);
  });

  it('preserves declaration order', async () => {
    const { append, recorded } = appendedFor(makeRun({ runOutputs: RECORDED }));
    await recorded;
    expect(append.mock.calls[0][1].runOutputs.map((r: { name: string }) => r.name)).toEqual([
      'report',
      'summary'
    ]);
  });

  it('omits the field when the Run recorded nothing', async () => {
    const { append, recorded } = appendedFor(makeRun());
    await recorded;
    const entry = append.mock.calls[0][1];
    expect(entry.runOutputs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'runOutputs')).toBe(false);
  });

  it('does not put a recorded location anywhere else on the entry', async () => {
    // FR-009a keeps a location out of the audit log; the same location must not
    // arrive in history by an unintended route either — only under `runOutputs`,
    // where the reader knows to look for it.
    const { append, recorded } = appendedFor(makeRun({ runOutputs: RECORDED }));
    await recorded;
    const { runOutputs, ...rest } = append.mock.calls[0][1];
    expect(runOutputs).toBeDefined();
    expect(JSON.stringify(rest)).not.toContain('out/report.md');
  });
});
