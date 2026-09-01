import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  SchegentWorkflowController,
  type WorkflowControllerDeps
} from '../../../src/controller/workflow-controller';
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
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';
import { LockHeldError } from '../../../src/lib/errors';
import {
  UncontainedBackendRefusedError,
  judgeBackendContainment
} from '../../../src/services/backend-containment-policy';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type {
  UncontainedConsentOutcome,
  UncontainedConsentPort
} from '../../../src/controller/uncontained-consent-gate';

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
//
// The `auditWriter` arrived on 2026-08-31 and is why this is built per test rather
// than shared: without one, every `WorkflowLifecycleAuditor` method short-circuits
// on `if (!this.writer) return;`, so a suite that owns the controller's terminal
// failure route could not see whether that route wrote a durable record at all. It
// did not. See `emits the terminal audit record` below.
let auditAppend: ReturnType<typeof vi.fn>;
let deps: WorkflowControllerDeps;

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
  auditAppend = vi.fn().mockResolvedValue(undefined);
  deps = { catalog: testCatalog(), auditWriter: { append: auditAppend } };
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

  /**
   * The durable record of a failed run, which this route did not write until
   * 2026-08-31.
   *
   * `task-execution-ended` is what the audit log, the metrics rollup and every
   * after-the-fact question about a run read to learn that it reached a terminal
   * state and how. FR-R3-107 consolidated its three drifted emissions into ONE
   * emitter — and that emitter was private to `RunDriver`, which is the wrong side
   * of this boundary. `handleUnexpectedStartFailure` is a SECOND route to a terminal
   * state: it persists `status: 'failed'`, finishes the queue row, records history
   * and releases the lease, all without the drive ever settling. So the run was
   * `failed` in the state store and still *open* in the durable record.
   *
   * Found in a live host log (`docs/audits/syslog-triage-2026-08-30.md`, finding
   * 2b — retired 2026-08-31, its record is now the envelope's
   * `docs/features/round_3/00_INDEX.md` under `syslog-triage-2026-08-30`): four
   * `task-execution-started`, one `task-execution-ended`. The runs that
   * failed left their reason in a DEBUG line that is off by default, and nothing
   * else. The payload asserted below is the driver's, because the point is one shape
   * from both routes — the metrics rollup unions these by run id, and a second shape
   * would make a total depend on which route a run took.
   */
  it('emits the terminal audit record when the run fails at the controller', async () => {
    runSpy.mockRejectedValueOnce(new Error('parser invariant exploded'));

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;

    const ended = auditAppend.mock.calls
      .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .filter((entry) => entry.eventType === 'task-execution-ended');
    expect(
      ended.length,
      'a run that reached `failed` must leave exactly one terminal record; zero means the ' +
        'durable log cannot tell a failed run from one still running'
    ).toBe(1);
    // Bound once, after the length assertion that makes the `!` true — four `ended[0]`
    // reads would each owe `noUncheckedIndexedAccess` a diagnostic the ratchet refuses.
    const terminal = ended[0]!;
    expect(terminal.payload).toMatchObject({
      taskId: feature.id,
      runId: run.id,
      terminalStatus: 'failed'
    });
    // The reason, in the record rather than only in a DEBUG log.
    expect(terminal.payload.lastErrorSummary).toContain('parser invariant exploded');
    // The same derived statistics the driver's emitter carries, not hand-written zeros.
    expect(terminal.payload.phasesTotal).toBe(SPECKIT_PHASE_IDS.length);
    expect(typeof terminal.payload.durationMs).toBe('number');
  });

  /**
   * FR-R3-146 (FR-005) — a policy refusal is not a crash, and its remedy is not
   * optional text.
   *
   * The operator report this feature answers received exactly this, from a fresh
   * install whose shipped default backend is refused by its shipped default grant:
   *
   *   workflow 7860845a-… failed unexpectedly: The 'claude' backend runs without an
   *   OS-enforced bound … Add 'claude' to 'schegent.backend.uncontainedBackends' to
   *   accept that for this backend only, or cho
   *
   * Two defects in one line. It is announced as an unexpected failure, and it is cut
   * at 240 characters — through the half that names the remedy. The refusal is
   * deliberate and correct; only its reporting is wrong.
   *
   * Driven through `runSpy` because `handleUnexpectedStartFailure` is the funnel
   * every throw from the drive path reaches, and the construction refusal is one.
   */
  describe('a containment refusal is reported as the policy decision it is', () => {
    const refusal = (): UncontainedBackendRefusedError => {
      const verdict = judgeBackendContainment('claude', new Set<BackendRunnerKind>());
      if (verdict.outcome !== 'refused') throw new Error('unreachable');
      return new UncontainedBackendRefusedError(verdict.kind, verdict.message);
    };

    it('records its own code, not unexpected-controller-error', async () => {
      runSpy.mockRejectedValueOnce(refusal());

      const feature = await queue.enqueue('feature description');
      await expect(controller.startNew(feature, null)).resolves.toBeUndefined();

      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.status).toBe('failed');
      expect(run.lastError!.code).toBe('uncontained-backend-refused');

      // And the queue row agrees — an operator reading the queue sees the same code.
      const row = queue.findById(feature.id);
      if (row?.lastError && typeof row.lastError === 'object') {
        expect(row.lastError.code).toBe('uncontained-backend-refused');
      }
    });

    it('records the message in full, not a 240-character prefix', async () => {
      const thrown = refusal();
      // Non-vacuity: if the message were ever shortened below the cut, this test
      // would pass without proving anything.
      expect(thrown.message.length).toBeGreaterThan(240);
      runSpy.mockRejectedValueOnce(thrown);

      const feature = await queue.enqueue('feature description');
      await controller.startNew(feature, null);

      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.lastError!.message).toBe(thrown.message);
      // The exact severance the operator reported, named so a regression is legible.
      expect(run.lastError!.message).not.toMatch(/or cho$/);
      expect(run.lastError!.message).toContain('schegent.backend.uncontainedBackends');
      expect(run.lastError!.message).toContain('choose a backend that carries a sandbox');
    });

    it('does not announce it as an unexpected failure', async () => {
      runSpy.mockRejectedValueOnce(refusal());

      const feature = await queue.enqueue('feature description');
      await controller.startNew(feature, null);

      const announcements = vi
        .mocked(notifier.warn)
        .mock.calls.map((call) => String(call[0]));
      expect(announcements.length).toBeGreaterThan(0);
      expect(announcements.join('\n')).not.toContain('failed unexpectedly');
    });

    it('leaves the other two branches exactly as they were', async () => {
      // The general case is out of scope: everything that is not this refusal keeps
      // its code, its truncation, and its wording.
      runSpy.mockRejectedValueOnce(new LockHeldError('other-window'));
      const held = await queue.enqueue('lock held');
      await controller.startNew(held, null);
      expect(store.getRun(DEFAULT_QUEUE_ID)!.lastError!.code).toBe('lock-held');

      const long = `parser invariant exploded: ${'x'.repeat(400)}`;
      runSpy.mockRejectedValueOnce(new Error(long));
      const boom = await queue.enqueue('unexpected');
      await controller.startNew(boom, null);
      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.lastError!.code).toBe('unexpected-controller-error');
      expect(run.lastError!.message).toHaveLength(240);
    });
  });

  /**
   * FR-R3-146 (FR-002, FR-003) — the refusal becomes a question, asked once.
   *
   * The gate's bound is the GRANT, not a counter: once a kind has been granted in
   * this window it is never asked about again, so a write that did not take effect
   * fails as the fault it is instead of reopening the same modal.
   */
  describe('a containment refusal is offered to the operator, once', () => {
    const refusal = (): UncontainedBackendRefusedError => {
      const verdict = judgeBackendContainment('claude', new Set<BackendRunnerKind>());
      if (verdict.outcome !== 'refused') throw new Error('unreachable');
      return new UncontainedBackendRefusedError(verdict.kind, verdict.message);
    };

    function withConsent(outcome: UncontainedConsentOutcome) {
      // Typed as the port, so `mock.calls[0][0]` is the refusal the controller
      // actually passes rather than an inferred empty tuple.
      const requestUncontainedConsent = vi.fn<UncontainedConsentPort>(async () => outcome);
      return {
        requestUncontainedConsent,
        controller: new SchegentWorkflowController(
          phaseRunner,
          store,
          queue,
          statusBar,
          notifier,
          new SanitizedLogger(),
          lock,
          opts,
          { ...deps, requestUncontainedConsent }
        )
      };
    }

    it('prompts, and on the grant retries the run to completion', async () => {
      const c = withConsent({ decision: 'granted' });
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      // The modal is handed the backend and the policy's own message, not a paraphrase.
      // `lastCall` rather than `calls[0][0]`: the call count is asserted above, and
      // an optional access keeps this out of the `noUncheckedIndexedAccess` ratchet.
      const asked = c.requestUncontainedConsent.mock.lastCall?.[0];
      expect(asked?.kind).toBe('claude');
      expect(asked?.message).toBe(refusal().message);
      expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');
    });

    it('denies on dismissal, and reports the refusal without retrying', async () => {
      const c = withConsent({ decision: 'denied' });
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.status).toBe('failed');
      expect(run.lastError!.code).toBe('uncontained-backend-refused');
      // One drive attempt, not two — a denial does not retry.
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('cannot loop when the grant is written but does not take effect', async () => {
      // The host accepted the write and the setting still reads as it did. That is a
      // real fault; asking the same question again would never end.
      const c = withConsent({ decision: 'granted' });
      runSpy.mockRejectedValue(refusal());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledTimes(2);
      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.status).toBe('failed');
      expect(run.lastError!.code).toBe('uncontained-backend-refused');
    });

    it('surfaces a different failure after the grant as itself, not as consent', async () => {
      // The operator granted the backend and the CLI is not installed. Re-prompting
      // for consent they already gave would hide the problem they can actually fix.
      const c = withConsent({ decision: 'granted' });
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockRejectedValueOnce(new Error('spawn claude ENOENT'));

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.lastError!.code).toBe('unexpected-controller-error');
      expect(run.lastError!.message).toContain('ENOENT');
    });

    it('says the approval could not be saved, rather than calling it a refusal', async () => {
      const c = withConsent({ decision: 'write-failed', reason: 'profile is read-only' });
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.lastError!.code).toBe('uncontained-consent-write-failed');
      expect(run.lastError!.message).toContain('profile is read-only');
      expect(run.lastError!.message).toContain('schegent.backend.uncontainedBackends');
      // Not retried: the grant was never recorded, so a second drive would be refused
      // again for the same reason.
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    // FR-R3-146 (FR-002, SC-002, US3-1) — the refusal path, asserted rather than
    // assumed. A consent surface whose declined branch is untested is the rubber
    // stamp FR-R3-056 removed; these are the three things a decline must leave true.
    it('leaves nothing behind when the operator declines', async () => {
      const c = withConsent({ decision: 'denied' });
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      // Asked once, answered once. The port is the only thing that can write the
      // setting, and a `denied` outcome is the port reporting it wrote nothing —
      // the branch `uncontained-consent.test.ts` pins on the writing side.
      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      // No second drive, so no runner is constructed after the decline. This is the
      // whole safety property: the decision resolves in the host, before any spawn.
      expect(runSpy).toHaveBeenCalledTimes(1);

      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.status).toBe('failed');
      // A policy refusal, recorded as one. Not `unexpected-controller-error`, and
      // not cut at 240 characters — the operator keeps the half that says what to do.
      expect(run.lastError!.code).toBe('uncontained-backend-refused');
      expect(run.lastError!.code).not.toBe('unexpected-controller-error');
      expect(run.lastError!.message).toContain('schegent.backend.uncontainedBackends');
      expect(run.lastError!.message.length).toBeGreaterThan(240);
    });

    it('never prompts an operator who already granted the backend by hand', async () => {
      // Nothing refuses, so nothing asks. The existing path is untouched.
      const c = withConsent({ decision: 'granted' });
      runSpy.mockImplementation(async () => makeOutput());

      const feature = await queue.enqueue('feature description');
      await c.controller.startNew(feature, null);

      expect(c.requestUncontainedConsent).not.toHaveBeenCalled();
      expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');
    });

    /**
     * FR-002 says "when A RUN is refused", and a resumed run is a run. Every case
     * above drives through `startNew`, and the gate was wired onto that admission
     * only — so the refusal a RESUMED run raises went straight past the gate and
     * out of `admitResume`'s `completed` promise, to be caught by whatever the
     * caller happened to have. For the auto-drain that is `detach()`, which logs
     * `run on queue default ended abnormally: <message>` and stops.
     *
     * Found in `docs/audits/syslog-triage-2026-08-30.md` from a live syslog —
     * retired 2026-08-31, its record is now the envelope's
     * `docs/features/round_3/00_INDEX.md` under `syslog-triage-2026-08-30`: a
     * task refused twice on the drain path, one truncated ERROR, no modal, and no
     * `uncontained-backend-refused` anywhere in 5,068 lines. The drain resumes
     * in-flight work, so this was the unattended path the product exists to run.
     */
    async function pauseRunForResume(featureId: string): Promise<void> {
      await store.setRun(DEFAULT_QUEUE_ID, {
        id: 'run-resume-consent',
        featureId,
        featureDir: 'specs/001-existing',
        // Required: `resumeExistingOnQueue` refuses a run with no pipeline snapshot,
        // and would return NOT_RESUMED before reaching the drive this pins.
        pipeline: pre074Snapshot(SPECKIT_PIPELINE_ID),
        status: 'paused',
        currentPhase: 'speckit-plan',
        currentIteration: 1,
        startedAt: 1_700_000_000_000,
        lastTransitionAt: 1_700_000_000_000,
        phasesCompleted: [],
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        phaseOverrides: [],
        // `verify-paused` specifically, and it is load-bearing. Of the four
        // manual-pause causes only this one is cleared on resume
        // (`clearedPauseFieldsOnResume`); `operator-paused` and
        // `queue-paused-mid-run` MUST survive, and `decideAfterPhase` re-reads
        // `manualPauseAt` at every phase boundary, so a Run carrying either
        // drives exactly one phase and pauses again. That would make the
        // end-state assertion below a statement about the pause-cause matrix
        // rather than about the gate. This is also the shape the drain actually
        // meets: `RunDriver`'s `pause-verify` branch is what stamps it.
        manualPauseAt: 1_700_000_100_000,
        manualPauseCause: 'verify-paused',
        phaseBreakpoints: [],
        resumeTargetPhaseId: null
      },
        unfencedCommit('test-fixture')
      );
    }

    it('asks on a resumed run too, and retries it on the grant', async () => {
      const c = withConsent({ decision: 'granted' });
      const feature = await queue.enqueue('resumed feature');
      await pauseRunForResume(feature.id);
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const admission = await c.controller.admitResume(DEFAULT_QUEUE_ID);
      expect(admission.resumed).toBe(true);
      await admission.completed;

      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      expect(c.requestUncontainedConsent.mock.lastCall?.[0].kind).toBe('claude');
      expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');
    });

    it('records a declined resume as a policy refusal, not an abnormal ending', async () => {
      // The half the syslog showed: without the gate the refusal escapes
      // `completed` as a bare rejection and the operator gets auto-drain's
      // "ended abnormally", with the remedy cut off. It must be recorded on the
      // run, in full, the same way a declined `startNew` is.
      const c = withConsent({ decision: 'denied' });
      const feature = await queue.enqueue('resumed feature');
      await pauseRunForResume(feature.id);
      runSpy.mockRejectedValueOnce(refusal());
      runSpy.mockImplementation(async () => makeOutput());

      const admission = await c.controller.admitResume(DEFAULT_QUEUE_ID);
      await expect(admission.completed).resolves.toBeUndefined();

      expect(c.requestUncontainedConsent).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledTimes(1);
      const run = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(run.status).toBe('failed');
      expect(run.lastError!.code).toBe('uncontained-backend-refused');
      expect(run.lastError!.message).toContain('schegent.backend.uncontainedBackends');
      expect(run.lastError!.message.length).toBeGreaterThan(240);
    });
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
    },
      unfencedCommit('test-fixture')
    );
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
    },
      unfencedCommit('test-fixture')
    );

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
    },
      unfencedCommit('test-fixture')
    );

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
    },
      unfencedCommit('test-fixture')
    );

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
