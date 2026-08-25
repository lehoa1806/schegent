// Feature 028 — Snapshot projection of `WorkflowRun.phaseBreakpoints`.
//
// Verifies the `StateProjector` translates `run.phaseBreakpoints` into the
// owning queue's `phaseBreakpoints` correctly:
//   - Default empty list when run has no breakpoints.
//   - Entries projected with phaseId + ISO `setAt` + actor.
//   - Entries sorted ascending by `setAt` (regardless of insertion order).
//   - `resumeTargetPhaseId` projected verbatim.
//   - Output is frozen (immutable contract for downstream consumers).
//
// Feature 092 (T096) — the projection target moved from the snapshot root to
// `queues[<owner>]`, and ownership is by Task row: a queue owns the Run whose
// `featureId` names one of its own requests. So each test now enqueues the Task
// the Run is for; without it no queue owns the Run and every queue would
// correctly publish the empty projection, which would make the assertions below
// pass for the wrong reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { QueueManager } from '../../../../src/queue/queue-manager';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import { runOf, runtimeOf } from './queue-runtime-read.helpers';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';

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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-projector-bp-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeProjector(): StateProjector {
  return new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    debounceMs: 100
  });
}

/**
 * Persist a Run the default queue owns: enqueue its Task first, then set the
 * Run's `featureId` to that Task's id. The two halves are what
 * `composeQueueRuntimes` joins on, so a test that sets only the Run is asserting
 * against an unowned Run.
 */
async function seedOwnedRun(overrides: Partial<WorkflowRun> = {}): Promise<void> {
  const task = await queue.enqueue('breakpoint projection task');
  await store.setRun(DEFAULT_QUEUE_ID, sampleRun({ featureId: task.id, ...overrides }), unfencedCommit('test-fixture'));
}

function sampleRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-bp-1',
    featureId: 'feat-bp-1',
    featureDir: 'specs/001-x',
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

describe('StateProjector — phaseBreakpoints projection (Feature 028)', () => {
  it('projects an empty breakpoints array when the run has none', async () => {
    await seedOwnedRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phaseBreakpoints).toEqual([]);
    expect(runOf(snap)?.resumeTargetPhaseId ?? null).toBeNull();
    p.dispose();
  });

  it('projects an empty list for idle workflows (no run)', () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    // The default queue is still published — it exists in the registry — it just
    // owns no Run, so both readings are empty together (FR-053).
    expect(runtimeOf(snap).phaseBreakpoints).toEqual([]);
    expect(runOf(snap)).toBeNull();
    p.dispose();
  });

  it('projects each breakpoint with phaseId, ISO setAt, and actor', async () => {
    await seedOwnedRun({
      phaseBreakpoints: [
        { phaseId: 'speckit-implement', setAt: 1_700_000_000_500, actor: 'operator' }
      ]
    });
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phaseBreakpoints).toHaveLength(1);
    expect(runtimeOf(snap).phaseBreakpoints[0]).toEqual({
      phaseId: 'speckit-implement',
      setAt: new Date(1_700_000_000_500).toISOString(),
      actor: 'operator'
    });
    p.dispose();
  });

  it('sorts breakpoints ascending by setAt regardless of insertion order', async () => {
    await seedOwnedRun({
      phaseBreakpoints: [
        { phaseId: 'speckit-tasks', setAt: 1_700_000_000_300, actor: 'operator' },
        { phaseId: 'speckit-implement', setAt: 1_700_000_000_100, actor: 'operator' },
        { phaseId: 'finalize', setAt: 1_700_000_000_200, actor: 'operator' }
      ]
    });
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phaseBreakpoints.map((bp) => bp.phaseId)).toEqual([
      'speckit-implement',
      'finalize',
      'speckit-tasks'
    ]);
    p.dispose();
  });

  it('projects resumeTargetPhaseId verbatim when set', async () => {
    await seedOwnedRun({
      manualPauseAt: 1_700_000_000_500,
      manualPauseCause: 'breakpoint-paused',
      resumeTargetPhaseId: 'speckit-implement',
      phaseBreakpoints: []
    });
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runOf(snap)?.resumeTargetPhaseId).toBe('speckit-implement');
    expect(runtimeOf(snap).manualPause?.cause).toBe('breakpoint-paused');
    p.dispose();
  });

  it('phaseBreakpoints output is frozen (downstream cannot mutate)', async () => {
    await seedOwnedRun({
      phaseBreakpoints: [
        { phaseId: 'speckit-implement', setAt: 1_700_000_000_500, actor: 'operator' }
      ]
    });
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(Object.isFrozen(runtimeOf(snap).phaseBreakpoints)).toBe(true);
    expect(Object.isFrozen(runtimeOf(snap).phaseBreakpoints[0])).toBe(true);
    p.dispose();
  });
});
