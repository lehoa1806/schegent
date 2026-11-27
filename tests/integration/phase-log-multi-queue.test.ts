// Feature 020 BUG-002 (T072) — the phase-log read resolves a Task on the queue
// the selection names.
//
// The service used to validate every selection against the default queue's
// projection (`snapshot.queue`), so a Task on any other queue was unknown while
// it ran and after it finished, and the operator saw "Could not load logs:
// unknown-tuple". History matched on the run id alone, so an entry filed under
// one queue also answered for every other queue.
//
// Everything here is real except the memento: a two-queue store, the queue
// manager that moves Tasks through it, the history store, the projector the
// router reads, and the production service. A hand-built snapshot would only
// prove the service agrees with the test's idea of the snapshot.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { PhaseDef, PipelineDef } from '../../src/config/pipeline-config';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { ReadPhaseLogRequest } from '../../src/contracts/sidebar-ipc';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { createQueue } from '../../src/queue/queue-registry';
import { resolveStreamJsonlPath } from '../../src/services/phase-log/phase-log-path';
import { createPhaseLogService } from '../../src/services/phase-log/phase-log-service';
import { HistoryStore } from '../../src/state/history-store';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import {
  SPECKIT_PHASE_DEFS,
  SPECKIT_PIPELINE_DEFS,
  SPECKIT_PIPELINE_ID,
  SPECKIT_RUN_PIPELINE
} from '../fixtures/speckit-catalog-fixture';

const QUEUE_B = 'b1f2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PHASE_ID = 'speckit-plan';
const RUN_B = 'run-multi-queue-b';
const RUN_DEFAULT = 'run-multi-queue-default';
const RUN_HISTORY_B = 'run-multi-queue-history-b';
const UNKNOWN_TUPLE = { outcome: 'failure', reason: 'unknown-tuple' } as const;

// T074 — a Pipeline and Phase the catalog lists, the Phase on agy. The Run
// BUG-002 records was an agy Run of a workspace Pipeline, and once a Run is no
// longer in flight the catalog check decides its read.
const AGY_PHASE: PhaseDef = {
  id: 'agy-fixture-phase',
  name: 'agy fixture Phase',
  version: 1,
  instruction: '/speckit-implement',
  runner: 'agy'
};
const AGY_PIPELINE: PipelineDef = {
  id: 'agy-fixture-pipeline',
  name: 'agy fixture Pipeline',
  version: 1,
  phases: [AGY_PHASE.id]
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

let store: WorkspaceStateStore;
let queue: QueueManager;
let history: HistoryStore;
let audit: AuditLogWriter;
let workspaceRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  history = new HistoryStore(store);
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-multi-queue-'));
  audit = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger());
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), { id: QUEUE_B, name: 'Queue B', now: 1_700_000_000_000 })
  );
  await store.setGlobalConcurrencyCap(3);
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** The snapshot the router hands the service, projected fresh from the store. */
function project(): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    audit,
    history,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? '',
    getCatalog: () => ({
      phases: [...SPECKIT_PHASE_DEFS, AGY_PHASE],
      pipelines: [...SPECKIT_PIPELINE_DEFS, AGY_PIPELINE],
      models: { claude: [], codex: [], agy: [] }
    })
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

function sampleRun(overrides: Pick<WorkflowRun, 'id' | 'featureId'>): WorkflowRun {
  return {
    featureDir: 'specs/001-x',
    status: 'running',
    pipeline: SPECKIT_RUN_PIPELINE,
    currentPhase: PHASE_ID,
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

/** Enqueues a Task on `queueId`, gives that queue a Run for it, and marks it in flight. */
async function startTask(queueId: string, runId: string): Promise<string> {
  const task = await queue.enqueue(`task for ${runId}`, { queueId });
  await store.setRun(queueId, sampleRun({ id: runId, featureId: task.id }), unfencedCommit('test-fixture'));
  await queue.markInFlight(task.id, runId);
  return task.id;
}

/** One iteration's log, at the path the production resolver composes. */
async function writeStream(
  runId: string,
  pipelineId: string = SPECKIT_PIPELINE_ID,
  phaseId: string = PHASE_ID
): Promise<void> {
  const streamPath = resolveStreamJsonlPath({ workspaceRoot, runId, pipelineId, phaseId, iterationN: 1 });
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
  const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
  await fs.writeFile(streamPath, `${JSON.stringify(line)}\n`, 'utf8');
}

function request(
  queueId: string,
  taskId: string,
  pipelineId: string = SPECKIT_PIPELINE_ID,
  phaseId: string = PHASE_ID
): ReadPhaseLogRequest {
  return { selection: { queueId, taskId, pipelineId, phaseId, iterationN: null } };
}

function buildService() {
  const resolveRunId = vi.fn((taskId: string) => queue.findById(taskId)?.runId ?? null);
  const service = createPhaseLogService({
    workspaceRoot,
    sanitize: (value) => value,
    readVerboseSetting: () => true,
    getSnapshot: project,
    resolveRunId
  });
  return { service, resolveRunId };
}

describe('phase-log read on a queue other than the default (BUG-002, T072)', () => {
  it("reads queue B's Task while it is in flight and after it completes", async () => {
    const taskB = await startTask(QUEUE_B, RUN_B);
    await writeStream(RUN_B);
    const { service } = buildService();

    // The premise: the default queue's projection does not show this Task, so
    // a read that consults only it cannot find the Task.
    expect(project().queue.inFlight).toBeNull();

    const live = await service.read(request(QUEUE_B, taskB));
    expect(live).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: true } });

    await queue.finish(taskB, 'completed');
    const after = await service.read(request(QUEUE_B, taskB));
    expect(after).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: false } });
  });

  it('matches a history entry only under the queue it was filed under', async () => {
    await history.append(QUEUE_B, {
      runId: RUN_HISTORY_B,
      featureId: 'feature-history-b',
      descriptionPreview: 'history on B',
      terminalStatus: 'completed',
      startedAt: new Date(1_700_000_000_000).toISOString(),
      completedAt: new Date(1_700_000_000_500).toISOString(),
      durationMs: 500,
      lastErrorSummary: null,
      auditLogPointer: `runId:${RUN_HISTORY_B}`,
      pipelineId: SPECKIT_PIPELINE_ID
    });
    await writeStream(RUN_HISTORY_B);
    const { service } = buildService();

    const own = await service.read(request(QUEUE_B, RUN_HISTORY_B));
    expect(own).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: false } });

    const elsewhere = await service.read(request(DEFAULT_QUEUE_ID, RUN_HISTORY_B));
    expect(elsewhere).toEqual(UNKNOWN_TUPLE);
  });

  it('refuses a Task sent under a queue that does not own it, before any path is resolved', async () => {
    const taskDefault = await startTask(DEFAULT_QUEUE_ID, RUN_DEFAULT);
    const pendingB = await queue.enqueue('pending on B', { queueId: QUEUE_B });
    await writeStream(RUN_DEFAULT);
    const { service, resolveRunId } = buildService();

    // The control: the same Task under its own queue reads, so the refusals
    // below are about the queue named, not about the Task or its log.
    const own = await service.read(request(DEFAULT_QUEUE_ID, taskDefault));
    expect(own).toMatchObject({ outcome: 'success', manifest: { isInFlight: true } });
    resolveRunId.mockClear();

    expect(await service.read(request(QUEUE_B, taskDefault))).toEqual(UNKNOWN_TUPLE);
    expect(await service.read(request(DEFAULT_QUEUE_ID, pendingB.id))).toEqual(UNKNOWN_TUPLE);
    expect(resolveRunId).not.toHaveBeenCalled();
  });

  it('passes the catalog check for a finished agy Run on B whose Pipeline and Phase the catalog lists', async () => {
    const taskB = await startTask(QUEUE_B, RUN_B);
    await writeStream(RUN_B, AGY_PIPELINE.id, AGY_PHASE.id);
    await queue.finish(taskB, 'completed');
    const { service } = buildService();

    const listed = await service.read(request(QUEUE_B, taskB, AGY_PIPELINE.id, AGY_PHASE.id));
    expect(listed).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: false } });

    // The control: the check still decides a Run that is not in flight, so a
    // Pipeline the catalog does not list is refused even with a log on disk.
    await writeStream(RUN_B, 'agy-unlisted-pipeline', AGY_PHASE.id);
    const unlisted = await service.read(request(QUEUE_B, taskB, 'agy-unlisted-pipeline', AGY_PHASE.id));
    expect(unlisted).toEqual(UNKNOWN_TUPLE);
  });
});

// Feature 265 BUG-001 (FR-012, SC-006, T016) — a settled Workflow leaf reads its own log.
//
// A Workflow dispatches each Phase attempt as a Task whose `pipelineId` is the Phase's own id, so
// the tuple that names its log is (Phase, Phase). The catalog lists that id as a Phase and never as
// a Pipeline, so once the Task left flight the catalog check refused the only tuple it has.
describe('phase-log read of a settled Workflow leaf Task (Feature 265 BUG-001, T016)', () => {
  const LEAF_PHASE = 'speckit-tasks';
  const RUN_LEAF = 'run-leaf-b';

  async function startLeafTask(queueId: string, runId: string): Promise<string> {
    const task = await queue.enqueue(`leaf for ${runId}`, { queueId, pipelineId: LEAF_PHASE });
    await store.setRun(queueId, sampleRun({ id: runId, featureId: task.id }), unfencedCommit('test-fixture'));
    await queue.markInFlight(task.id, runId);
    return task.id;
  }

  it('the projected snapshot carries the leaf Phase as the Task’s currentPipelineId', async () => {
    const leaf = await startLeafTask(QUEUE_B, RUN_LEAF);
    const rows = project().queues.find((runtime) => runtime.queueId === QUEUE_B)?.tasks ?? [];
    expect(rows.find((row) => row.id === leaf)?.currentPipelineId).toBe(LEAF_PHASE);
  });

  it.each(['completed', 'failed'] as const)('reads a %s leaf Task’s own (Phase, Phase) tuple', async (outcome) => {
    const leaf = await startLeafTask(QUEUE_B, RUN_LEAF);
    await writeStream(RUN_LEAF, LEAF_PHASE, LEAF_PHASE);
    await queue.finish(leaf, outcome);
    const { service } = buildService();

    const own = await service.read(request(QUEUE_B, leaf, LEAF_PHASE, LEAF_PHASE));
    expect(own).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: false } });
  });

  it('still refuses other tuples for a settled leaf Task, and its tuple for another Task', async () => {
    const leaf = await startLeafTask(QUEUE_B, RUN_LEAF);
    await writeStream(RUN_LEAF, LEAF_PHASE, LEAF_PHASE);
    await queue.finish(leaf, 'completed');
    const other = await queue.enqueue('pending Pipeline Task on B', { queueId: QUEUE_B });
    const { service } = buildService();

    // Its own Phase under a Pipeline the catalog does not list, and another Phase under its own id.
    expect(await service.read(request(QUEUE_B, leaf, 'unlisted-pipeline', LEAF_PHASE))).toEqual(UNKNOWN_TUPLE);
    expect(await service.read(request(QUEUE_B, leaf, LEAF_PHASE, 'speckit-plan'))).toEqual(UNKNOWN_TUPLE);
    // The same tuple for a Task whose own Phase it is not.
    expect(await service.read(request(QUEUE_B, other.id, LEAF_PHASE, LEAF_PHASE))).toEqual(UNKNOWN_TUPLE);
  });

  it('still accepts any tuple for the in-flight Task', async () => {
    const leaf = await startLeafTask(QUEUE_B, RUN_LEAF);
    await writeStream(RUN_LEAF, 'unlisted-pipeline', 'unlisted-phase');
    const { service } = buildService();

    const live = await service.read(request(QUEUE_B, leaf, 'unlisted-pipeline', 'unlisted-phase'));
    expect(live).toMatchObject({ outcome: 'success', manifest: { iterations: [1], isInFlight: true } });
  });
});
