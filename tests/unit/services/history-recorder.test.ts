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
    // Feature 103 (T022) — shaped like `queueIdForTask` and answering the same
    // kind of question: `null` means "could not tell", which the recorder must
    // leave as an absence rather than a guess.
    originForTask: () => ({ kind: 'standalone' }),
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

  it('is a no-op when no history store is wired, reported as a typed skip (FR-R3-071)', async () => {
    const recorder = new HistoryRecorder(makeDeps({ historyStore: null }));
    await expect(recorder.record(makeRun(), 'desc', 'completed')).resolves.toEqual({
      outcome: 'skipped-no-store'
    });
  });

  // Feature 103 (T080, FR-047) — the code, never the caught message. This case
  // used to assert the message reached the log, which is the shape the
  // requirement now rules out: a filesystem error's message quotes the absolute
  // path it was addressing, and a writer catching one cannot tell an innocuous
  // message from one carrying the workspace root. The code is the actionable
  // half and carries nothing about where the workspace lives.
  it('swallows store.append errors and logs the error code, not its message', async () => {
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const append = vi.fn().mockRejectedValue(
      Object.assign(
        new Error("ENOSPC: no space left on device, write '/Users/someone/work/.schegent'"),
        { code: 'ENOSPC' }
      )
    );
    const recorder = new HistoryRecorder(
      makeDeps({ historyStore: { append } as never, logger })
    );
    // FR-R3-071 -- still swallowed (no throw), and the failure now surfaces as
    // a typed result so the terminal-transition coordinator can keep its
    // repair intent. The code, never the message, exactly as the log line.
    await expect(recorder.record(makeRun(), 'desc', 'failed')).resolves.toEqual({
      outcome: 'failed',
      code: 'ENOSPC'
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('history append failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('/Users/someone/work'));
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

// Feature 103 (T022, T023, US2) — FR-013, FR-014, FR-015.
//
// The recorder is the only writer of a history entry, so it is the only place
// provenance can be stamped. Two facts, two sources, two guards:
//
//   `catalogVersion` comes off the plan the run already froze (`run.pipeline`).
//   `origin` comes off a port, because the answer lives on a `ConnectedWorkflowRun`
//   that is deletable — so it is read once, at completion, and never again.
//
// R2 is the trap these cases exist to catch. A Workflow member's frozen body is
// a *Pipeline*, so its `catalogVersion.kind` reads `'pipeline'` while its
// `origin.kind` reads `'workflow-member'`. Both are true at once. Deriving
// either from the other silently mislabels every member run.

describe('the recorder stamps provenance (Feature 103, FR-013/FR-014/FR-015)', () => {
  const MEMBER_PLAN = {
    id: 'pipe-deploy',
    name: 'Deploy',
    phases: [],
    catalogVersion: { kind: 'pipeline' as const, id: 'pipe-deploy', versionId: 'ver-12' }
  };

  async function appendedEntry(
    run: WorkflowRun,
    deps: Partial<HistoryRecorderDeps> = {}
  ): Promise<Record<string, unknown>> {
    const append = vi.fn().mockResolvedValue([]);
    const recorder = new HistoryRecorder(
      makeDeps({ historyStore: { append } as never, ...deps })
    );
    await recorder.record(run, 'a run with a provenance', 'completed');
    expect(append).toHaveBeenCalledTimes(1);
    return append.mock.calls[0][1];
  }

  it('records a standalone run as standalone', async () => {
    const entry = await appendedEntry(makeRun(), {
      originForTask: () => ({ kind: 'standalone' })
    });
    expect(entry.origin).toEqual({ kind: 'standalone' });
  });

  it('records a Workflow member as a member, and its frozen body as a Pipeline', async () => {
    const entry = await appendedEntry(makeRun({ pipeline: MEMBER_PLAN }), {
      originForTask: () => ({ kind: 'workflow-member', workflowId: 'wf-release' })
    });

    expect(entry.origin).toEqual({ kind: 'workflow-member', workflowId: 'wf-release' });
    // Both, on the same entry, disagreeing about the word "workflow" — which is
    // correct, and is exactly what a derived implementation cannot produce.
    expect(entry.catalogVersion).toEqual(MEMBER_PLAN.catalogVersion);
    expect((entry.catalogVersion as { kind: string }).kind).toBe('pipeline');
  });

  it('asks the port about the run’s queue item, not about the run id', async () => {
    // The link the port resolves is `HistoryEntry.featureId === ChildRunRef.queueItemId`.
    // Handing it `run.id` would miss every member.
    const originForTask = vi.fn(() => ({ kind: 'standalone' as const }));
    await appendedEntry(makeRun({ id: 'run-9', featureId: 'feat-9' }), { originForTask });
    expect(originForTask).toHaveBeenCalledWith('feat-9');
  });

  it('copies the frozen version off the plan rather than re-resolving it', async () => {
    const entry = await appendedEntry(makeRun({ pipeline: MEMBER_PLAN }));
    expect(entry.catalogVersion).toEqual(MEMBER_PLAN.catalogVersion);
  });

  it('omits catalogVersion when the run froze no version', async () => {
    // A plan supplied ready-made rather than frozen from the catalog, and every
    // run that predates the catalog. Absent, not a placeholder.
    const entry = await appendedEntry(
      makeRun({ pipeline: { id: 'pipe-adhoc', name: 'Ad hoc', phases: [] } })
    );
    expect(entry.catalogVersion).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'catalogVersion')).toBe(false);
  });

  it('omits origin when the port cannot tell, and still records the run', async () => {
    const entry = await appendedEntry(makeRun({ pipeline: MEMBER_PLAN }), {
      originForTask: () => null
    });
    expect(entry.origin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'origin')).toBe(false);
    // FR-015 — the run is recorded regardless. Losing the whole entry because
    // one descriptive field could not be resolved loses the operator the run.
    expect(entry.runId).toBe('run-1');
    expect(entry.catalogVersion).toEqual(MEMBER_PLAN.catalogVersion);
  });

  it('omits origin when the port throws, and still records the run', async () => {
    const entry = await appendedEntry(makeRun({ pipeline: MEMBER_PLAN }), {
      originForTask: () => {
        throw new Error('connected run vanished mid-lookup');
      }
    });
    expect(entry.origin).toBeUndefined();
    expect(entry.runId).toBe('run-1');
    expect(entry.catalogVersion).toEqual(MEMBER_PLAN.catalogVersion);
  });

  it('omits catalogVersion when reading the plan throws, and still records the run', async () => {
    const run = makeRun();
    Object.defineProperty(run, 'pipeline', {
      get() {
        throw new Error('plan snapshot unreadable');
      }
    });

    const entry = await appendedEntry(run, {
      originForTask: () => ({ kind: 'workflow-member', workflowId: 'wf-release' })
    });
    expect(entry.catalogVersion).toBeUndefined();
    expect(entry.runId).toBe('run-1');
    // Independent guards: the readable half still lands.
    expect(entry.origin).toEqual({ kind: 'workflow-member', workflowId: 'wf-release' });
  });
});
