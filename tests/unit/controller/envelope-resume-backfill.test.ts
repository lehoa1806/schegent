// FR-R3-001 / CTO-003 — a composed Run stays composed across a reload.
//
// The envelope is read by `resolveRunOutputs` and by the prompt seam, and by
// nothing else. That is the whole point, and it has one consequence worth
// testing: a Run created *before* the envelope field existed carries none, so
// those two readers find nothing and the operator's declared targets are
// probed not at all. The Run completes and records no outputs — the silent
// semantic loss this feature exists to remove, reintroduced for exactly the
// population that upgrades mid-run.
//
// `resumeExistingOnQueue` is where that is repaired, because it is the one
// place a persisted Run re-enters execution and it already holds the queue row
// (it resolved `feature` to check the task still exists). The row's `runPlan`
// is not a second source: it is the same envelope `validateRunRequest()` froze
// for this Run, and nothing under `src/` writes `runPlan` after enqueue, so it
// cannot have drifted. The backfill is guarded on the field's absence, which is
// what keeps it from becoming a general "re-read the row" path — a Run created
// after this feature never reaches the right-hand side of the `??`.
//
// The three cases below are the three shapes a resumed Run can have, and they
// are tested together because the risk is not any one of them in isolation: it
// is a backfill that fires when it should not (overwriting an in-flight
// envelope from a row) or that adds a key to a Run that never had one
// (changing the legacy serialized shape T267 pins).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import type { PhaseDef, PipelineDef } from '../../../src/config/pipeline-config';
import type { FrozenRunPlan } from '../../../src/contracts/run-request';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';

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

const COMPOSE: PhaseDef = {
  id: 'compose', name: 'Compose', version: 1, instruction: 'Write the report.',
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
};
const FLOW: PipelineDef = {
  id: 'envelope-flow', name: 'Envelope Flow', phases: ['compose']
};

/** What `validateRunRequest()` produces, reduced to what this seam reads. */
function planFor(target: string): FrozenRunPlan {
  return {
    pipeline: snapshotPipelineContract(
      FLOW,
      [COMPOSE, DONE].map((phase) => snapshotPhaseDef(phase, 'claude'))
    ),
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [],
    outputs: [{ portId: 'report', type: 'markdown', target, overwriteConfirmed: false }],
    frozenAt: 1
  };
}

function makeController(memento: FakeMemento): {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
} {
  const store = new WorkspaceStateStore(memento);
  const queue = new QueueManager(store);
  const controller = new SchegentWorkflowController(
    { run: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    new SanitizedLogger(),
    {
      release: vi.fn(async () => {}), tryAcquire: vi.fn(), heartbeat: vi.fn(),
      isHeld: vi.fn(), ownerOfRecord: vi.fn(), id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 }
  );
  return { controller, store, queue };
}

/**
 * Persist a paused Run for a queued task, then resume it and return the Run as
 * it was written back. `admitResume` persists before it hands the drive back,
 * so the assertion does not have to wait for — or succeed at — the drive
 * itself; the mocked `PhaseRunner` makes that attempt inert either way.
 */
async function resumeWith(options: {
  readonly rowPlan?: FrozenRunPlan;
  readonly runEnvelope?: FrozenRunPlan;
}): Promise<WorkflowRun> {
  const { controller, store, queue } = makeController(new FakeMemento());
  await store.initialize();

  const task = await queue.enqueue('a composed run', {
    pipelineId: FLOW.id,
    ...(options.rowPlan ? { runPlan: options.rowPlan } : {})
  });

  const persisted: WorkflowRun = {
    id: 'run-1', featureId: task.id, featureDir: '',
    status: 'paused', currentPhase: 'compose', currentIteration: 1,
    startedAt: 1, lastTransitionAt: 1, phasesCompleted: [], lastError: null,
    pipeline: (options.runEnvelope ?? options.rowPlan ?? planFor('out/x.md')).pipeline,
    delayedRetryCount: 0, pendingRetryAt: null, pendingRetryCause: null,
    phaseOverrides: [], manualPauseAt: null, manualPauseCause: null,
    phaseBreakpoints: [], resumeTargetPhaseId: null,
    ...(options.runEnvelope ? { envelope: options.runEnvelope } : {})
  };
  await store.setRun(DEFAULT_QUEUE_ID, persisted);

  const admission = await controller.admitResume(DEFAULT_QUEUE_ID);
  // The drive is handed back rather than awaited by design; swallow it so a
  // mocked runner's failure is not an unhandled rejection in this suite.
  void admission.completed.catch(() => undefined);

  const resumed = store.getRun(DEFAULT_QUEUE_ID);
  expect(resumed, 'the resume seam must have written a Run back').not.toBeNull();
  return resumed as WorkflowRun;
}

let backfilled: WorkflowRun;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a pre-envelope composed Run is repaired on resume (FR-R3-001)', () => {
  beforeEach(async () => {
    backfilled = await resumeWith({ rowPlan: planFor('out/report.md') });
  });

  it('attaches the envelope the task was submitted with', () => {
    expect(backfilled.envelope).toBeDefined();
    expect(backfilled.envelope?.frozenAt).toBe(1);
  });

  it('carries the declared output targets, which is what was being lost', () => {
    // Without the backfill this array is unreachable and `resolveRunOutputs`
    // records nothing at all — not "unresolved", nothing.
    expect(backfilled.envelope?.outputs.map((output) => output.target)).toEqual([
      'out/report.md'
    ]);
  });

  it('carries the bound inputs, so the prompt seam has them too', () => {
    expect(backfilled.envelope?.inputs.map((input) => input.portId)).toEqual(['brief']);
  });

  it('does not copy the envelope into a second field while repairing it', () => {
    // `runInputs` is a legacy projection nothing under `src/` reads. Writing it
    // here would be the copy-a-field-out-of-the-envelope move the whole feature
    // bans, performed by the code that exists to enforce the ban.
    expect('runInputs' in backfilled).toBe(false);
  });
});

describe('the backfill fires only where the envelope is missing (FR-R3-001)', () => {
  it('never overwrites an in-flight envelope from the queue row', async () => {
    // The in-flight envelope wins even though the row disagrees. If this ever
    // inverts, an operator who edited the row would silently retarget a Run
    // already executing — the exact defect the frozen-plan rule forbids, and
    // the one `immutable-in-flight.test.ts` covers from the other side.
    const resumed = await resumeWith({
      rowPlan: planFor('out/from-the-row.md'),
      runEnvelope: planFor('out/from-the-run.md')
    });

    expect(resumed.envelope?.outputs.map((output) => output.target)).toEqual([
      'out/from-the-run.md'
    ]);
  });

  it('adds no envelope key to a Run that never had a plan on either side', async () => {
    // The legacy drain path: no `runPlan` on the row, no `envelope` on the Run.
    // `'envelope' in run` rather than `toBeUndefined()`, because an explicit
    // `envelope: undefined` still changes what the record serializes to.
    const resumed = await resumeWith({});

    expect('envelope' in resumed).toBe(false);
  });
});
