// FR-R3-008 (T384) — the acceptance test for blueprint DATA-02.
//
// The defect, stated as an operator's question: a phase that has been streaming
// output productively for three and a half hours and a phase that died three and
// a half hours ago look identical in the persisted record. `lastTransitionAt` moved
// at the last status change and has not moved since for either of them, and the
// only thing that knew the difference — `CliMonitorState` — lives in the window's
// memory and is discarded when the window reloads.
//
// So the test is a reload. The chain is real end to end: `ClaudeCliMonitor` sees
// chunks, `ActivityCoalescer` bounds the rate, `SchegentWorkflowController`
// performs the `setRun`, `WorkspaceStateStore` persists it, and a **second** store
// over the same memento reads it back — which is what a window reload does. The
// projection is then taken with no monitor attached, exactly as a freshly
// activated window's would be, and the assertions turn on what the record alone
// can answer.
//
// The negative half is asserted alongside: after the reload the in-memory
// reading (`liveActivity`) reports `freshness: 'live'` for **both** Runs, because
// it has no monotonic stamp to measure from. That is not a bug in this feature —
// it is the state DATA-02 describes, pinned here so the persisted field is
// visibly the thing doing the work rather than duplicating a reading that already
// worked.

import { describe, expect, it, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { ACTIVITY_COALESCE_INTERVAL_MS } from '../../../src/monitor/activity-coalescer';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import { SanitizedLogger } from '../../../src/lib/logger';
import { QueueManager } from '../../../src/queue/queue-manager';
import { createQueue, DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { Notifier } from '../../../src/ui/notifications';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { STALE_SLOWING_MAX_MS } from '../../../src/ui/sidebar/freshness';
import type { InFlightRunProjection, WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../../src/ui/sidebar/state-projector';

const QUEUE_B = 'b1f2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const WALL_START = Date.parse('2026-05-10T08:00:00.000Z');
/** The duration from the blueprint finding: a phase that ran, or hung, for 3.6 h. */
const LONG_PHASE_MS = 3.6 * 60 * 60 * 1_000;
/**
 * The production interval, not a shortened test one. An integration test that
 * narrowed the window would measure a coalescer this host does not ship.
 */
const COALESCE_MS = ACTIVITY_COALESCE_INTERVAL_MS;

/** Counts memento writes per key, which is what write amplification looks like. */
class CountingMemento implements Memento {
  private map = new Map<string, unknown>();
  public writes = new Map<string, number>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
  public runWrites(): number {
    return this.writes.get(KEYS.run) ?? 0;
  }
}

const PIPELINE = Object.freeze({
  id: 'ab-flow',
  name: 'A then B',
  phases: Object.freeze([
    Object.freeze({ id: 'alpha', name: 'Alpha', version: 1, instruction: 'a' }),
    Object.freeze({ id: 'beta', name: 'Beta', version: 1, instruction: 'b' }),
    Object.freeze({ id: 'gamma', name: 'Gamma', version: 1, instruction: 'c' }),
    Object.freeze({ id: 'done', name: 'Done', version: 1, instruction: '(no-op)' })
  ])
}) as unknown as WorkflowRun['pipeline'];

let memento: CountingMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let controller: SchegentWorkflowController;
let elapsed: number;
let monitor: ClaudeCliMonitor;

function makeController(target: WorkspaceStateStore, q: QueueManager): SchegentWorkflowController {
  return new SchegentWorkflowController(
    { run: async () => undefined } as unknown as PhaseRunner,
    target,
    q,
    { update: () => {}, dispose: () => {} } as unknown as SchegentStatusBar,
    { info: () => {}, warn: () => {}, error: () => {} } as unknown as Notifier,
    new SanitizedLogger(),
    {
      release: async () => {},
      tryAcquire: () => true,
      heartbeat: () => {},
      isHeld: () => true,
      ownerOfRecord: () => null,
      id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
    { auditWriter: { append: async (entry) => ({ ...entry, id: 'a', timestamp: '' }) as never } }
  );
}

/** The production wiring, minus `extension.ts`: monitor → coalescer → controller. */
function makeMonitor(): ClaudeCliMonitor {
  return new ClaudeCliMonitor({
    stallThresholdMs: STALE_SLOWING_MAX_MS,
    rateLimitMatchers: [],
    monotonicNow: () => 1_000 + elapsed,
    now: () => new Date(WALL_START + elapsed),
    audit: { append: async (entry) => ({ ...entry, id: 'a', timestamp: '' }) as never },
    transport: { record: () => {} },
    activity: { record: (observation) => controller.recordRunActivity(observation) },
    activityCoalesceMs: COALESCE_MS,
    logger: { sanitize: (s: string) => s, warn: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {}
  });
}

async function seedRun(
  runId: string,
  queueId: string,
  overrides: Partial<WorkflowRun> = {}
): Promise<void> {
  const feature = await queue.enqueue(`work for ${runId}`, { queueId });
  await queue.markInFlight(feature.id, runId);
  await store.setRun(queueId, {
    id: runId,
    featureId: feature.id,
    featureDir: 'specs/001-x',
    status: 'running',
    currentPhase: 'beta',
    currentIteration: 1,
    startedAt: WALL_START,
    lastTransitionAt: WALL_START,
    phasesCompleted: [],
    lastError: null,
    pipeline: PIPELINE,
    plannedTotal: { phaseCount: 4, iterationCap: 5, maxPhaseInvocations: 8 },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  },
    unfencedCommit('test-fixture')
  );
}

/** `recordRunActivity` is fire-and-forget; let its `setRun` land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fresh store over the same memento — what a window reload produces. */
async function reload(): Promise<WorkspaceStateStore> {
  const next = new WorkspaceStateStore(memento);
  await next.initialize();
  return next;
}

/**
 * The projection a freshly activated window takes: no monitor, because the
 * process the previous window was watching is not this window's to watch.
 */
function project(target: WorkspaceStateStore): WorkflowSnapshot {
  const projector = new StateProjector({
    store: target,
    audit: {
      subscribe: () => ({ dispose: () => {} }),
      logPath: '/tmp/nonexistent/audit.log',
      workspaceRoot: '/tmp/nonexistent'
    },
    monitor: null,
    ownerId: 'this-window',
    now: () => new Date(WALL_START + elapsed),
    monotonicNow: () => 1_000 + elapsed,
    sanitize: (value: string | null | undefined) => value ?? ''
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

function runOf(snapshot: WorkflowSnapshot, queueId: string): InFlightRunProjection {
  const runtime = snapshot.queues.find((entry) => entry.queueId === queueId);
  if (!runtime?.inFlightRun) throw new Error(`no in-flight Run published for ${queueId}`);
  return runtime.inFlightRun;
}

beforeEach(async () => {
  elapsed = 0;
  memento = new CountingMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), { id: QUEUE_B, name: 'Queue B', now: WALL_START })
  );
  await store.setGlobalConcurrencyCap(3);
  controller = makeController(store, queue);
  monitor = makeMonitor();
});

describe('FR-R3-008 — working and hung are distinguishable after a window reload', () => {
  it('answers the liveness question from the record alone, for both runs', async () => {
    await seedRun('run-hung', DEFAULT_QUEUE_ID);
    await seedRun('run-working', QUEUE_B);

    // Both phases start, both produce output, and then one of them stops.
    monitor.onStart('run-hung', 'speckit-implement', 101);
    monitor.onStart('run-working', 'speckit-implement', 102);
    monitor.onStdoutChunk('run-hung', 'building\n');
    monitor.onStdoutChunk('run-working', 'building\n');
    await settle();

    // 3.6 hours pass. `run-working` keeps talking throughout; `run-hung` says
    // nothing more. Neither changes status, so neither moves `lastTransitionAt`.
    for (let step = 0; step < LONG_PHASE_MS / COALESCE_MS; step += 1) {
      elapsed += COALESCE_MS;
      monitor.onStdoutChunk('run-working', `still working ${step}\n`);
    }
    await settle();

    const reloaded = await reload();
    const hungRecord = reloaded.getRun(DEFAULT_QUEUE_ID)!;
    const workingRecord = reloaded.getRun(QUEUE_B)!;

    // The stamp survived the reload — the whole point of persisting it.
    expect(hungRecord.liveness, 'the hung Run recorded its one burst of output').toBeDefined();
    expect(workingRecord.liveness).toBeDefined();

    const nowMs = WALL_START + elapsed;
    const hungAge = nowMs - hungRecord.liveness!.lastActivityAt;
    const workingAge = nowMs - workingRecord.liveness!.lastActivityAt;

    expect(hungAge, 'silent for the whole phase').toBeGreaterThanOrEqual(LONG_PHASE_MS);
    expect(workingAge, 'within one coalescing interval of now').toBeLessThanOrEqual(COALESCE_MS);
    expect(hungAge).toBeGreaterThan(STALE_SLOWING_MAX_MS);
    expect(workingAge).toBeLessThan(STALE_SLOWING_MAX_MS);

    // Neither status nor the transition stamp moved for either Run, which is why
    // the pre-feature record could not tell these two apart.
    expect(hungRecord.lastTransitionAt).toBe(WALL_START);
    expect(workingRecord.lastTransitionAt).toBe(WALL_START);
    expect(hungRecord.status).toBe('running');
    expect(workingRecord.status).toBe('running');
  });

  it('publishes the persisted reading on the reloaded snapshot, where the in-memory one is blind', async () => {
    await seedRun('run-hung', DEFAULT_QUEUE_ID);
    await seedRun('run-working', QUEUE_B);

    monitor.onStart('run-hung', 'speckit-implement', 101);
    monitor.onStart('run-working', 'speckit-implement', 102);
    monitor.onStdoutChunk('run-hung', 'building\n');
    monitor.onStdoutChunk('run-working', 'building\n');
    await settle();
    for (let step = 0; step < LONG_PHASE_MS / COALESCE_MS; step += 1) {
      elapsed += COALESCE_MS;
      monitor.onStdoutChunk('run-working', `still working ${step}\n`);
    }
    await settle();

    const snapshot = project(await reload());
    const hung = runOf(snapshot, DEFAULT_QUEUE_ID);
    const working = runOf(snapshot, QUEUE_B);

    // The in-memory reading has nothing to measure from after a reload, so it
    // reports both Runs identically — this is DATA-02, pinned.
    expect(hung.liveActivity.freshness).toBe(working.liveActivity.freshness);
    expect(hung.liveActivity.staleSeconds).toBeNull();
    expect(working.liveActivity.staleSeconds).toBeNull();

    // The persisted reading tells them apart.
    expect(hung.liveness, 'projected, not dropped').not.toBeNull();
    expect(working.liveness).not.toBeNull();
    const nowMs = WALL_START + elapsed;
    expect(nowMs - Date.parse(hung.liveness!.lastActivityAt)).toBeGreaterThanOrEqual(LONG_PHASE_MS);
    expect(nowMs - Date.parse(working.liveness!.lastActivityAt)).toBeLessThanOrEqual(COALESCE_MS);
    expect(working.liveness!.stdoutLines, 'counters travel with the stamp').toBeGreaterThan(1);
  });

  it('publishes a determinate denominator with the numerator', async () => {
    await seedRun('run-progress', DEFAULT_QUEUE_ID, {
      phasesCompleted: [
        {
          phase: 'alpha',
          iteration: 1,
          startedAt: WALL_START,
          endedAt: WALL_START + 1_000,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        },
        {
          phase: 'beta',
          iteration: 1,
          startedAt: WALL_START + 1_000,
          endedAt: WALL_START + 2_000,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ]
    });

    const progress = runOf(project(await reload()), DEFAULT_QUEUE_ID).progress;
    expect(progress).not.toBeNull();
    expect(progress!.phasesCompleted).toBe(2);
    expect(progress!.phaseCount, 'the frozen total, not a live count').toBe(4);
    expect(progress!.percent).toBe(50);
    expect(progress!.iterationCap).toBe(5);
  });

  it('bounds run-record writes by elapsed time, not by line count', async () => {
    await seedRun('run-chatty', DEFAULT_QUEUE_ID);
    const before = memento.runWrites();

    monitor.onStart('run-chatty', 'speckit-implement', 101);
    // 10,000 lines inside one coalescing interval, in realistic multi-line chunks.
    for (let chunk = 0; chunk < 1_000; chunk += 1) {
      monitor.onStdoutChunk(
        'run-chatty',
        Array.from({ length: 10 }, (_, line) => `line ${chunk}-${line}`).join('\n') + '\n'
      );
    }
    await settle();

    expect(monitor.getCurrentState('run-chatty')!.stdoutLines).toBe(10_000);
    // `1 + floor(elapsed / interval)` with no elapsed time is one.
    expect(memento.runWrites() - before, '10,000 lines, one run-record write').toBe(1);

    // And the persisted counters still reflect the burst, so the bound is on the
    // write rate rather than on what a write is allowed to say.
    const persisted = (await reload()).getRun(DEFAULT_QUEUE_ID)!;
    expect(persisted.liveness!.stdoutLines).toBeGreaterThanOrEqual(1);
    expect(persisted.liveness!.lastActivityAt).toBe(WALL_START);
  });

  it('carries no line content and no path out of the chunk path', async () => {
    // The last acceptance criterion, driven through the real chain rather than
    // argued from the types: `RunLiveness` has no string field, so this cannot
    // regress without a shape change — and a shape change is exactly what a
    // future "just add the last line for context" edit would be. The chunk below
    // carries the two things that must not survive: an absolute workspace path
    // and a token-shaped string.
    await seedRun('run-secrets', DEFAULT_QUEUE_ID);
    monitor.onStart('run-secrets', 'speckit-implement', 101);
    monitor.onStdoutChunk(
      'run-secrets',
      'wrote /Users/someone/ws/repo/src/secret.ts\nANTHROPIC_API_KEY=sk-ant-api03-not-a-real-key\n'
    );
    elapsed += COALESCE_MS;
    monitor.onStderrChunk('run-secrets', 'warn: /Users/someone/ws/.schegent/audit.log\n');
    await settle();

    const liveness = (await reload()).getRun(DEFAULT_QUEUE_ID)!.liveness!;
    expect(Object.keys(liveness).sort()).toEqual([
      'lastActivityAt',
      'stderrLines',
      'stdoutLines'
    ]);
    for (const value of Object.values(liveness)) expect(typeof value).toBe('number');
    // Belt and braces against a future field: the serialized record must not
    // contain either needle anywhere under `liveness`.
    const serialized = JSON.stringify(liveness);
    expect(serialized).not.toMatch(/sk-ant/);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/secret\.ts/);
    // The counters still did their job, so the absence is of content, not of signal.
    expect(liveness.stdoutLines).toBe(2);
    expect(liveness.stderrLines).toBe(1);
  });

  it('renders a record written before the feature as unknown, never as zero', async () => {
    // A legacy record: no `liveness`, no `plannedTotal`. The v11 migrator tolerates
    // both absences, and the projection must carry the absence through rather than
    // substituting a stamp of `startedAt` or a total of zero.
    await seedRun('run-legacy', DEFAULT_QUEUE_ID, { plannedTotal: undefined });

    const reloaded = await reload();
    expect(reloaded.getRun(DEFAULT_QUEUE_ID)!.liveness).toBeUndefined();
    expect(reloaded.getRun(DEFAULT_QUEUE_ID)!.plannedTotal).toBeUndefined();

    const projected = runOf(project(reloaded), DEFAULT_QUEUE_ID);
    expect(projected.liveness, 'unknown, not a fabricated stamp').toBeNull();
    expect(projected.progress, 'unknown, not 0 of 0').toBeNull();
    // The rest of the Run still projects, so absence is scoped to the two fields.
    expect(projected.runId).toBe('run-legacy');
    expect(projected.status).toBe('running');
  });
});
