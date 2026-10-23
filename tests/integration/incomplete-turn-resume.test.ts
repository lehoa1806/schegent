// FR-R3-198 (T1877) — an unfinished turn is resumed at once and, when the resumes do not finish
// it, halts the Run. SC-002 and SC-003; Story 2 scenarios 3, 4 and 8.
//
// Two limbs, as `bug-002-hung-success-queue-advance.test.ts` pins two halves of its path:
//
// 1. A real `PhaseRunner` over a fake `ClaudeCliRunner` that returns finalize attempt 1's shape:
//    terminated as `completedAwaitingExit`, with background work open at its last `result`, exit
//    143, and no contract block. It shows the shape is classified, recorded and resumed.
// 2. A real `RunDriver` over a runner double, its deps built the way
//    `tests/integration/checkpoints/driver-harness.ts` builds them in `depsFor`. It shows what the
//    drive does with the dispatch's last output, and what the mutation ledger is told.

import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../src/lib/logger';
import { PhaseRunner, type PhaseRunInputs, type PhaseRunOutput } from '../../src/controller/phase-runner';
import {
  CONTINUATION_NOTES,
  dispatchResumingIncompleteTurns
} from '../../src/controller/incomplete-turn-resume';
import { RunDriver, type RunDriverDeps } from '../../src/services/run-driver';
import { HistoryRecorder } from '../../src/services/history-recorder';
import type { PhaseMutationReport } from '../../src/services/run-mutation-ledger';
import { HistoryStore } from '../../src/state/history-store';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { AuditEntry, AuditEntryFields } from '../../src/audit/audit-entry';
import type { InvocationRequest, RawInvocationOutput } from '../../src/runner/invocation-result';
import type { PhaseDef } from '../../src/config/pipeline-config';
import type { WorkflowRun } from '../../src/state/workflow-run';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const SIGTERM_EXIT_CODE = 143;
const HALT_MESSAGE = 'the phase ended its turn unfinished, and immediate resumes did not finish it';

// Attempt 1 ended its turn while its checks ran in the background, and printed no contract block.
const UNFINISHED_STDOUT = 'The checks are running in the background. I will report when they finish.';

// The token trails the audit block, as the constitution requires of a terminal phase.
const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: finalize',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: []',
  'ruleset_switches: []',
  'notes: the checks ran in the foreground and passed',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: DONE]'
].join('\n');

function streamBuffer(text: string): ZippedStreamBuffer {
  const buffer = new ZippedStreamBuffer();
  buffer.append(text);
  buffer.finalize();
  return buffer;
}

function attemptOne(overrides: Partial<RawInvocationOutput> = {}): RawInvocationOutput {
  return {
    exitCode: SIGTERM_EXIT_CODE,
    killed: false,
    timedOut: false,
    durationMs: 60_000,
    completedAwaitingExit: true,
    backgroundWorkOpenAtResult: true,
    stdoutBuffer: streamBuffer(UNFINISHED_STDOUT),
    stderrBuffer: streamBuffer(''),
    ...overrides
  };
}

function finishedInTheForeground(): RawInvocationOutput {
  return {
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 30_000,
    completedAwaitingExit: false,
    backgroundWorkOpenAtResult: false,
    stdoutBuffer: streamBuffer(CLEAN_STDOUT),
    stderrBuffer: streamBuffer('')
  };
}

/** A fake CLI that answers each invocation from the script, in order, and keeps the requests. */
function scriptedCli(...script: RawInvocationOutput[]): { cli: ClaudeCliRunner; requests: InvocationRequest[] } {
  const requests: InvocationRequest[] = [];
  const cli = {
    invoke: vi.fn(async (request: InvocationRequest): Promise<RawInvocationOutput> => {
      const raw = script.at(requests.length);
      requests.push(request);
      if (raw === undefined) throw new Error('the script has no further invocation');
      return raw;
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { cli, requests };
}

type AppendedEntry = Omit<AuditEntry, 'id' | 'timestamp'>;

function capturingAuditWriter(): { writer: AuditLogWriter; entries: AppendedEntry[] } {
  const entries: AppendedEntry[] = [];
  const writer = {
    append: vi.fn(async (entry: AppendedEntry): Promise<AuditEntry> => {
      entries.push(entry);
      return { id: `audit-${entries.length}`, timestamp: '2026-10-23T00:00:00Z', ...entry };
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, entries };
}

const PHASE_INPUTS: PhaseRunInputs = {
  phase: 'finalize',
  iteration: 1,
  iterationCap: 5,
  featureDescription: 'finish the feature',
  featureDir: 'specs/228-incomplete-turn',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-1'
};

function phaseRunnerOver(cli: ClaudeCliRunner, writer: AuditLogWriter): PhaseRunner {
  return new PhaseRunner(cli, new PromptBuilder(), writer, new SanitizedLogger());
}

describe('FR-R3-198 (T1877) limb 1 — the phase runner over attempt 1 shape', () => {
  it('J1: classifies attempt 1 incomplete_turn, and its phase-end records the outcome and the warning', async () => {
    const { writer, entries } = capturingAuditWriter();
    const { cli } = scriptedCli(attemptOne());
    const output = await phaseRunnerOver(cli, writer).run(PHASE_INPUTS);

    expect(output.outcome).toBe('incomplete_turn');
    const phaseEnd = entries.find((entry) => entry.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({ outcome: 'incomplete_turn' });
    expect(phaseEnd?.payload.warnings).toContain('incomplete-turn:background-work-open');
  });

  it('J2 (FR-006): an idle timeout or the deadline keeps its own classification', async () => {
    for (const [overrides, reason] of [
      [{ timedOut: true }, 'timeout'],
      [{ deadlineExceeded: true }, 'deadline']
    ] as const) {
      const { writer, entries } = capturingAuditWriter();
      const { cli } = scriptedCli(attemptOne(overrides));
      const output = await phaseRunnerOver(cli, writer).run(PHASE_INPUTS);

      expect(output.terminationReason).toBe(reason);
      expect(output.outcome).not.toBe('incomplete_turn');
      const phaseEnd = entries.find((entry) => entry.eventType === 'phase-end');
      expect(phaseEnd?.payload).toMatchObject({ outcome: reason, terminationReason: reason });
    }
  });

  it('J5 (FR-008): the resume is its own attempt, recorded after the unfinished one', async () => {
    const { writer, entries } = capturingAuditWriter();
    const { cli, requests } = scriptedCli(attemptOne(), finishedInTheForeground());
    const output = await dispatchResumingIncompleteTurns(phaseRunnerOver(cli, writer), PHASE_INPUTS, () => {});

    expect(output.outcome).toBe('clean');
    const attempts = entries
      .filter((entry) => entry.eventType === 'phase-start' || entry.eventType === 'phase-end')
      .map((entry) =>
        entry.eventType === 'phase-start'
          ? { eventType: entry.eventType, isContinue: entry.payload.isContinue }
          : { eventType: entry.eventType, outcome: entry.payload.outcome }
      );
    expect(attempts).toEqual([
      { eventType: 'phase-start', isContinue: false },
      { eventType: 'phase-end', outcome: 'incomplete_turn' },
      { eventType: 'phase-start', isContinue: true },
      { eventType: 'phase-end', outcome: 'clean' }
    ]);

    // The note reaches the resume's prompt, and only the resume's.
    expect(requests).toHaveLength(2);
    expect(requests.at(0)?.prompt).not.toContain('CONTINUATION NOTE:');
    expect(requests.at(1)?.isContinue).toBe(true);
    expect(requests.at(1)?.prompt).toContain(
      `CONTINUATION NOTE:\n${CONTINUATION_NOTES['background-work-open']}\n`
    );
  });
});

const FINALIZE: PhaseDef = { id: 'finalize', name: 'Finalize', version: 1, instruction: 'Finish the feature.' };
const REVIEW: PhaseDef = { id: 'review', name: 'Review', version: 1, instruction: 'Review the feature.' };
const RUN_ID = 'run-198-integration';

function declaring(...files: string[]): AuditEntryFields {
  return {
    phase: FINALIZE.id,
    filesCreated: files,
    filesModified: [],
    filesDeleted: [],
    commandsExecuted: [],
    networkCalls: [],
    rulesetSwitches: [],
    notes: '',
    metrics: {},
    warnings: []
  };
}

function unfinished(auditEntry: AuditEntryFields | null = declaring()): PhaseRunOutput {
  return {
    result: {
      kind: 'incomplete_turn',
      cause: 'background-work-open',
      auditEntry,
      warnings: ['incomplete-turn:background-work-open']
    },
    outcome: 'incomplete_turn',
    terminationReason: 'incomplete_turn',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: SIGTERM_EXIT_CODE,
    auditEntryId: null,
    warnings: ['incomplete-turn:background-work-open']
  };
}

function finished(auditEntry: AuditEntryFields = declaring()): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: []
  };
}

function makeRun(phases: readonly PhaseDef[]): WorkflowRun {
  const startedAt = Date.now();
  return {
    id: RUN_ID,
    taskId: RUN_ID,
    featureId: RUN_ID,
    featureDir: 'specs/228-incomplete-turn',
    startedAt,
    updatedAt: startedAt,
    lastTransitionAt: startedAt,
    status: 'running',
    currentPhase: FINALIZE.id,
    currentIteration: 0,
    pipeline: { id: 'incomplete-turn-flow', name: 'Incomplete Turn Flow', phases },
    phasesCompleted: [],
    lastError: null,
    pendingRetry: false,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

/**
 * Drive one Run whose runner double answers from the script, and keep every persisted state.
 * The deps follow `depsFor` in `driver-harness.ts`, with no checkpoint service and, unless a case
 * gives one, no mutation ledger.
 */
async function drive(
  phases: readonly PhaseDef[],
  script: readonly PhaseRunOutput[],
  mutationLedger?: RunDriverDeps['mutationLedger']
) {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const history = new HistoryStore(store);
  const logger = new SanitizedLogger([]);
  const persisted: WorkflowRun[] = [];
  const run = vi.fn<(inputs: PhaseRunInputs) => Promise<PhaseRunOutput>>();
  for (const output of script) run.mockResolvedValueOnce(output);
  const retryCoordinator = {
    registerAttempt: vi.fn(),
    clear: vi.fn(),
    isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
    handleDelayedRetry: vi.fn(),
    handleRateLimitPause: vi.fn(),
    maybeEmitRetryRecovered: vi.fn(async (current: WorkflowRun) => current)
  };
  const deps = {
    store,
    runner: {
      run,
      abort: vi.fn(),
      appendCapExhaustedPhaseEnd: vi.fn(async () => {}),
      evictStagnationTracker: vi.fn()
    },
    logger,
    options: { iterationCap: 5, cwd: '/test/cwd', cliPath: '/test/bin', skipProbing: true },
    monitor: null,
    retryCoordinator,
    queue: {
      finish: vi.fn(async () => ({ ok: true })),
      pause: vi.fn(async () => ({ ok: true })),
      findById: vi.fn(() => null)
    },
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusBar: { update: vi.fn(), dispose: vi.fn() },
    historyRecorder: new HistoryRecorder({
      historyStore: history,
      logger,
      queueIdForTask: () => DEFAULT_QUEUE_ID,
      originForTask: () => ({ kind: 'standalone' }),
      descriptions: { write: async () => null, remove: async () => undefined }
    }),
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(),
    emitOptionalPhaseFailureContinued: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit: vi.fn(),
    appendBreakpointAudit: vi.fn(),
    isContinueGate: { consume: vi.fn().mockReturnValue(false) },
    lock: {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    },
    persistTransition: async (_previous: WorkflowRun, next: WorkflowRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      persisted.push(next);
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    onRunTerminal: vi.fn(),
    ...(mutationLedger === undefined ? {} : { mutationLedger })
  } as unknown as RunDriverDeps;

  const initial = makeRun(phases);
  await store.setRun(DEFAULT_QUEUE_ID, initial, unfencedCommit('test-fixture'));
  try {
    await new RunDriver(deps).drive(store.getRun(DEFAULT_QUEUE_ID) ?? initial, 'finish the feature');
  } finally {
    history.dispose();
  }
  return { run, persisted, retryCoordinator, last: persisted.at(-1) };
}

function recordingLedger() {
  const reports: Array<PhaseMutationReport | null> = [];
  const ledger = {
    observeBeforePhase: vi.fn(async () => {}),
    observeAfterPhase: vi.fn(async (_run: unknown, report: PhaseMutationReport | null) => {
      reports.push(report);
    })
  };
  return { ledger, reports };
}

describe('FR-R3-198 (T1877) limb 2 — the drive over a dispatch that resumes', () => {
  it('J3 (SC-003): three unfinished turns halt the Run failed on the phase, with no backoff', async () => {
    const { run, persisted, retryCoordinator, last } = await drive(
      [FINALIZE, REVIEW],
      [unfinished(), unfinished(), unfinished()]
    );

    expect(run).toHaveBeenCalledTimes(3);
    const calls = run.mock.calls.map(([inputs]) => inputs);
    expect(calls.map((inputs) => inputs.phase)).toEqual([FINALIZE.id, FINALIZE.id, FINALIZE.id]);
    expect(calls.at(0)?.isContinue).not.toBe(true);
    expect(calls.slice(1).map((inputs) => inputs.isContinue)).toEqual([true, true]);

    expect(persisted.map((each) => each.status)).not.toContain('completed');
    expect(persisted.map((each) => each.status)).not.toContain('paused');
    expect(last?.status).toBe('failed');
    expect(last?.lastError?.message).toBe(HALT_MESSAGE);
    expect(last?.currentPhase).toBe(FINALIZE.id);
    expect(last?.pendingRetryCause).toBeNull();
    expect(last?.delayedRetryCount).toBe(0);
    expect(last?.pendingRetryAt).toBeNull();
    expect(retryCoordinator.handleDelayedRetry).not.toHaveBeenCalled();
    expect(retryCoordinator.handleRateLimitPause).not.toHaveBeenCalled();
  });

  it('J4: an unfinished turn that the resume finishes advances the Run past the phase', async () => {
    const { run, persisted, last } = await drive([FINALIZE, REVIEW], [unfinished(), finished(), finished()]);

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([inputs]) => inputs.phase)).toEqual([FINALIZE.id, FINALIZE.id, REVIEW.id]);
    expect(persisted.map((each) => each.status)).not.toContain('failed');
    expect(last?.status).toBe('completed');
    expect(last?.phasesCompleted.map((each) => each.phase)).toEqual([FINALIZE.id, REVIEW.id]);
  });

  it('J6 (L6): the ledger is told every invocation of the dispatch, or null when one has no record', async () => {
    const declared = recordingLedger();
    await drive([FINALIZE], [unfinished(declaring('a.ts')), finished(declaring('b.ts'))], declared.ledger);
    expect(declared.reports).toEqual([{ declaredPaths: ['a.ts', 'b.ts'] }]);

    const unrecorded = recordingLedger();
    await drive([FINALIZE], [unfinished(null), finished(declaring('b.ts'))], unrecorded.ledger);
    expect(unrecorded.reports).toEqual([null]);
  });
});
