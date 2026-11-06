// Feature 020 BUG-002 (T073) — the phase-log tail follows the queue the
// selection names, and tears down only the tail of the Run that left.
//
// Three defects shared one cause. The start check read the default queue's
// in-flight row, so a tail on any other queue was refused as `not-in-flight`.
// The task-leave cursor watched the same row, so a Run leaving another queue
// never ended its tail. And the cursor emitted the Task id while the registry
// keys a tail by the Run id it was started with, so even the default queue's
// tail outlived its Run: the two ids never compare equal outside a fixture
// that makes them the same string. The last case below gives them different
// values on purpose.
//
// The snapshots are real projections of a real two-queue store. Only their
// timing is the test's: `publish()` stands in for the projector's debounced
// notification, so a loaded machine cannot reorder what the wiring sees.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPhaseLogTailWiring, type PhaseLogTailWiring } from '../../src/activation/phase-log-tail-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { createQueue } from '../../src/queue/queue-registry';
import { resolveStreamJsonlPath } from '../../src/services/phase-log/phase-log-path';
import { HistoryStore } from '../../src/state/history-store';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector, type ProjectorListener } from '../../src/ui/sidebar/state-projector';
import {
  SPECKIT_PHASE_DEFS,
  SPECKIT_PIPELINE_DEFS,
  SPECKIT_PIPELINE_ID,
  SPECKIT_RUN_PIPELINE
} from '../fixtures/speckit-catalog-fixture';

const QUEUE_B = 'b1f2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PHASE_ID = 'speckit-plan';
const RUN_B = 'run-tail-multi-queue-b';
const RUN_DEFAULT = 'run-tail-multi-queue-default';

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

interface AuditRecord {
  readonly runId: string;
  readonly eventType: string;
  readonly reason: unknown;
}

let store: WorkspaceStateStore;
let queue: QueueManager;
let history: HistoryStore;
let audit: AuditLogWriter;
let workspaceRoot: string;
let wiring: PhaseLogTailWiring | null = null;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  history = new HistoryStore(store);
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-tail-multi-queue-'));
  audit = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger());
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), { id: QUEUE_B, name: 'Queue B', now: 1_700_000_000_000 })
  );
  await store.setGlobalConcurrencyCap(3);
});

afterEach(async () => {
  // Closes the watcher a live tail owns before its directory goes.
  wiring?.dispose();
  wiring = null;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function project(): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    audit,
    history,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? '',
    getCatalog: () => ({
      phases: SPECKIT_PHASE_DEFS,
      pipelines: SPECKIT_PIPELINE_DEFS,
      models: { claude: [], codex: [], agy: [] }
    })
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

/**
 * The two projector members the wiring reads. `subscribe` replays the current
 * snapshot at once, as the production projector does.
 */
function controlledProjector() {
  const listeners = new Set<ProjectorListener>();
  let current = project();
  return {
    getCurrentSnapshot: (): WorkflowSnapshot => current,
    subscribe: (listener: ProjectorListener) => {
      listeners.add(listener);
      listener(current);
      return { dispose: () => { listeners.delete(listener); } };
    },
    publish: (): void => {
      current = project();
      for (const listener of listeners) listener(current);
    }
  };
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

async function startTask(queueId: string, runId: string): Promise<string> {
  const task = await queue.enqueue(`task for ${runId}`, { queueId });
  await store.setRun(queueId, sampleRun({ id: runId, featureId: task.id }), unfencedCommit('test-fixture'));
  await queue.markInFlight(task.id, runId);
  return task.id;
}

async function writeStream(runId: string): Promise<void> {
  const streamPath = resolveStreamJsonlPath({
    workspaceRoot,
    runId,
    pipelineId: SPECKIT_PIPELINE_ID,
    phaseId: PHASE_ID,
    iterationN: 1
  });
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
  const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
  await fs.writeFile(streamPath, `${JSON.stringify(line)}\n`, 'utf8');
}

function buildWiring(projector: ReturnType<typeof controlledProjector>) {
  const appended: AuditRecord[] = [];
  const created = createPhaseLogTailWiring({
    workspaceRoot,
    projector,
    queue,
    auditWriter: {
      append: async (entry) => {
        appended.push({ runId: entry.runId, eventType: entry.eventType, reason: entry.payload.reason });
        return { ...entry, id: `audit-${appended.length}`, timestamp: new Date(0).toISOString() };
      }
    },
    isWorkspaceTrusted: () => true,
    logger: new SanitizedLogger()
  });
  wiring = created;
  const start = (queueId: string, taskId: string) =>
    created.phaseLogTailService.start({
      selection: { queueId, taskId, pipelineId: SPECKIT_PIPELINE_ID, phaseId: PHASE_ID, iterationN: 1 }
    });
  const stop = (sessionId: string) => created.phaseLogTailService.stop({ sessionId });
  const phaseCompleteStops = () =>
    appended.filter((r) => r.eventType === 'phase-log-tail-stopped' && r.reason === 'phase-complete');
  return { appended, start, stop, phaseCompleteStops };
}

async function startedSession(
  h: ReturnType<typeof buildWiring>,
  queueId: string,
  taskId: string
): Promise<string> {
  const started = await h.start(queueId, taskId);
  expect(started).toMatchObject({ outcome: 'success' });
  if (started.outcome !== 'success') throw new Error('tail did not start');
  return started.sessionId;
}

describe('phase-log tail on a queue other than the default (BUG-002, T073)', () => {
  it("starts a tail on queue B's in-flight Task, keyed by its Run", async () => {
    const taskB = await startTask(QUEUE_B, RUN_B);
    await writeStream(RUN_B);
    const h = buildWiring(controlledProjector());

    await startedSession(h, QUEUE_B, taskB);

    expect(h.appended).toContainEqual({ runId: RUN_B, eventType: 'phase-log-tail-started', reason: undefined });
  });

  it("keeps B's tail through a Run starting and ending on the default queue", async () => {
    const taskB = await startTask(QUEUE_B, RUN_B);
    await writeStream(RUN_B);
    const projector = controlledProjector();
    const h = buildWiring(projector);
    const sessionId = await startedSession(h, QUEUE_B, taskB);

    const taskDefault = await startTask(DEFAULT_QUEUE_ID, RUN_DEFAULT);
    projector.publish();
    await queue.finish(taskDefault, 'completed');
    projector.publish();

    expect(h.phaseCompleteStops()).toEqual([]);
    // Still the live session: a torn-down one answers `unknown-session`.
    expect(await h.stop(sessionId)).toEqual({ outcome: 'success', sessionId });
  });

  it("keeps the default queue's tail through a Run starting and ending on B", async () => {
    const taskDefault = await startTask(DEFAULT_QUEUE_ID, RUN_DEFAULT);
    await writeStream(RUN_DEFAULT);
    const projector = controlledProjector();
    const h = buildWiring(projector);
    const sessionId = await startedSession(h, DEFAULT_QUEUE_ID, taskDefault);

    const taskB = await startTask(QUEUE_B, RUN_B);
    projector.publish();
    await queue.finish(taskB, 'completed');
    projector.publish();

    expect(h.phaseCompleteStops()).toEqual([]);
    expect(await h.stop(sessionId)).toEqual({ outcome: 'success', sessionId });
  });

  it("tears down B's tail when B's Run leaves in-flight", async () => {
    const taskB = await startTask(QUEUE_B, RUN_B);
    await writeStream(RUN_B);
    const projector = controlledProjector();
    const h = buildWiring(projector);
    const sessionId = await startedSession(h, QUEUE_B, taskB);

    await queue.finish(taskB, 'completed');
    projector.publish();

    await vi.waitFor(() => {
      expect(h.phaseCompleteStops()).toEqual([
        { runId: RUN_B, eventType: 'phase-log-tail-stopped', reason: 'phase-complete' }
      ]);
    });
    expect(await h.stop(sessionId)).toMatchObject({ outcome: 'failure', reason: 'unknown-session' });
  });

  it("tears down the default queue's tail by its Run id, which is not its Task id", async () => {
    const taskDefault = await startTask(DEFAULT_QUEUE_ID, RUN_DEFAULT);
    await writeStream(RUN_DEFAULT);
    const projector = controlledProjector();
    const h = buildWiring(projector);
    const sessionId = await startedSession(h, DEFAULT_QUEUE_ID, taskDefault);
    // The premise the production defect hid behind.
    expect(taskDefault).not.toBe(RUN_DEFAULT);

    await queue.finish(taskDefault, 'completed');
    projector.publish();

    await vi.waitFor(() => {
      expect(h.phaseCompleteStops()).toEqual([
        { runId: RUN_DEFAULT, eventType: 'phase-log-tail-stopped', reason: 'phase-complete' }
      ]);
    });
    expect(await h.stop(sessionId)).toMatchObject({ outcome: 'failure', reason: 'unknown-session' });
  });
});
