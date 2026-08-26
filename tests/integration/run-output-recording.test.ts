// Feature 091 (T008, US1) — the story end to end, over a real disk.
//
// The unit tests each pin one link: the resolver's ordering and failure
// handling, the probe's bound, the driver's transition, the history round trip,
// the reader's two refusals. None of them can catch a link that is simply not
// attached — which is precisely the defect this slice exists to close, since
// `resolveRunOutputs` shipped correct and uncalled.
//
// So everything below the request is real: a real temporary workspace, the real
// `validateRunRequest()` freeze, the real bounded filesystem probe, the real
// `RunDriver` completion branch, the real `HistoryRecorder` writing to a real
// `HistoryStore`, and the real `resolvePriorOutput`. The phase runner is the one
// double, because a Run's *work* is not what is under test — what it recorded
// having done is.
//
// The declared targets are absent when the plan is frozen and one of them exists
// by the time the Run completes. That ordering is the point: an output is
// something the Run produced, so a fixture that pre-creates both would be
// testing the probe against a tree the Run never touched.

import * as fs from 'node:fs/promises';
import { unfencedCommit } from '../../src/state/ownership-claim';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDef, PipelineDef } from '../../src/config/pipeline-config';
import type { FrozenRunPlan, RunRequest } from '../../src/contracts/run-request';
import { SanitizedLogger } from '../../src/lib/logger';
import { resolvePriorOutput } from '../../src/services/run-request/output-reference-resolver';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../src/services/run-request/run-request-validator';
import { createBoundedOutputProbe } from '../../src/services/run-output/run-output-probe';
import { HistoryRecorder } from '../../src/services/history-recorder';
import { RunDriver, type RunDriverDeps } from '../../src/services/run-driver';
import { HistoryStore } from '../../src/state/history-store';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { PhaseRunOutput } from '../../src/controller/phase-runner';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';

const NOW = 1_700_000_000_000;

const COMPOSE: PhaseDef = {
  id: 'compose',
  name: 'Compose',
  version: 1,
  instruction: 'Compose the thing.',
};

const REPORTING_FLOW: PipelineDef = {
  id: 'reporting-flow',
  name: 'Reporting Flow',
  phases: ['compose'],
  inputs: [],
  outputs: [
    { portId: 'report', label: 'Report', type: 'markdown' },
    { portId: 'summary', label: 'Summary', type: 'file' }
  ]
};

const SOURCE: EffectivePipelineSource = {
  definition: REPORTING_FLOW,
  phases: [COMPOSE],
  defaultRunnerKind: 'claude'
};

const REQUEST: RunRequest = {
  pipelineId: 'reporting-flow',
  inputs: [],
  supplemental: [],
  outputs: [
    { portId: 'report', target: 'out/report.md' },
    { portId: 'summary', target: 'out/summary.txt' }
  ],
  instructions: 'produce the report'
};

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

function makeLock(): any {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  };
}

let workspaceRoot: string;
let store: WorkspaceStateStore;
let history: HistoryStore;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-run-outputs-'));
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  history = new HistoryStore(store);
});

afterEach(async () => {
  history.dispose();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** The freeze the operator approved: two declared targets, neither yet on disk. */
async function freezePlan(): Promise<FrozenRunPlan> {
  const outcome = await validateRunRequest(REQUEST, {
    pipeline: SOURCE,
    workspaceRoot,
    now: NOW,
    localInputs: {
      checkFile: async () => ({ ok: true }) as const,
      checkFolder: async () => ({ ok: true }) as const
    },
    // The real bounded probe, against the real temp tree.
    outputProbe: createBoundedOutputProbe(),
    priorOutputs: { outputsFor: () => null }
  });
  if (!outcome.ok) {
    throw new Error(`plan did not freeze: ${JSON.stringify(outcome.errors)}`);
  }
  return outcome.plan;
}

/** Drives one Run of that plan to completion and returns its recorded outputs. */
async function completeRun(plan: FrozenRunPlan, runId: string) {
  const phaseRunner = {
    run: vi.fn().mockResolvedValue({
      result: { kind: 'clean', warnings: [], auditEntry: null },
      outcome: 'clean',
      terminationReason: 'completed',
      stdoutSummary: '',
      stderrSummary: '',
      exitCode: 0,
      warnings: [],
      auditEntryId: null
    } as unknown as PhaseRunOutput),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined)
  };

  const deps: RunDriverDeps = {
    store,
    runner: phaseRunner as any,
    logger: new SanitizedLogger([]),
    options: { iterationCap: 5, cwd: workspaceRoot, cliPath: '/test/bin' } as any,
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (run) => run)
    } as any,
    // FR-R3-001 (T266) — the queue row no longer answers "what did this Run
    // declare?". The Run's own envelope does, attached below exactly as
    // `WorkflowRunFactory.create()` attaches it. `findById` is left returning
    // nothing so a regression that re-reads the row here fails rather than
    // silently reading a second copy that happens to agree.
    queue: {
      finish: vi.fn(),
      pause: vi.fn(),
      findById: vi.fn(() => null)
    } as any,
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    statusBar: { update: vi.fn(), dispose: vi.fn() } as any,
    historyRecorder: new HistoryRecorder({
      historyStore: history,
      logger: new SanitizedLogger([]),
      // FR-R3-010 — these cases are about `runOutputs` reaching the entry. The
      // partition is fixed and the description store is inert so nothing here
      // touches the filesystem.
      queueIdForTask: () => DEFAULT_QUEUE_ID,
      // Feature 103 — no connected Workflow drives these cases.
      originForTask: () => ({ kind: 'standalone' }),
      descriptions: { write: async () => null, remove: async () => undefined }
    }),
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(),
    emitOptionalPhaseFailureContinued: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit: vi.fn(),
    appendBreakpointAudit: vi.fn(),
    isContinueGate: { consume: vi.fn().mockReturnValue(false) } as any,
    lock: makeLock(),
    persistTransition: async (_prev: WorkflowRun, next: WorkflowRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    onRunTerminal: vi.fn()
  } as unknown as RunDriverDeps;

  await store.setRun(DEFAULT_QUEUE_ID, {
    id: runId,
    taskId: runId,
    featureId: runId,
    startedAt: NOW,
    updatedAt: NOW,
    status: 'running',
    currentPhase: 'compose',
    currentIteration: 0,
    pipeline: {
      id: 'reporting-flow',
      name: 'Reporting Flow',
      phases: [{ id: 'compose', title: 'Compose', runner: 'claude', effort: 'normal' }]
    },
    phasesCompleted: [],
    pendingRetry: false,
    delayedRetryCount: 0,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null,
    envelope: plan
  } as any,
    unfencedCommit('test-fixture')
  );

  await new RunDriver(deps).drive(store.getRun(DEFAULT_QUEUE_ID)!, 'produce the report');
  return store.getRun(DEFAULT_QUEUE_ID)!;
}

/** The reader `extension.ts` supplies, composed with the real resolver. */
function referenceTo(sourceRunId: string, outputName: string) {
  return resolvePriorOutput(
    { outputsFor: (runId) => history.outputsFor(runId) },
    { sourceRunId, outputName }
  );
}

describe('a Run records what it produced, and a later Run can reference it', () => {
  it('records one entry per declared output — the produced one located, the other not', async () => {
    const plan = await freezePlan();

    // The Run does its work: one declared artifact appears, the other does not.
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'out', 'report.md'), '# report\n', 'utf8');

    const run = await completeRun(plan, 'run-produces');

    expect(run.status).toBe('completed');
    expect(run.runOutputs).toEqual([
      { name: 'report', status: 'resolved', reference: 'out/report.md' },
      { name: 'summary', status: 'unresolved' }
    ]);
  });

  it('an output that never appeared does not stop the Run from completing', async () => {
    const plan = await freezePlan();

    const run = await completeRun(plan, 'run-produces-nothing');

    expect(run.status).toBe('completed');
    expect(run.runOutputs?.every((record) => record.status === 'unresolved')).toBe(true);
  });

  it('lets a subsequent Run resolve the recorded output by name', async () => {
    const plan = await freezePlan();
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'out', 'report.md'), '# report\n', 'utf8');
    await completeRun(plan, 'run-produces');

    expect(referenceTo('run-produces', 'report')).toEqual({
      ok: true,
      reference: 'out/report.md'
    });
  });

  it('accepts a prior-output supplemental in a second Run request', async () => {
    // The operator-facing end of it: a later submission naming the first Run's
    // output validates and freezes, rather than being refused as it was before
    // this slice supplied the reader.
    const plan = await freezePlan();
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'out', 'report.md'), '# report\n', 'utf8');
    await completeRun(plan, 'run-produces');

    const second = await validateRunRequest(
      {
        pipelineId: 'reporting-flow',
        inputs: [],
        supplemental: [
          {
            kind: 'prior-output',
            reference: { sourceRunId: 'run-produces', outputName: 'report' }
          }
        ],
        // Its own declared targets, distinct from the first Run's: every
        // declared port needs one, and reusing an occupied location would make
        // this an overwrite-confirmation test instead.
        outputs: [
          { portId: 'report', target: 'out/second-report.md' },
          { portId: 'summary', target: 'out/second-summary.txt' }
        ],
        instructions: 'build on the report'
      },
      {
        pipeline: SOURCE,
        workspaceRoot,
        now: NOW + 1_000,
        localInputs: {
          checkFile: async () => ({ ok: true }) as const,
          checkFolder: async () => ({ ok: true }) as const
        },
        outputProbe: createBoundedOutputProbe(),
        priorOutputs: { outputsFor: (runId) => history.outputsFor(runId) }
      }
    );

    expect(second.ok).toBe(true);
  });

  it('refuses a reference to the output that was recorded unresolved', async () => {
    const plan = await freezePlan();
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'out', 'report.md'), '# report\n', 'utf8');
    await completeRun(plan, 'run-produces');

    expect(referenceTo('run-produces', 'summary')).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  it('refuses a reference to a Run that never ran, distinctly', async () => {
    const plan = await freezePlan();
    await completeRun(plan, 'run-produces-nothing');

    expect(referenceTo('run-never-existed', 'report')).toEqual({
      ok: false,
      code: 'prior-run-not-found'
    });
  });
});
