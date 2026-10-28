// FR-R3-175 (FR-033, FR-034, FR-034a, FR-036, SC-010) — a window that comes back
// up and resumes a persisted in-flight Run says what it did with the session.
//
// THE DEFECT. Activation finds a Run the previous window left mid-phase, resumes
// it, and dispatches the phase against a FRESH backend conversation — every prior
// turn and all compaction gone. The persisted session id is sitting right there
// and is owned by the runner kind about to dispatch; nothing asks for it, because
// `shouldContinueConversation()` reads two fields that are both structurally null
// on a crash-interrupted Run (see `specs/213-claims-nothing-verifies/decisions.md`
// §M5, which drove this end to end). The behaviour is deliberate and stays —
// `session-dispatch-policy.ts` carries the argument. What did not exist is any
// record of it: the one line activation emits names the operation and says
// nothing about session continuity, so an operator watching the phase continue
// has no way to learn the model no longer remembers anything it did.
//
// WHY THE ASSERTION IS A COUNT. SC-010 requires EXACTLY ONE such line. A
// `toContain` would pass just as happily on a driver that emitted one per phase,
// which is the failure mode a per-dispatch line actually has — so the count is
// the assertion and the dispatch below is arranged to take exactly one phase.
//
// WHY A REAL LOGGER OVER A CAPTURING SINK, rather than a spy on `info`. The
// claim in FR-033 is about what reaches the SINK, not about what the call site
// passed: a session id that the sanitizer would have to remove is still a line
// the call site should never have written. `SanitizedLogger` redacts secrets,
// not identifiers that look like `owned-claude-session`, so the id assertion
// below is not answered by the sanitizer on the call site's behalf. Pattern
// borrowed from `stage2-producers-trust.test.ts`.
//
// THE NON-VACUITY CONTROLS matter more than usual here, because three of the
// four assertions are negative and a broken fixture produces all three:
//   - the reloaded Run is checked to carry an OWNED session id, so "started
//     fresh" is the policy's answer and not an absent input;
//   - the activation walk's own line is counted, so a zero disposition count
//     cannot come from a sink nothing reached;
//   - the runner is asserted to have been dispatched at all.

import { describe, expect, it, vi } from 'vitest';

import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { resumePersistedRuns } from '../../../src/services/resume-decision';
import type {
  PhaseRunInputs,
  PhaseRunner,
  PhaseRunOutput
} from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  buildSpeckitCatalog,
  SPECKIT_RUN_PIPELINE
} from '../../fixtures/speckit-catalog-fixture';

/**
 * Deliberately NOT shaped like a credential. `SanitizedLogger` redacts secret
 * patterns, and an id it happened to redact would answer the FR-033 assertion
 * for the wrong reason.
 */
const PERSISTED_SESSION_ID = 'owned-claude-session';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeStatusBar(): SchegentStatusBar {
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}

function makeNotifier(): Notifier {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

/**
 * Advance, then stop: the first phase comes back clean so the drive dispatches a
 * SECOND time, and the second halts the run.
 *
 * Two dispatches is the whole point. SC-010 says exactly ONE line per resume, and
 * a single-dispatch scenario cannot tell that apart from a line emitted on every
 * dispatch — both produce a count of 1. The second phase is what makes the count
 * bite, and the transient outcome is what keeps the drive from walking the rest
 * of the Spec Kit pipeline for no added coverage.
 *
 * The clean output carries a `cliSessionId` because a real one does: that is the
 * id the driver latches to reuse on the next phase, which is exactly why the
 * second dispatch's disposition differs from the first and why restating it would
 * be misleading rather than merely repetitive.
 */
function makeCleanOutput(): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: 'audit-clean',
    warnings: [],
    cliSessionId: 'fresh-claude-session'
  };
}

function makeTransientOutput(): PhaseRunOutput {
  return {
    result: { kind: 'transient_error', exitCode: 1, auditEntry: null },
    outcome: 'transient_error',
    terminationReason: 'error',
    stdoutSummary: '',
    stderrSummary: 'cli aborted unexpectedly',
    exitCode: 1,
    auditEntryId: 'audit-tx',
    warnings: []
  };
}

/**
 * The state a window that died mid-phase leaves behind: a Run still marked
 * in-flight, its Task row still in-flight beside it, and a session id owned by
 * the kind that will resolve for the resumed phase.
 *
 * `pendingRetryAt`/`pendingRetryCause` and `manualPauseAt`/`manualPauseCause` are
 * all null, which is not fixture convenience — it is the load-bearing fact §M5
 * records. A Run that was EXECUTING was not waiting on a backoff and was not
 * paused, so the two fields `shouldContinueConversation()` reads are structurally
 * null, and the migrator's `retryPairInvariant` would null the cause anyway if
 * only one half were seeded.
 */
function persistInterruptedRun(memento: FakeMemento): void {
  const run: WorkflowRun = {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: '',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: Date.now() - 600_000,
    lastTransitionAt: Date.now() - 300_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: SPECKIT_RUN_PIPELINE,
    defaultRunnerKind: 'claude',
    lastCliSessionId: PERSISTED_SESSION_ID,
    lastCliSessionRunnerKind: 'claude'
  };
  void memento.update('schegent.run', run);
  void memento.update('schegent.queue', {
    requests: [
      {
        id: 'feat-1',
        description: 'the task the previous window was executing',
        addedAt: 1,
        updatedAt: 1,
        status: 'in-flight',
        runId: 'run-1',
        retryCount: 0,
        attempts: [],
        phaseHistory: []
      }
    ],
    inFlightId: 'feat-1',
    paused: false,
    pausedReason: null,
    updatedAt: 1,
    queueLifecycle: 'running',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  });
}

describe('FR-R3-175 — an activation resume states its session disposition', () => {
  it('emits exactly one line naming the disposition and its cause, and names no id', async () => {
    const memento = new FakeMemento();
    persistInterruptedRun(memento);

    // The restart. A second store over the same persisted Memento is the seam
    // every persisted field crosses, and what `restart-resume.test.ts` has always
    // called "simulates VS Code restart".
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const runSpy = vi
      .fn(async () => makeTransientOutput())
      .mockImplementationOnce(async () => makeCleanOutput());
    const phaseRunner = {
      run: runSpy,
      evictStagnationTracker: vi.fn()
    } as unknown as PhaseRunner;
    const auditAppend = vi.fn(async (entry: Record<string, unknown>) => ({
      id: 'mock-audit-id',
      timestamp: new Date().toISOString(),
      ...entry
    }));
    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      makeStatusBar(),
      makeNotifier(),
      logger,
      makeLock(),
      { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
      {
        catalog: buildSpeckitCatalog(),
        auditWriter: auditAppend as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter
      }
    );

    // The Run really did keep an owned session across the restart. Without this
    // the "started fresh" verdict below would be true of an empty input.
    const reloaded = store.getRun(DEFAULT_QUEUE_ID);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.lastCliSessionId).toBe(PERSISTED_SESSION_ID);
    expect(reloaded!.lastCliSessionRunnerKind).toBe('claude');

    // The production activation walk, with the filter its one call site applies
    // (`stage2-producers.ts`) and the liveness verdict forced rather than probed.
    const resumed: string[] = [];
    await resumePersistedRuns({
      runs: () => Object.entries(store.getRunMap()).filter(([, run]) => run.status === 'running'),
      liveness: async () => 'dead',
      appendAudit: async () => {},
      resume: (queueId) => {
        resumed.push(queueId);
        void controller.resumeExisting(queueId);
      },
      notify: () => {},
      log: (message) => logger.info(message)
    });

    expect(resumed).toEqual([DEFAULT_QUEUE_ID]);
    // Two dispatches, not one: without the second, "exactly one line" below is
    // true of a per-dispatch implementation too and the count asserts nothing.
    await vi.waitFor(() => expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // What the dispatch actually did with the session: nothing. The owned id is
    // not forwarded, and this is not a continuation.
    const dispatch = (runSpy.mock.calls[0] as unknown as readonly PhaseRunInputs[])[0]!;
    expect(dispatch.isContinue ?? false).toBe(false);
    expect(dispatch.sessionReuse ?? false).toBe(false);
    expect(dispatch.resumeSessionId).toBeUndefined();

    // The sink works — this line exists today. A zero below is therefore an
    // absent disposition line, not an absent logger.
    expect(lines.filter((line) => line.includes('activation: resuming run'))).toHaveLength(1);

    const disposition = lines.filter((line) => line.includes('session disposition:'));
    expect(disposition).toHaveLength(1);
    expect(disposition[0]).toContain('fresh backend session');
    expect(disposition[0]).toContain('continuation-not-requested');
    expect(disposition[0]).not.toContain(PERSISTED_SESSION_ID);
  });
});
