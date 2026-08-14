// Feature 093 (T051, US1, FR-030) — each queue's Run is separately visible in
// the workspace snapshot.
//
// Every assertion here fails against the pre-T051 composer, which took one
// `WorkflowRun` and offered it to whichever queue held a Task with a matching
// `featureId`. With one Run per queue that shape has three distinct defects:
// the second queue's Run is invisible (the projector collapsed the record with
// `Object.values(...)[0]`), the timings of both Runs interleave into one
// bookkeeper, and every queue's rows inherit the single Run's phase.
//
// Driven through a real `StateProjector` and a real `WorkspaceStateStore`, so
// what is asserted is the snapshot the webview receives rather than a
// hand-built projection object.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { PhaseResult, WorkflowRun } from '../../../../src/state/workflow-run';
import type { Phase } from '../../../../src/controller/phase';
import type { FeatureRequest } from '../../../../src/queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';
import { runOf, runtimeOf, statusOf } from './queue-runtime-read.helpers';

/** A second registry entry needs a real v4 id — `isValidQueueId` enforces it. */
const QUEUE_B = '11111111-1111-4111-8111-111111111111';

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

let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-per-queue-projection-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
  await store.setQueueRegistry({
    entries: [
      ...store.getQueueRegistry().entries,
      {
        id: QUEUE_B,
        name: 'Second queue',
        position: 1,
        state: 'active',
        pauseSource: null,
        schedule: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000
      }
    ],
    updatedAt: 1_700_000_000_000
  });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function inFlightRequest(id: string, runId: string, queueId: string): FeatureRequest {
  return {
    id,
    description: `task ${id}`,
    enqueuedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    status: 'in-flight',
    position: 0,
    runId,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    queueId
  };
}

function runFor(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, 'id' | 'featureId'>): WorkflowRun {
  return {
    featureDir: `specs/${overrides.featureId}`,
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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
    ...overrides
  };
}

/** A completed phase, in the shape the phase strip reads it from. */
function completed(phase: Phase): PhaseResult {
  return {
    phase,
    iteration: 0,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    result: 'clean',
    terminationReason: 'token',
    exitCode: 0,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

/** Give a queue a Run plus the in-flight Task row that Run is executing. */
async function seedRun(
  queueId: string,
  run: WorkflowRun
): Promise<void> {
  const current = store.getQueue(queueId);
  await store.setQueue(
    {
      ...current,
      requests: [...current.requests, inFlightRequest(run.featureId, run.id, queueId)],
      inFlightId: run.featureId,
      queueLifecycle: 'running'
    },
    queueId
  );
  await store.setRun(queueId, run);
}

function project(): StateProjector {
  const projector = new StateProjector({ store, audit, ownerId: 'this-window' });
  projector.start();
  return projector;
}

describe('per-queue Run projection (T051)', () => {
  it('publishes each queue its own Run', async () => {
    await seedRun(DEFAULT_QUEUE_ID, runFor({ id: 'run-a', featureId: 'feat-a' }));
    await seedRun(QUEUE_B, runFor({
      id: 'run-b',
      featureId: 'feat-b',
      currentPhase: 'speckit-implement'
    }));

    const projector = project();
    const snap = projector.getCurrentSnapshot();

    expect(runOf(snap, DEFAULT_QUEUE_ID)?.runId).toBe('run-a');
    expect(runOf(snap, QUEUE_B)?.runId).toBe('run-b');
    expect(runOf(snap, DEFAULT_QUEUE_ID)?.feature?.id).toBe('feat-a');
    expect(runOf(snap, QUEUE_B)?.feature?.id).toBe('feat-b');
    projector.dispose();
  });

  it('gives each queue the phase strip of its own Run', async () => {
    await seedRun(DEFAULT_QUEUE_ID, runFor({
      id: 'run-a',
      featureId: 'feat-a',
      currentPhase: 'speckit-plan',
      phasesCompleted: [completed('speckit-specify')]
    }));
    await seedRun(QUEUE_B, runFor({
      id: 'run-b',
      featureId: 'feat-b',
      currentPhase: 'speckit-implement',
      phasesCompleted: [
        completed('speckit-specify'),
        completed('speckit-plan'),
        completed('speckit-tasks')
      ]
    }));

    const projector = project();
    const snap = projector.getCurrentSnapshot();

    const activeOf = (queueId: string): string | undefined =>
      runtimeOf(snap, queueId).phases.find((phase) => phase.state === 'active')?.name;
    expect(activeOf(DEFAULT_QUEUE_ID)).toBe('speckit-plan');
    expect(activeOf(QUEUE_B)).toBe('speckit-implement');
    projector.dispose();
  });

  it('does not leak one queue\'s Run phase onto another queue\'s in-flight row', async () => {
    // The pre-T051 defect in its narrowest form: `rowsOf(queueId)` substituted
    // the queue's own `inFlightId` into one shared row context but inherited
    // that context's `inFlightPhase`, so queue B's in-flight row displayed
    // queue A's Run phase.
    await seedRun(DEFAULT_QUEUE_ID, runFor({
      id: 'run-a',
      featureId: 'feat-a',
      currentPhase: 'speckit-plan'
    }));
    await seedRun(QUEUE_B, runFor({
      id: 'run-b',
      featureId: 'feat-b',
      currentPhase: 'speckit-implement'
    }));

    const projector = project();
    const snap = projector.getCurrentSnapshot();

    const rowPhaseOf = (queueId: string, taskId: string): string | null =>
      runtimeOf(snap, queueId).tasks.find((task) => task.id === taskId)?.currentPhase ?? null;
    expect(rowPhaseOf(DEFAULT_QUEUE_ID, 'feat-a')).toBe('speckit-plan');
    expect(rowPhaseOf(QUEUE_B, 'feat-b')).toBe('speckit-implement');
    projector.dispose();
  });

  it('publishes the empty projection for a queue that owns no Run', async () => {
    await seedRun(QUEUE_B, runFor({ id: 'run-b', featureId: 'feat-b' }));

    const projector = project();
    const snap = projector.getCurrentSnapshot();

    // FR-053 — absent together, never a borrowed neighbour's reading.
    expect(runOf(snap, DEFAULT_QUEUE_ID)).toBeNull();
    expect(statusOf(snap, DEFAULT_QUEUE_ID)).toBe('idle');
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).phases).toEqual([]);
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).manualPause).toBeNull();
    expect(runOf(snap, QUEUE_B)?.runId).toBe('run-b');
    projector.dispose();
  });

  it('keeps per-Run pause state on the queue that owns it', async () => {
    await seedRun(DEFAULT_QUEUE_ID, runFor({
      id: 'run-a',
      featureId: 'feat-a',
      status: 'paused',
      manualPauseAt: 1_700_000_000_500,
      manualPauseCause: 'operator-paused'
    }));
    await seedRun(QUEUE_B, runFor({ id: 'run-b', featureId: 'feat-b' }));

    const projector = project();
    const snap = projector.getCurrentSnapshot();

    expect(statusOf(snap, DEFAULT_QUEUE_ID)).toBe('paused');
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).manualPause).toEqual({
      at: new Date(1_700_000_000_500).toISOString(),
      cause: 'operator-paused'
    });
    expect(statusOf(snap, QUEUE_B)).toBe('running');
    expect(runtimeOf(snap, QUEUE_B).manualPause).toBeNull();
    projector.dispose();
  });

  it('measures each Run\'s elapsed time on its own clock', async () => {
    // One bookkeeper per window accumulated both Runs' timings into one set of
    // counters and reset them whenever the observed run id changed, so the
    // second Run to be projected reported the first's elapsed time.
    let monotonic = 0;
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      monotonicNow: () => monotonic
    });
    await seedRun(DEFAULT_QUEUE_ID, runFor({ id: 'run-a', featureId: 'feat-a' }));
    projector.start();

    monotonic = 5_000;
    await seedRun(QUEUE_B, runFor({ id: 'run-b', featureId: 'feat-b' }));
    projector.project();

    monotonic = 9_000;
    const snap = projector.project();

    expect(runOf(snap, DEFAULT_QUEUE_ID)?.elapsedMs).toBe(9_000);
    expect(runOf(snap, QUEUE_B)?.elapsedMs).toBe(4_000);
    projector.dispose();
  });
});
