// Feature 092 (T087 – T089, US4) — per-queue published state.
// Requirements: FR-051 (output and audit lines scoped to the queue and Run that
// produced them), FR-052 (a log tail stays bound to the Run it attached to),
// FR-053 (an inactive queue publishes an empty projection), SC-005.
//
// The attribution key is the **Run id**, not the queue id, and that is
// deliberate. An audit line is written by a Run and carries `runId`; a queue
// owns at most one Run at a time (`PER_QUEUE_CAPACITY = 1`). So "which queue
// does this line belong to" is answered by one join — `entry.runId ===
// runtime.inFlightRun.runId` — and there is no second copy of the tail to keep
// consistent. Stamping a queue id onto every audit line would be that second
// copy, and it would be wrong the moment a Run outlives the queue binding the
// operator is looking at.
//
// Feature 093 (T051) closed the one gap these tests originally recorded as out
// of reach. `KEYS.run` held a single record, so a second queue reaching
// in-flight overwrote the first Run's record even though its per-queue
// `inFlightId` was correct, and the assertions below could only pin that the
// overwritten queue published an empty runtime rather than borrowing a
// neighbour's Run. The v10 → v11 migration makes the record a
// `Record<queueId, WorkflowRun>`, so two simultaneously persisted Runs are now
// representable and each `setRun` names the queue it belongs to. The isolation
// property is unchanged and now asserted on the shape that can actually violate
// it: the key **is** the attribution, and the `featureId` scan it replaces is
// gone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { createQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { AuditTailEntry, QueueRuntime, WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { SPECKIT_RUN_PIPELINE } from '../fixtures/speckit-catalog-fixture';

const QUEUE_B = 'b1f2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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
let queue: QueueManager;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-queue-isolation-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), {
      id: QUEUE_B,
      name: 'Queue B',
      now: 1_700_000_000_000
    })
  );
  await store.setGlobalConcurrencyCap(3);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function project(): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? ''
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

function runtimeFor(snapshot: WorkflowSnapshot, queueId: string): QueueRuntime {
  const runtime = snapshot.queues.find((entry) => entry.queueId === queueId);
  if (runtime === undefined) throw new Error(`no runtime published for ${queueId}`);
  return runtime;
}

// Feature 098 (T055) — a Run's phase strip comes from the Pipeline frozen onto
// it and from nowhere else now; the projector used to supply a built-in list to
// a Run that declared none, which is what gave this fixture a non-empty strip
// for free. The isolation claim needs the owning queue's strip to be non-empty
// while the idle queue's stays empty, so the Pipeline is declared here. The
// override and breakpoint below name `speckit-clarify` and `speckit-implement`,
// which is why it is the Spec Kit fixture.
function sampleRun(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, 'id' | 'featureId'>): WorkflowRun {
  return {
    featureDir: 'specs/001-x',
    status: 'running',
    pipeline: SPECKIT_RUN_PIPELINE,
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

/**
 * The read-side join FR-051 describes: a line belongs to a queue when its
 * `runId` matches that queue's Run. One expression, used by every surface that
 * scopes a feed, so a queue can never show a line no Run of its own wrote.
 */
function linesFor(snapshot: WorkflowSnapshot, queueId: string): readonly AuditTailEntry[] {
  const runId = runtimeFor(snapshot, queueId).inFlightRun?.runId ?? null;
  if (runId === null) return [];
  return snapshot.auditTail.filter((entry) => entry.runId === runId);
}

describe('per-queue snapshot isolation — audit lines (T087, FR-051, SC-005)', () => {
  it('attributes each queue only the lines its own Run wrote', async () => {
    const onDefault = await queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await queue.enqueue('task on B', { queueId: QUEUE_B });
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun({ id: 'run-default', featureId: onDefault.id }));

    const snapshot = project();
    // The tail the host publishes is the workspace feed — it is not partitioned
    // in the payload, because a line with no Run (a state migration, a queue
    // mutation) belongs to no queue and must not be dropped.
    const seeded: readonly AuditTailEntry[] = [
      { id: 'a', timestamp: '2026-08-12T00:00:00.000Z', phase: null, category: 'phase-start', summary: 'default line', runId: 'run-default', scope: 'run' },
      { id: 'b', timestamp: '2026-08-12T00:00:01.000Z', phase: null, category: 'phase-start', summary: 'B line', runId: 'run-b', scope: 'run' }
    ] as unknown as readonly AuditTailEntry[];
    const withTail = { ...snapshot, auditTail: seeded } as WorkflowSnapshot;

    expect(linesFor(withTail, DEFAULT_QUEUE_ID).map((entry) => entry.id)).toEqual(['a']);
    // Queue B holds a pending Task but owns no Run record, so it is attributed
    // nothing — not the other queue's line, and not the orphaned `run-b` line.
    expect(linesFor(withTail, QUEUE_B)).toEqual([]);
  });

  it('never lets one queue read another queue Run as its own', async () => {
    const onDefault = await queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await queue.enqueue('task on B', { queueId: QUEUE_B });
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun({ id: 'run-default', featureId: onDefault.id }));

    const snapshot = project();
    expect(runtimeFor(snapshot, DEFAULT_QUEUE_ID).inFlightRun?.runId).toBe('run-default');
    expect(runtimeFor(snapshot, QUEUE_B).inFlightRun).toBeNull();
  });
});

describe('per-queue snapshot isolation — log tail binding (T088, FR-052)', () => {
  it('keeps a tail bound to the Run it attached to when another queue starts one', async () => {
    const onDefault = await queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    const onB = await queue.enqueue('task on B', { queueId: QUEUE_B });

    await store.setRun(DEFAULT_QUEUE_ID, sampleRun({ id: 'run-default', featureId: onDefault.id }));
    const attached = runtimeFor(project(), DEFAULT_QUEUE_ID).inFlightRun;
    expect(attached?.runId).toBe('run-default');

    // A Run starts in the other queue. The tail an operator had open is
    // addressed by (queueId, runId) — neither of which the new Run changes.
    //
    // Feature 093 (T051) — under v11 that start is a write to *queue B's* key,
    // where before the single record left it no queue to name. The default
    // queue therefore keeps `run-default` instead of losing it, and both
    // assertions get sharper: it is not that the displaced queue publishes
    // nothing, it is that neither queue's binding moved.
    await store.setRun(QUEUE_B, sampleRun({ id: 'run-b', featureId: onB.id }));
    const after = project();
    expect(runtimeFor(after, QUEUE_B).inFlightRun?.runId).toBe('run-b');

    // The default queue's tail does not follow the new Run — a feed pinned to
    // `run-default` still reads `run-default`'s lines and none of `run-b`'s,
    // which is the failure FR-052 exists to prevent.
    expect(runtimeFor(after, DEFAULT_QUEUE_ID).inFlightRun?.runId).toBe('run-default');
    const seeded: readonly AuditTailEntry[] = [
      { id: 'a', timestamp: '2026-08-12T00:00:00.000Z', phase: null, category: 'phase-start', summary: 'default line', runId: 'run-default', scope: 'run' },
      { id: 'b', timestamp: '2026-08-12T00:00:01.000Z', phase: null, category: 'phase-start', summary: 'B line', runId: 'run-b', scope: 'run' }
    ] as unknown as readonly AuditTailEntry[];
    const withTail = { ...after, auditTail: seeded } as WorkflowSnapshot;
    expect(linesFor(withTail, DEFAULT_QUEUE_ID).map((entry) => entry.id)).toEqual(['a']);
    expect(linesFor(withTail, QUEUE_B).map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('per-queue snapshot isolation — inactive queues (T089, FR-053)', () => {
  it('publishes an empty projection rather than inheriting another queue Run', async () => {
    const onDefault = await queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun({ id: 'run-default', featureId: onDefault.id }));

    const idle = runtimeFor(project(), QUEUE_B);
    expect(idle.inFlightRun).toBeNull();
    expect(idle.phases).toEqual([]);
    expect(idle.phaseOverrides).toEqual([]);
    expect(idle.manualPause).toBeNull();
    expect(idle.phaseBreakpoints).toEqual([]);
    expect(idle.pendingCount).toBe(0);
  });

  it('still publishes a runtime for a queue with no Task at all', () => {
    const idle = runtimeFor(project(), QUEUE_B);
    expect(idle.queueId).toBe(QUEUE_B);
    expect(idle.name).toBe('Queue B');
    expect(idle.inFlightRun).toBeNull();
  });

  it('does not borrow the other queue phase projection', async () => {
    const onDefault = await queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await store.setRun(DEFAULT_QUEUE_ID, 
      sampleRun({
        id: 'run-default',
        featureId: onDefault.id,
        phaseOverrides: [
          {
            phaseId: 'speckit-clarify',
            action: 'skipped',
            setAt: 1_700_000_000_000,
            actor: 'operator'
          }
        ],
        phaseBreakpoints: [{ phaseId: 'speckit-implement', setAt: 1_700_000_002_000, actor: 'operator' }]
      })
    );

    const snapshot = project();
    expect(runtimeFor(snapshot, DEFAULT_QUEUE_ID).phases.length).toBeGreaterThan(0);
    expect(runtimeFor(snapshot, DEFAULT_QUEUE_ID).phaseOverrides).toHaveLength(1);
    expect(runtimeFor(snapshot, DEFAULT_QUEUE_ID).phaseBreakpoints).toHaveLength(1);
    expect(runtimeFor(snapshot, QUEUE_B).phases).toEqual([]);
    expect(runtimeFor(snapshot, QUEUE_B).phaseOverrides).toEqual([]);
    expect(runtimeFor(snapshot, QUEUE_B).phaseBreakpoints).toEqual([]);
  });
});
