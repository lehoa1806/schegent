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
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';

// Feature 098 (T080) — the two Pipelines these tests drive, declared here instead
// of read off `BUILT_IN_PIPELINE` / `BUILT_IN_BUGFIX_PIPELINE`. They keep the
// Spec-kit ids on purpose, because two things in the host still key on those exact
// strings: `LOOP_PHASES` in `controller/phase.ts` decides which Phase loops, and
// `workflow-run-factory.ts` skips the Phase after `speckit-specify` when a
// featureDir is supplied. A test of either behavior needs a Pipeline that declares
// them. That is a statement about the host's remaining hardcoded vocabulary — the
// catalog ships none of these rows, and every one below is built by this file.
const SPECKIT_PIPELINE_ID = 'speckit-new-feature';
const SPECKIT_PHASE_IDS = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-review',
  'finalize'
];

const BUGFIX_PIPELINE_ID = 'speckit-bugfix';
const BUGFIX_PHASE_IDS = [
  'bugfix-report',
  'bugfix-patch',
  'bugfix-verify-pre',
  'bugfix-implement',
  'bugfix-verify-post'
];

/**
 * A Phase declaring nothing beyond its identity, except where a test needs a
 * declaration to be visible. `speckit-specify` and `finalize` pin `runner:
 * 'claude'` so the runner-inheritance test has both a pinned Phase and an
 * inheriting one; `speckit-clarify` carries the retryCondition that makes it
 * loopable, which is what the clarify-loop tests exercise.
 */
function testPhase(id: string): PhaseDef {
  const base: PhaseDef = { id, name: id, instruction: `run ${id}` };
  if (id === 'speckit-specify' || id === 'finalize') return { ...base, runner: 'claude' };
  if (id === 'speckit-clarify') {
    return { ...base, loopable: true, retryCondition: 'open_questions > 0' };
  }
  return base;
}

const TEST_PHASES: readonly PhaseDef[] = Object.freeze(
  [...SPECKIT_PHASE_IDS, ...BUGFIX_PHASE_IDS].map(testPhase)
);

const SPECKIT_PIPELINE: PipelineDef = Object.freeze({
  id: SPECKIT_PIPELINE_ID,
  name: 'Spec-kit New Feature',
  phases: Object.freeze([...SPECKIT_PHASE_IDS]) as readonly string[]
});

const BUGFIX_PIPELINE: PipelineDef = Object.freeze({
  id: BUGFIX_PIPELINE_ID,
  name: 'Spec-kit Bugfix',
  phases: Object.freeze([...BUGFIX_PHASE_IDS]) as readonly string[]
});

function testCatalog() {
  return buildCatalog(
    TEST_PHASES,
    [SPECKIT_PIPELINE, BUGFIX_PIPELINE],
    { claude: [], codex: [], agy: [] },
    SPECKIT_PIPELINE_ID
  );
}

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

/**
 * Feature 098 (T026) — a pre-074 `pipeline` snapshot: present, because feature 009
 * predates 074, and carrying no per-phase `runner`, because that is the field 074
 * added. Two of the fixtures below omitted `pipeline` entirely, which quietly made
 * them pre-*009* records too. The resume path used to synthesize the built-in
 * Pipeline for those and now refuses, so a test about runner pinning or about
 * disabled-phase skipping supplies the snapshot it is actually about.
 */
function pre074Snapshot(pipelineId: string): WorkflowRunPipeline {
  const pipeline = [SPECKIT_PIPELINE, BUGFIX_PIPELINE].find(
    (candidate) => candidate.id === pipelineId
  )!;
  const byId = new Map(TEST_PHASES.map((phase) => [phase.id, phase]));
  return {
    id: pipeline.id,
    name: pipeline.name,
    phases: pipeline.phases.map((phaseId) => ({ ...byId.get(phaseId)!, runner: undefined }))
  };
}

function makeLock(): WorkspaceLockManager & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
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
  timeoutMs: 5_000
};

// Feature 098 (T080) — the controller's own fallback is the empty catalog now, so
// a test that means to drive a Pipeline has to hand it one. It goes in the deps
// argument rather than in `opts`, which is where the controller reads it.
const deps = { catalog: testCatalog() };

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
    opts,
    deps
  );
});

describe('SchegentWorkflowController.startNew', () => {
  it('drives every phase of the pipeline to completion when all return clean', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('completed');
    expect(run.currentPhase).toBe('done');
    expect(runSpy).toHaveBeenCalledTimes(SPECKIT_PHASE_IDS.length);
    const phasesCalled = runSpy.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phasesCalled).toEqual(SPECKIT_PHASE_IDS);
  });

  it('snapshots the default pipeline onto run.pipeline when no pipelineId is supplied (T022, US1)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pipeline).toBeTruthy();
    expect(run.pipeline?.id).toBe(SPECKIT_PIPELINE_ID);
    expect(run.pipeline?.name).toBe('Spec-kit New Feature');
    expect(run.pipeline?.phases.map((p) => p.id)).toEqual(SPECKIT_PHASE_IDS);
  });

  it('freezes the effective global runner into every inherited phase', async () => {
    const agyController = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      new SanitizedLogger(),
      lock,
      { ...opts, defaultRunnerKind: 'agy' },
      deps
    );
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await agyController.startNew(feature, null);

    const persistedRun = store.getRun(DEFAULT_QUEUE_ID)!;
    const phases = persistedRun.pipeline!.phases;
    expect(persistedRun.defaultRunnerKind).toBe('agy');
    expect(phases.find((phase) => phase.id === 'speckit-specify')?.runner).toBe('claude');
    expect(phases.find((phase) => phase.id === 'speckit-clarify')?.runner).toBe('agy');
    expect(phases.find((phase) => phase.id === 'finalize')?.runner).toBe('claude');
    expect(phases.every((phase) => phase.runner !== undefined)).toBe(true);
    expect(phases.every((phase) => Object.isFrozen(phase))).toBe(true);
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
      { claude: [], codex: [], agy: [] },
      'custom-pipe'
    );
    controller.setCatalog(catalog);
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null, { pipelineId: 'custom-pipe' });

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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
    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');
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

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('failed');
    expect(run.lastError).not.toBeNull();
    expect(run.lastError!.code).toBe('invocation-failed');
  });

  it('marks the run and queue item failed when the runner throws unexpectedly', async () => {
    runSpy.mockRejectedValueOnce(new Error('parser invariant exploded'));

    const feature = await queue.enqueue('feature description');
    await expect(controller.startNew(feature, null)).resolves.toBeUndefined();

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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
    // Feature 093 (T068b, FR-028) — was `expect(lock.release).toHaveBeenCalled()`.
    // The sign is inverted, not the assertion dropped: an unexpected start
    // failure is a Run-scoped event, and primacy is the window's. With a sibling
    // Run mid-phase this release ended primacy for both, because
    // `WorkspaceLockManager.release()` keeps no reference count and both Runs
    // share the window's owner id. It joins the BUG-005 block below, which
    // already asserts the same for complete / fail / rate-limit-pause.
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('cancels mid-run when cancelActive is invoked', async () => {
    runSpy.mockImplementation(async () => {
      controller.cancelActive();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    const task = queue.findById(feature.id)!;
    expect(run.status).toBe('paused');
    expect(run.manualPauseCause).toBe('operator-paused');
    expect(run.currentPhase).toBe('speckit-clarify');
    expect(run.currentIteration).toBe(2);
    expect(task.status).toBe('paused');
    expect(task.pauseCause).toBe('phase-paused');
    expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();
    expect(lock.release).not.toHaveBeenCalled();
  });
});

describe('SchegentWorkflowController.startNew — second-pipeline routing (T021a, US2, FR-007 + FR-011 + FR-014)', () => {
  it('(a) captures the bugfix pipeline 5-phase list in the immutable WorkflowRun.pipeline snapshot when pipelineId is supplied', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('bug report');

    await controller.startNew(feature, null, { pipelineId: BUGFIX_PIPELINE_ID });

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pipeline?.id).toBe(BUGFIX_PIPELINE_ID);
    expect(run.pipeline?.name).toBe('Spec-kit Bugfix');
    const ids = run.pipeline?.phases.map((p) => p.id) ?? [];
    // The snapshot contains exactly the phases the pipeline declares — no
    // terminal append, no substitution for an id the catalog cannot resolve.
    expect(ids).toEqual(BUGFIX_PHASE_IDS);
    expect(Object.isFrozen(run.pipeline)).toBe(true);
    expect(Object.isFrozen(run.pipeline?.phases)).toBe(true);
  });

  it('(b) mutating the catalog AFTER startNew returns does NOT retarget the immutable snapshot (FR-007)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('bug report');

    await controller.startNew(feature, null, { pipelineId: BUGFIX_PIPELINE_ID });
    const snapshotBefore = store.getRun(DEFAULT_QUEUE_ID)!.pipeline;
    const phasesBefore = snapshotBefore!.phases.map((p) => p.id);

    // Replace the controller's catalog with one that defines a DIFFERENT 'speckit-bugfix'
    // pipeline (single-phase 'finalize'). The pre-existing run's snapshot must not retarget.
    const finalizeDef = TEST_PHASES.find((p) => p.id === 'finalize')!;
    const tamperedBugfix: PipelineDef = Object.freeze({
      id: BUGFIX_PIPELINE_ID,
      name: 'Tampered Bugfix',
      phases: Object.freeze(['finalize']) as readonly string[]
    });
    const tamperedCatalog = buildCatalog(
      [finalizeDef],
      [tamperedBugfix],
      { claude: [], codex: [], agy: [] },
      BUGFIX_PIPELINE_ID
    );
    controller.setCatalog(tamperedCatalog);

    const snapshotAfter = store.getRun(DEFAULT_QUEUE_ID)!.pipeline;
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

  it('(c) falls back to the catalog defaultPipelineId when startNew is invoked without a pipelineId option', async () => {
    // Feature 098 (T080) — this case also asserted `BUILT_IN_PIPELINES.length === 3`
    // and that `BUILT_IN_CATALOG.defaultPipelineId` equalled `BUILT_IN_PIPELINE_ID`.
    // Both were statements about which rows the product compiles in, and T036
    // emptied that layer. What is left is the behavior the title names: with no
    // `pipelineId` option, the Run targets whatever the *catalog in hand* declares
    // as its default — the fixture catalog here, an imported one in the product.
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pipeline?.id).toBe(controller.getCatalog().defaultPipelineId);
    expect(run.pipeline?.id).toBe(SPECKIT_PIPELINE_ID);
  });

  it('(d) refuses an unknown pipelineId at the controller surface rather than substituting one', async () => {
    // Feature 098 (T026, US3, FR-023/FR-033b) — this pinned the opposite: the
    // controller warned and fell back to BUILT_IN_PIPELINE_ID, on the reasoning that
    // continuing with *a* recognized Pipeline beat continuing with none. With the
    // built-in layer about to be empty there is nothing to fall back to, and while
    // the rows are still present the fallback runs a Spec-kit Pipeline the operator
    // did not ask for. The warning it pinned is still asserted — what changed is
    // that no Run exists afterwards, so nothing executed under the wrong process.
    //
    // The GuardedRunService scheduler remains the primary rejection surface for an
    // unknown id; this is the defense-in-depth layer behind it.
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

      expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
      expect(runSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('pipeline-that-does-not-exist') &&
            m.includes('not in the effective catalog')
        )
      ).toBe(true);
    } finally {
      realLogger.warn = originalWarn;
    }
  });
});

describe('SchegentWorkflowController.resumeExisting', () => {
  it('returns false when no persisted run exists', async () => {
    const result = await controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(result).toBe(false);
  });

  it('returns false when persisted run is completed', async () => {
    const feature = await queue.enqueue('done feature');
    runSpy.mockImplementation(async () => makeOutput());
    await controller.startNew(feature, null);

    const result = await controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(result).toBe(false);
  });

  it('pins the configured backend when first migrating a pre-074 run', async () => {
    const feature = await queue.enqueue('legacy Codex feature');
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: 'run-pre-074-codex',
      featureId: feature.id,
      featureDir: 'specs/001-existing',
      pipeline: pre074Snapshot(SPECKIT_PIPELINE_ID),
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
      phaseOverrides: [],
      manualPauseAt: 1_700_000_100_000,
      manualPauseCause: 'operator-paused',
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    });
    runSpy.mockImplementation(async () => makeOutput());
    const codexController = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      new SanitizedLogger(),
      lock,
      { ...opts, defaultRunnerKind: 'codex' },
      deps
    );

    expect(await codexController.resumeExisting(DEFAULT_QUEUE_ID)).toBe(true);

    expect(store.getRun(DEFAULT_QUEUE_ID)!.defaultRunnerKind).toBe('codex');
    expect(runSpy.mock.calls[0][0]).toMatchObject({
      phase: 'speckit-clarify',
      phaseDef: expect.objectContaining({ runner: 'codex' })
    });
  });
});

describe('SchegentWorkflowController phase controls', () => {
  it('resumeActivePhase clears manual pause and pending retry state', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await store.setRun(DEFAULT_QUEUE_ID, {
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
    const run = store.getRun(DEFAULT_QUEUE_ID)!;

    expect(result).toEqual({ ok: true });
    expect(run.manualPauseAt).toBeNull();
    expect(run.manualPauseCause).toBeNull();
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();
    expect(run.delayedRetryCount).toBe(0);
  });

  it('restartActivePhase resets iteration and clears current-phase overrides', async () => {
    const feature = await queue.enqueue('feature description');
    await store.setRun(DEFAULT_QUEUE_ID, {
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
    const run = store.getRun(DEFAULT_QUEUE_ID)!;

    expect(result).toEqual({ ok: true });
    expect(run.currentIteration).toBe(1);
    expect(run.manualPauseAt).toBeNull();
    expect(run.phaseOverrides.map((override) => override.phaseId)).toEqual(['speckit-tasks']);
  });

  it('skips disabled phases without mutating the pipeline snapshot', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: 'run-disabled',
      featureId: feature.id,
      featureDir: 'specs/001-existing',
      pipeline: pre074Snapshot(SPECKIT_PIPELINE_ID),
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

    await controller.resumeExisting(DEFAULT_QUEUE_ID);

    const calledPhases = runSpy.mock.calls.map((call) => (call[0] as { phase: string }).phase);
    expect(calledPhases).not.toContain('speckit-clarify');
    expect(store.getRun(DEFAULT_QUEUE_ID)!.phasesCompleted[0].result).toBe('skipped');
    expect(store.getRun(DEFAULT_QUEUE_ID)!.pipeline?.phases.map((phase) => phase.id)).toContain('speckit-clarify');
  });
});

// Feature 092 (T136, BUG-002, FR-032a) — BUG-005's concern was a workspace lock
// that outlived its run and stranded the window. The two terminal cases below
// used to assert the fix as "the run's end releases the lock", which BUG-002
// showed to be the wrong mechanism rather than the wrong goal: `withLock`
// acquires idempotently per owner with no reference count, so with two Runs in
// one window the first to finish released primacy for both. Primacy now runs
// activation-to-disposal, and BUG-005's protection lives at `dispose()` in
// src/extension.ts — verified by tests/integration/window-primacy-lifetime.test.ts,
// which also asserts the release still happens there. What these cases assert
// now is the other half: a Run's end does NOT touch it.
describe('SchegentWorkflowController — workspace lock release (BUG-005)', () => {
  it('leaves the lock held when the run completes successfully', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');

    await controller.startNew(feature, null);

    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('leaves the lock held when the run fails', async () => {
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

    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('failed');
    expect(lock.release).not.toHaveBeenCalled();
  });

  // No longer discriminating post-FR-032a — no terminal status releases primacy,
  // so this agrees with the two cases above rather than contrasting with them.
  // Kept because the pause path reaching `release()` would still be a defect.
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

    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('paused');
    expect(lock.release).not.toHaveBeenCalled();
  });
});
