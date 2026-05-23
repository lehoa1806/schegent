import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import {
  BUILT_IN_BUGFIX_PIPELINE_ID,
  BUILT_IN_CATALOG,
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINE_ID,
  BUILT_IN_PIPELINES,
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';

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
  return {
    update: vi.fn(),
    dispose: vi.fn()
  } as unknown as SchegentStatusBar;
}

function makeNotifier(): Notifier {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
}

function makeLock(): WorkspaceLockManager & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
}

function makeOutput(overrides: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: 'audit-1',
    warnings: [],
    ...overrides
  };
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
  perPhaseRulesEnabled: false
};

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let runSpy: ReturnType<typeof vi.fn>;
let controller: SchegentWorkflowController;
let statusBar: SchegentStatusBar;
let notifier: Notifier;
let lock: WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  statusBar = makeStatusBar();
  notifier = makeNotifier();
  lock = makeLock();
  runSpy = vi.fn();
  phaseRunner = { run: runSpy } as unknown as PhaseRunner;
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    new SanitizedLogger(),
    lock,
    opts
  );
});

describe('SchegentWorkflowController.startNew', () => {
  it('drives all 7 phases to completion when all return clean', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('completed');
    expect(run.currentPhase).toBe('done');
    expect(runSpy).toHaveBeenCalledTimes(7);
    const phasesCalled = runSpy.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phasesCalled).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ]);
  });

  it('snapshots the speckit-new-feature pipeline onto run.pipeline when no pipelineId is supplied (T022, US1)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.pipeline).toBeTruthy();
    expect(run.pipeline?.id).toBe('speckit-new-feature');
    expect(run.pipeline?.name).toBe('Spec-kit New Feature');
    expect(run.pipeline?.phases.map((p) => p.id)).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ]);
  });

  it('snapshot preserves PhaseDef.retryCondition through Object.freeze (T009, 010)', async () => {
    const customPhase: PhaseDef = Object.freeze({
      id: 'custom-loop',
      name: 'Custom Loop',
      instruction: 'do work; emit metrics',
      loopable: true,
      retryCondition: 'open_questions > 0'
    });
    const customPipeline = Object.freeze({
      id: 'custom-pipe',
      name: 'Custom Pipeline',
      phases: Object.freeze(['custom-loop']) as readonly string[]
    });
    const catalog = buildCatalog(
      [customPhase],
      [customPipeline],
      [],
      'custom-pipe'
    );
    controller.setCatalog(catalog);
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null, { pipelineId: 'custom-pipe' });

    const run = store.getRun()!;
    expect(run.pipeline?.id).toBe('custom-pipe');
    const snapPhase = run.pipeline?.phases.find((p) => p.id === 'custom-loop');
    expect(snapPhase).toBeTruthy();
    expect(snapPhase?.retryCondition).toBe('open_questions > 0');
    expect(Object.isFrozen(run.pipeline)).toBe(true);
    expect(Object.isFrozen(run.pipeline?.phases)).toBe(true);
    expect(() => {
      (snapPhase as unknown as { retryCondition: string }).retryCondition = 'tampered';
    }).toThrow();
    expect(snapPhase?.retryCondition).toBe('open_questions > 0');
  });

  it('starts at clarify when featureDir is provided', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, 'specs/001-existing');

    const phasesCalled = runSpy.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phasesCalled[0]).toBe('speckit-clarify');
  });

  it('loops clarify when issues_remain and stops looping on clean', async () => {
    let calls = 0;
    runSpy.mockImplementation(async (req: { phase: string }) => {
      calls++;
      if (req.phase === 'speckit-clarify' && calls < 4) {
        return makeOutput({
          outcome: 'issues_remain',
          terminationReason: 'open_questions',
          result: { kind: 'open_questions', questions: ['Q1?'], auditEntry: { metrics: { open_questions: 1 } } as any }
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, 'specs/001-existing');

    const clarifyCalls = runSpy.mock.calls.filter((c) => (c[0] as { phase: string }).phase === 'speckit-clarify');
    expect(clarifyCalls.length).toBeGreaterThanOrEqual(2);
    expect(store.getRun()!.status).toBe('completed');
  });

  it('halts and pauses on rate_limited (Feature 011 — delayed retry path)', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          outcome: 'rate_limited',
          terminationReason: 'rate_limit',
          result: { kind: 'rate_limited', cause: 'rate-limit', auditEntry: null }
        });
      }
      return makeOutput();
    });

    // Legacy rate-limit handler should NOT fire when the delayed-retry
    // path handles `rate_limit` cause (FR-003).
    const handler = vi.fn(async () => {});
    controller.setRateLimitHandler(handler);

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('paused');
    expect(run.pendingRetryCause).toBe('rate_limit');
    expect(run.delayedRetryCount).toBe(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('halts and fails on failed outcome', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          outcome: 'failed',
          terminationReason: 'error',
          result: { kind: 'malformed', warnings: ['boom'], auditEntry: null },
          warnings: ['boom']
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('failed');
    expect(run.lastError).not.toBeNull();
    expect(run.lastError!.code).toBe('invocation-failed');
  });

  it('marks the run and queue item failed when the runner throws unexpectedly', async () => {
    runSpy.mockRejectedValueOnce(new Error('parser invariant exploded'));

    const feature = await queue.enqueue('feature description');
    await expect(controller.startNew(feature, null)).resolves.toBeUndefined();

    const run = store.getRun()!;
    expect(run.status).toBe('failed');
    expect(run.lastError).not.toBeNull();
    expect(run.lastError!.code).toBe('unexpected-controller-error');
    expect(run.lastError!.message).toContain('parser invariant exploded');

    const row = queue.findById(feature.id);
    expect(row?.status).toBe('failed');
    expect(typeof row?.lastError === 'object' && row.lastError !== null).toBe(true);
    if (row?.lastError && typeof row.lastError === 'object') {
      expect(row.lastError.code).toBe('unexpected-controller-error');
      expect(row.lastError.message).toContain('parser invariant exploded');
      expect(row.lastError.correlationId).toBe(run.id);
    }
    expect(lock.release).toHaveBeenCalled();
  });

  it('cancels mid-run when cancelActive is invoked', async () => {
    runSpy.mockImplementation(async () => {
      controller.cancelActive();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('canceled');
  });

  it('persists carried issues to next clarify iteration', async () => {
    let firstClarify = true;
    runSpy.mockImplementation(async (req: { phase: string; carriedIssues?: unknown }) => {
      if (req.phase === 'speckit-clarify' && firstClarify) {
        firstClarify = false;
        return makeOutput({
          outcome: 'issues_remain',
          terminationReason: 'open_questions',
          result: { kind: 'open_questions', questions: ['Need scope'], auditEntry: { metrics: { open_questions: 1 } } as any }
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, 'specs/001-existing');

    const secondClarifyCall = runSpy.mock.calls.find(
      (c, idx) => (c[0] as { phase: string }).phase === 'speckit-clarify' && idx > 0
    );
    expect(secondClarifyCall).toBeDefined();
    if (secondClarifyCall) {
      const carried = (secondClarifyCall[0] as { carriedIssues?: unknown }).carriedIssues;
      expect(carried).toEqual(['Need scope']);
    }
  });

  it('injects phase messages into only the immediately following phase prompt context', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          phaseMessage: {
            fromPhaseId: 'speckit-specify',
            entryCount: 1,
            byteSize: 16,
            entries: { next_step: 'clarify' },
            truncated: false,
            invalidReason: null
          }
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const specifyCall = runSpy.mock.calls.find(
      (call) => (call[0] as { phase: string }).phase === 'speckit-specify'
    );
    const clarifyCall = runSpy.mock.calls.find(
      (call) => (call[0] as { phase: string }).phase === 'speckit-clarify'
    );
    const planCall = runSpy.mock.calls.find(
      (call) => (call[0] as { phase: string }).phase === 'speckit-plan'
    );

    expect(specifyCall?.[0]).toMatchObject({
      previousPhaseMessage: null,
      phaseMessagePath: expect.stringContaining('/.schegent/sessions/')
    });
    expect(clarifyCall?.[0]).toMatchObject({
      previousPhaseMessage: { next_step: 'clarify' }
    });
    expect(planCall?.[0]).toMatchObject({
      previousPhaseMessage: null
    });
  });

  it('halts at a cooperative boundary when an active phase is manually paused', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-clarify') {
        const paused = await controller.pauseActivePhase();
        expect(paused).toEqual({ ok: true });
        return makeOutput({
          outcome: 'issues_remain',
          terminationReason: 'open_questions',
          result: { kind: 'open_questions', questions: ['Need scope'], auditEntry: { metrics: { open_questions: 1 } } as any }
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, 'specs/001-existing');

    const run = store.getRun()!;
    const task = queue.findById(feature.id)!;
    expect(run.status).toBe('paused');
    expect(run.manualPauseCause).toBe('operator-paused');
    expect(run.currentPhase).toBe('speckit-clarify');
    expect(run.currentIteration).toBe(2);
    expect(task.status).toBe('paused');
    expect(task.pauseCause).toBe('phase-paused');
    expect(store.getQueue().inFlightId).toBeNull();
    expect(lock.release).not.toHaveBeenCalled();
  });
});

describe('SchegentWorkflowController.startNew — speckit-bugfix pipeline routing (T021a, US2, FR-007 + FR-011 + FR-014)', () => {
  const BUGFIX_PHASES = [
    'bugfix-report',
    'bugfix-patch',
    'bugfix-verify-pre',
    'bugfix-implement',
    'bugfix-verify-post'
  ];

  it('(a) captures the bugfix pipeline 5-phase list in the immutable WorkflowRun.pipeline snapshot when pipelineId is supplied', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('bug report');

    await controller.startNew(feature, null, { pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID });

    const run = store.getRun()!;
    expect(run.pipeline?.id).toBe(BUILT_IN_BUGFIX_PIPELINE_ID);
    expect(run.pipeline?.name).toBe('Spec-kit Bugfix');
    const ids = run.pipeline?.phases.map((p) => p.id) ?? [];
    // The bugfix pipeline only declares the 5 ordered phases. The snapshot
    // contains the 5 declared phases.
    expect(ids.slice(0, BUGFIX_PHASES.length)).toEqual(BUGFIX_PHASES);
    expect(ids.length).toBe(5);
    expect(Object.isFrozen(run.pipeline)).toBe(true);
    expect(Object.isFrozen(run.pipeline?.phases)).toBe(true);
  });

  it('(b) mutating the catalog AFTER startNew returns does NOT retarget the immutable snapshot (FR-007)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('bug report');

    await controller.startNew(feature, null, { pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID });
    const snapshotBefore = store.getRun()!.pipeline;
    const phasesBefore = snapshotBefore!.phases.map((p) => p.id);

    // Replace the controller's catalog with one that defines a DIFFERENT 'speckit-bugfix'
    // pipeline (single-phase 'finalize'). The pre-existing run's snapshot must not retarget.
    const finalizeDef = BUILT_IN_PHASES.find((p) => p.id === 'finalize')!;
    const tamperedBugfix: PipelineDef = Object.freeze({
      id: BUILT_IN_BUGFIX_PIPELINE_ID,
      name: 'Tampered Bugfix',
      phases: Object.freeze(['finalize']) as readonly string[]
    });
    const tamperedCatalog = buildCatalog(
      [finalizeDef],
      [tamperedBugfix],
      [],
      BUILT_IN_BUGFIX_PIPELINE_ID
    );
    controller.setCatalog(tamperedCatalog);

    const snapshotAfter = store.getRun()!.pipeline;
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(snapshotAfter?.name).toBe('Spec-kit Bugfix');
    expect(snapshotAfter?.phases.map((p) => p.id)).toEqual(phasesBefore);

    // Direct mutation attempts MUST throw because the snapshot is frozen.
    expect(() => {
      (snapshotAfter as unknown as { name: string }).name = 'mutated';
    }).toThrow();
    expect(() => {
      (snapshotAfter?.phases as unknown as PhaseDef[]).push(finalizeDef);
    }).toThrow();
  });

  it('(c) falls back to BUILT_IN_PIPELINE_ID when startNew is invoked without a pipelineId option', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.pipeline?.id).toBe(BUILT_IN_PIPELINE_ID);
    expect(run.pipeline?.id).toBe('speckit-new-feature');
    // Adding the bugfix pipeline to BUILT_IN_PIPELINES did NOT change the default (FR-010
    // default-preservation): BUILT_IN_PIPELINES.length === 2, defaultPipelineId remains
    // BUILT_IN_PIPELINE_ID.
    expect(BUILT_IN_PIPELINES.length).toBe(2);
    expect(BUILT_IN_CATALOG.defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
  });

  it('(d) falls back to BUILT_IN_PIPELINE_ID for unknown pipelineId at the controller surface (existing warn-and-fallback path)', async () => {
    // NOTE: the GuardedRunService scheduler is the primary "unknown pipeline" rejection
    // surface (see src/services/guarded-run-service.ts and
    // tests/unit/services/guarded-run-service.test.ts) — the controller never receives an
    // unknown pipelineId in normal scheduling. The controller's own resolvePipelineSnapshot
    // path emits a warning and falls back to BUILT_IN_PIPELINE_ID rather than silently
    // continuing without a recognized pipeline. This test pins that defense-in-depth
    // behavior so a future refactor cannot quietly drop the warning.
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    const warnSpy = vi.fn();
    const realLogger = (
      controller as unknown as { logger: { warn: (msg: string) => void } }
    ).logger;
    const originalWarn = realLogger.warn.bind(realLogger);
    realLogger.warn = warnSpy;

    try {
      await controller.startNew(feature, null, { pipelineId: 'pipeline-that-does-not-exist' });

      const run = store.getRun()!;
      expect(run.pipeline?.id).toBe(BUILT_IN_PIPELINE_ID);
      expect(warnSpy).toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some((m) => m.includes("pipeline-that-does-not-exist") && m.includes("not found"))
      ).toBe(true);
    } finally {
      realLogger.warn = originalWarn;
    }
  });
});

describe('SchegentWorkflowController.resumeExisting', () => {
  it('returns false when no persisted run exists', async () => {
    const result = await controller.resumeExisting();
    expect(result).toBe(false);
  });

  it('returns false when persisted run is completed', async () => {
    const feature = await queue.enqueue('done feature');
    runSpy.mockImplementation(async () => makeOutput());
    await controller.startNew(feature, null);

    const result = await controller.resumeExisting();
    expect(result).toBe(false);
  });
});

describe('SchegentWorkflowController phase controls', () => {
  it('resumeActivePhase clears manual pause and pending retry state', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await store.setRun({
      id: 'run-manual',
      featureId: feature.id,
      featureDir: 'specs/001-existing',
      status: 'paused',
      currentPhase: 'speckit-plan',
      currentIteration: 2,
      startedAt: 1_700_000_000_000,
      lastTransitionAt: 1_700_000_000_000,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 2,
      pendingRetryAt: 1_700_000_500_000,
      pendingRetryCause: 'rate_limit',
      phaseOverrides: [],
      manualPauseAt: 1_700_000_100_000,
      manualPauseCause: 'operator-paused',
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    });

    const result = await controller.resumeActivePhase();
    const run = store.getRun()!;

    expect(result).toEqual({ ok: true });
    expect(run.manualPauseAt).toBeNull();
    expect(run.manualPauseCause).toBeNull();
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();
    expect(run.delayedRetryCount).toBe(0);
  });

  it('restartActivePhase resets iteration and clears current-phase overrides', async () => {
    const feature = await queue.enqueue('feature description');
    await store.setRun({
      id: 'run-restart',
      featureId: feature.id,
      featureDir: 'specs/001-existing',
      status: 'paused',
      currentPhase: 'speckit-plan',
      currentIteration: 4,
      startedAt: 1_700_000_000_000,
      lastTransitionAt: 1_700_000_000_000,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [
        { phaseId: 'speckit-plan', action: 'disabled', setAt: 1, actor: 'op' },
        { phaseId: 'speckit-tasks', action: 'disabled', setAt: 1, actor: 'op' }
      ],
      manualPauseAt: 1_700_000_100_000,
      manualPauseCause: 'operator-paused',
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    });

    const result = await controller.restartActivePhase();
    const run = store.getRun()!;

    expect(result).toEqual({ ok: true });
    expect(run.currentIteration).toBe(1);
    expect(run.manualPauseAt).toBeNull();
    expect(run.phaseOverrides.map((override) => override.phaseId)).toEqual(['speckit-tasks']);
  });

  it('skips disabled phases without mutating the pipeline snapshot', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await store.setRun({
      id: 'run-disabled',
      featureId: feature.id,
      featureDir: 'specs/001-existing',
      status: 'paused',
      currentPhase: 'speckit-clarify',
      currentIteration: 1,
      startedAt: 1_700_000_000_000,
      lastTransitionAt: 1_700_000_000_000,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [{ phaseId: 'speckit-clarify', action: 'disabled', setAt: 1, actor: 'op' }],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    });

    await controller.resumeExisting();

    const calledPhases = runSpy.mock.calls.map((call) => (call[0] as { phase: string }).phase);
    expect(calledPhases).not.toContain('speckit-clarify');
    expect(store.getRun()!.phasesCompleted[0].result).toBe('skipped');
    expect(store.getRun()!.pipeline?.phases.map((phase) => phase.id)).toContain('speckit-clarify');
  });
});

describe('SchegentWorkflowController — workspace lock release (BUG-005)', () => {
  it('releases the lock when the run completes successfully', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    expect(store.getRun()!.status).toBe('completed');
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('releases the lock when the run fails', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          outcome: 'failed',
          terminationReason: 'error',
          result: { kind: 'malformed', warnings: ['boom'], auditEntry: null },
          warnings: ['boom']
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(store.getRun()!.status).toBe('failed');
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('does not release the lock when the run pauses on rate-limit', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          outcome: 'rate_limited',
          terminationReason: 'rate_limit',
          result: { kind: 'rate_limited', cause: 'rate-limit', auditEntry: null }
        });
      }
      return makeOutput();
    });
    controller.setRateLimitHandler(async () => {});

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(store.getRun()!.status).toBe('paused');
    expect(lock.release).not.toHaveBeenCalled();
  });
});
