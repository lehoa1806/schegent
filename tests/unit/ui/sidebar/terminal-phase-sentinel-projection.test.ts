// Bug "the phase log that asked for a phase named done" (2026-09-02) — the
// terminal sentinel must not leave the host as a Task row's `currentPhase`.
//
// `'done'` is a terminal *state* of the phase state machine, not a Phase
// definition — `src/controller/phase.ts` says so at its own declaration, and
// nothing imports it as a catalog entry. `availablePhases` therefore never
// lists it, and `phase-projector.ts` gives it no position in a phase strip.
//
// `src/ui/sidebar/snapshot-composer.ts` already knew this for the in-flight
// reading, in `rowContextFor`:
//
//   inFlightPhase:  run && run.currentPhase !== 'done' ? run.currentPhase : null
//   activeRunPhase: run?.currentPhase ?? null            // <- six lines below
//
// Both lines now carry the same filter. That file sits exactly at its
// `source-loc-budget` ceiling, which is why the reasoning lives here and in
// `docs/features/bugs/` rather than beside the expression.
//
// `queue-projector.ts` routes a Task row that is NOT in flight but IS the
// active Run's own row through the second one, so a Run that has finished
// projected `currentPhase: 'done'` onto its completed row. The Activity Feed
// reads exactly that field to build a phase-log tuple, and the host then
// refuses its own projection with `unknown-tuple`, because `'done'` is not a
// phase anyone can read a log for. Observed in `.schegent/audit.log` on the two
// most recent extension starts, twice each.
//
// Driven through a real `StateProjector` rather than `projectQueue` directly:
// the defect is the pairing of two context fields the composer fills in, and a
// hand-built context would let the test author pick the value under test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { PhaseResult, WorkflowRun } from '../../../../src/state/workflow-run';
import type { Phase } from '../../../../src/controller/phase';
import type { FeatureRequest } from '../../../../src/queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import { runtimeOf } from './queue-runtime-read.helpers';
import { SPECKIT_RUN_PIPELINE } from '../../../fixtures/speckit-catalog-fixture';

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-terminal-phase-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

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

/**
 * A Task row that is no longer in flight. Both cases this file needs take this
 * shape and differ only by `status`: a finished Run's completed row, and the
 * operator-paused row whose pause cleared the queue pointer.
 */
function settledRequest(
  id: string,
  runId: string,
  status: FeatureRequest['status']
): FeatureRequest {
  return {
    id,
    description: `task ${id}`,
    enqueuedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_002_000,
    completedAt: status === 'completed' ? 1_700_000_002_000 : null,
    status,
    position: 0,
    runId,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    queueId: DEFAULT_QUEUE_ID
  };
}

/**
 * A Run that has left `speckit-plan`, in one of two ways. `'done'` is what
 * `nextSuccessor` writes past the last phase, and the record keeps it — the Run
 * projection is `null` only when the queue owns no Run at all, so a Run that
 * finished still projects and still names itself the queue's active Run.
 */
function runAt(currentPhase: Phase, status: WorkflowRun['status']): WorkflowRun {
  return {
    id: 'run-settled',
    featureId: 'feat-settled',
    featureDir: 'specs/feat-settled',
    status,
    pipeline: SPECKIT_RUN_PIPELINE,
    currentPhase,
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_002_000,
    phasesCompleted: [completed('speckit-specify'), completed('speckit-plan')],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

/**
 * Seed a queue whose Task row is settled — not in flight — while its Run record
 * remains the queue's active Run. That pairing is the only way to reach the
 * `isActiveRun` branch of `queue-projector.ts`, which is where the sentinel
 * leaks; an in-flight row takes the branch beside it, which already filters.
 */
async function seedSettledRun(run: WorkflowRun, rowStatus: FeatureRequest['status']): Promise<void> {
  const current = store.getQueue(DEFAULT_QUEUE_ID);
  await store.setQueue(
    {
      ...current,
      requests: [...current.requests, settledRequest(run.featureId, run.id, rowStatus)],
      // Both a finished Run and an operator pause release the pointer; the row
      // stays behind either way.
      inFlightId: null,
      queueLifecycle: rowStatus === 'completed' ? 'active-empty' : 'operator-paused',
      paused: rowStatus === 'paused'
    },
    DEFAULT_QUEUE_ID
  );
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
}

function rowPhase(projector: StateProjector): string | null | undefined {
  return runtimeOf(projector.getCurrentSnapshot(), DEFAULT_QUEUE_ID).tasks.find(
    (task) => task.id === 'feat-settled'
  )?.currentPhase;
}

function project(): StateProjector {
  const projector = new StateProjector({ store, audit, ownerId: 'this-window' });
  projector.start();
  return projector;
}

describe('terminal phase sentinel — a settled Run\'s row', () => {
  it('does not project `done` as the row\'s currentPhase', async () => {
    await seedSettledRun(runAt('done', 'completed'), 'completed');
    const projector = project();

    expect(rowPhase(projector)).toBeNull();
    projector.dispose();
  });

  it('still projects a real phase for a paused row (2697bb3b is not undone)', async () => {
    // The positive control, and the reason the fix is a filter rather than a
    // `null`. Commit 2697bb3b (2026-07-31) added the `isActiveRun` branch so a
    // paused or failed Task row would keep showing the phase it stopped on;
    // that row reaches the same branch as the finished one above. Removing the
    // branch would fix the sentinel and re-break this.
    await seedSettledRun(runAt('speckit-plan', 'paused'), 'paused');
    const projector = project();

    expect(rowPhase(projector)).toBe('speckit-plan');
    projector.dispose();
  });

  it('never names a phase outside the Run\'s own frozen Pipeline', async () => {
    // The general form, so a sentinel added beside `'done'` fails here too:
    // whatever a row calls its current phase has to be a phase some consumer
    // can look up. The Run's frozen Pipeline is the authority the phase strip
    // and the phase-log tuple are both resolved against.
    await seedSettledRun(runAt('done', 'completed'), 'completed');
    const projector = project();

    const declared = new Set(SPECKIT_RUN_PIPELINE.phases.map((phase) => phase.id));
    for (const task of runtimeOf(projector.getCurrentSnapshot(), DEFAULT_QUEUE_ID).tasks) {
      if (task.currentPhase === null) continue;
      expect(declared).toContain(task.currentPhase);
    }
    projector.dispose();
  });
});
