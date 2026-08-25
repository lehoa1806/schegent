import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { STALENESS_THRESHOLD_MS } from '../../../../src/state/lock';
import type { WorkflowRun, WorkspaceLock } from '../../../../src/state/workflow-run';
import type { QueueState, FeatureRequest } from '../../../../src/queue/feature-request';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';
import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { runOf, runtimeOf, statusOf } from './queue-runtime-read.helpers';
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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-projector-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeProjector(
  opts: { ownerId?: string; debounceMs?: number; now?: () => Date } = {}
): StateProjector {
  return new StateProjector({
    store,
    audit,
    ownerId: opts.ownerId ?? 'this-window',
    debounceMs: opts.debounceMs ?? 100,
    now: opts.now
  });
}

function emptyQueue(): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

function pendingRequest(id: string, description: string, position: number, enqueuedAt = 1_000_000): FeatureRequest {
  return {
    id,
    description,
    enqueuedAt,
    createdAt: enqueuedAt,
    startedAt: null,
    updatedAt: enqueuedAt,
    completedAt: null,
    status: 'pending',
    position,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

function inFlightRequest(id: string, description: string): FeatureRequest {
  return {
    id,
    description,
    enqueuedAt: 1_000_000,
    createdAt: 1_000_000,
    startedAt: 1_000_000,
    updatedAt: 1_000_000,
    completedAt: null,
    status: 'in-flight',
    position: 0,
    runId: 'run-1',
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

function sampleLock(ownerId = 'this-window'): WorkspaceLock {
  return { ownerId, acquiredAt: 1, heartbeatAt: Date.now() };
}

/**
 * Feature 092 (T096) — a Run is published under the queue that holds its Task,
 * so a test reading a run-scoped value has to put that Task on the queue.
 * Merges into whatever queue state the test already set rather than replacing
 * it, so the queue-projection fixtures below keep their own rows.
 */
async function ownRun(featureId = 'feat-1'): Promise<void> {
  const current = store.getQueue(DEFAULT_QUEUE_ID);
  await store.setQueue({
    ...current,
    requests: [...current.requests, inFlightRequest(featureId, 'owning task')],
    inFlightId: featureId,
    queueLifecycle: 'running'});
}

// Feature 098 (T055) — carries a frozen Pipeline now. Every Run freezes one at
// creation, and the projector no longer substitutes a built-in list for a Run
// that does not, so a fixture without one projects an empty strip and the cases
// that read a tile off it read nothing. The legacy-run case further down builds
// its own record without a Pipeline, which is the point of that case.
function sampleRun(): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
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
    resumeTargetPhaseId: null
  };
}

describe('StateProjector.getCurrentSnapshot', () => {
  it('projects source-aware Phase rows and sanitizes operator-authored catalog text', () => {
    // Feature 099 (T496f, FR-042) — one stored layer, so the row that used to be
    // seeded at `workspace` is simply the row.
    const catalog = resolvePhaseCatalog({
      rows: [{
        id: 'operator-phase',
        name: 'Token SECRET',
        version: 1,
        instruction: 'Run SECRET safely.'
      }],
      revision: 'rev-phase-projector'
    });
    const p = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      sanitize: (value) => (value ?? '').replaceAll('SECRET', '[REDACTED]'),
      getPhaseCatalog: () => catalog
    });
    p.start();
    const phaseCatalog = p.getCurrentSnapshot().phaseCatalog;
    expect(phaseCatalog?.state).toBe('ready');
    // Feature 099 (T496f, FR-042) — the record's `scope` went with the layer
    // tier; `key` took its place as the field that distinguishes two rows
    // claiming one id, which is the only thing scope was still doing here.
    expect(phaseCatalog?.records[0]).toMatchObject({
      phaseId: 'operator-phase',
      key: 'operator-phase::0',
      status: 'effective'
    });
    expect(phaseCatalog?.records[0].definition?.name).toBe('Token [REDACTED]');
    expect(phaseCatalog?.effective[0].instruction).toBe('Run [REDACTED] safely.');
    p.dispose();
  });

  it('builds an idle snapshot when no run, no queue, no lock', () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    // Feature 092 (T096) — the default queue is still published (the registry
    // has it) but owns no Run, so every run-scoped reading is absent together
    // rather than each carrying an idle default (FR-053).
    expect(statusOf(snap)).toBe('idle');
    expect(runOf(snap)).toBeNull();
    expect(runtimeOf(snap).phases).toEqual([]);
    expect(snap.queue.inFlight).toBeNull();
    expect(snap.queue.pending).toEqual([]);
    expect(snap.auditTail).toEqual([]);
    p.dispose();
  });

  it('reflects run state into status, activeFeature, and active phase tile', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(statusOf(snap)).toBe('running');
    expect(runOf(snap)?.feature).not.toBeNull();
    expect(runOf(snap)?.feature?.id).toBe('feat-1');
    const planTile = runtimeOf(snap).phases.find((t) => t.name === 'speckit-plan');
    expect(planTile?.state).toBe('active');
    p.dispose();
  });

  it('computes isPrimary from the current lock owner versus the configured ownerId', async () => {
    await store.setLock(sampleLock('other-window'));
    const p = makeProjector({ ownerId: 'this-window' });
    p.start();
    expect(p.getCurrentSnapshot().isPrimary).toBe(false);
    await store.setLock(sampleLock('this-window'));
    // wait for debounce
    await new Promise((r) => setTimeout(r, 130));
    expect(p.getCurrentSnapshot().isPrimary).toBe(true);
    p.dispose();
  });

  it('projects in-flight, pending, and recent queue items', async () => {
    const requests: FeatureRequest[] = [
      inFlightRequest('q-active', 'building...'),
      pendingRequest('q-1', 'first', 1),
      pendingRequest('q-2', 'second', 2),
      {
        id: 'q-old',
        description: 'done',
        enqueuedAt: 999,
        createdAt: 999,
        startedAt: 999,
        updatedAt: 999,
        completedAt: 999,
        status: 'completed',
        position: 99,
        runId: 'r-old',
        retryCount: 0,
        lastError: null,
        pausedReason: null
      }
    ];
    const queue: QueueState = { requests, inFlightId: 'q-active', pausedReason: null, updatedAt: 0, queueLifecycle: 'running', pauseSource: null, scheduledStartAt: null, scheduledStartSource: null };
    await store.setQueue(queue);
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.inFlight?.id).toBe('q-active');
    expect(snap.queue.pending.map((q) => q.id)).toEqual(['q-1', 'q-2']);
    expect(snap.queue.recent.map((q) => q.id)).toContain('q-old');
    p.dispose();
  });

  it('projects queue registry and derived queue pause causes', async () => {
    // Feature 030 (US3, T046) — single-queue mode. The original test
    // exercised a two-queue projection via `createQueue('Secondary')`,
    // which is now blocked by MAX_QUEUES=1. With the single unified
    // queue, the registry shape is fixed at one default entry; the
    // queue-paused derivation still applies and surfaces in the
    // projected `pauseCause` on pending requests when the default
    // queue is manually paused.
    //
    // FR-R3-011 — the pause is now set on the queue record. `setQueuePaused`
    // wrote it onto the registry entry, which no longer holds one; the
    // projector reads the pause through `getProjectedQueueRegistry()`, which
    // derives it from exactly the record written here.
    await store.setQueue({
      ...emptyQueue(),
      queueLifecycle: 'operator-paused',
      pauseSource: 'operator',
      updatedAt: 1_700_000_000_001,
      requests: [{ ...pendingRequest('q-1', 'first', 0), queueId: DEFAULT_QUEUE_ID }]
    });

    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.queues.map((queue) => queue.name)).toEqual(['Default queue']);
    expect(snap.queue.pending[0].queueId).toBe(DEFAULT_QUEUE_ID);
    expect(snap.queue.pending[0].pauseCause).toBe('queue-paused');
    p.dispose();
  });

  it('projects run phase overrides and manual pause state', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, {
      ...sampleRun(),
      phaseOverrides: [
        { phaseId: 'speckit-plan', action: 'disabled', actor: 'op', setAt: 1_700_000_000_000 }
      ],
      manualPauseAt: 1_700_000_000_001,
      manualPauseCause: 'operator-paused'
    },
      unfencedCommit('test-fixture')
    );
    await ownRun();

    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phaseOverrides).toEqual([
      { phaseId: 'speckit-plan', action: 'disabled' }
    ]);
    // The pair moves together in v4 — a cause without a timestamp is no longer
    // representable, so both are read off the one `manualPause` record.
    expect(runtimeOf(snap).manualPause?.at).toBe(new Date(1_700_000_000_001).toISOString());
    expect(runtimeOf(snap).manualPause?.cause).toBe('operator-paused');
    p.dispose();
  });

  it('projects phase-message metadata without message values', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    p.subscribe((s) => received.push(s));
    received.length = 0;

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'phase-message-emitted',
      payload: {
        phaseId: 'speckit-plan',
        entryCount: 2,
        byteSize: 48,
        secret: 'should-not-project'
      },
      outcome: 'info'
    });

    await vi.advanceTimersByTimeAsync(120);
    const last = received[received.length - 1];
    const plan = runtimeOf(last).phases.find((tile) => tile.name === 'speckit-plan');
    expect(plan?.phaseMessage).toEqual({
      fromPhaseId: 'speckit-plan',
      entryCount: 2,
      byteSize: 48,
      truncated: false,
      invalidReason: null
    });
    expect(JSON.stringify(plan?.phaseMessage)).not.toContain('should-not-project');
    p.dispose();
  });
});

describe('StateProjector.getCurrentSnapshot — queue.orderedItems (BUG-010 / FR-029 amendment)', () => {
  // The snapshot construction at state-projector.ts:796-812 previously
  // omitted `orderedItems` from the `queue` projection, masked by an
  // `as QueueProjection` cast. The webview's `?? []` fallback then
  // rendered the Active Queue panel as empty even while a pipeline was
  // running. These tests pin the construction-site invariant: every
  // constructed snapshot's `queue.orderedItems` MUST be a defined,
  // populated array containing the in-flight row plus all pending rows.

  it('populates queue.orderedItems with the in-flight row and the pending row', async () => {
    const requests: FeatureRequest[] = [
      inFlightRequest('q-active', 'building...'),
      pendingRequest('q-1', 'next', 1)
    ];
    const queue: QueueState = {
      requests,
      inFlightId: 'q-active',
      paused: false,
      pausedReason: null,
      updatedAt: 0,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await store.setQueue(queue);
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.orderedItems).toBeDefined();
    expect(Array.isArray(snap.queue.orderedItems)).toBe(true);
    expect(snap.queue.orderedItems).toHaveLength(2);
    expect(snap.queue.orderedItems.map((item) => item.id)).toContain('q-active');
    expect(snap.queue.orderedItems.map((item) => item.id)).toContain('q-1');
    p.dispose();
  });

  it('preserves the paused in-flight row in queue.orderedItems (FR-026 stable identifier)', async () => {
    const pausedInFlight: FeatureRequest = {
      ...inFlightRequest('q-paused', 'rate-limited'),
      status: 'paused',
      pausedReason: 'rate-limit'
    };
    const queue: QueueState = {
      requests: [pausedInFlight, pendingRequest('q-1', 'after', 1)],
      inFlightId: 'q-paused',
      paused: true,
      pausedReason: 'rate-limit',
      updatedAt: 0,
      queueLifecycle: 'operator-paused',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await store.setQueue(queue);
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.orderedItems).toBeDefined();
    expect(snap.queue.orderedItems.map((item) => item.id)).toContain('q-paused');
    expect(snap.queue.orderedItems).toHaveLength(2);
    p.dispose();
  });

  it('emits an empty (but defined) orderedItems array when the queue is active-empty', async () => {
    await store.setQueue(emptyQueue());
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.orderedItems).toBeDefined();
    expect(Array.isArray(snap.queue.orderedItems)).toBe(true);
    expect(snap.queue.orderedItems).toHaveLength(0);
    expect(snap.queue.orderedItems).not.toBeUndefined();
    p.dispose();
  });

  it('emits orderedItems on the idle (no-queue) construction path', () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.orderedItems).toBeDefined();
    expect(Array.isArray(snap.queue.orderedItems)).toBe(true);
    p.dispose();
  });
});

describe('StateProjector.computeIsPrimary — staleness rules (BUG-005)', () => {
  // Boundary semantic mirrors lock.ts: stale iff (now - heartbeatAt) > STALENESS_THRESHOLD_MS.
  // At exactly the threshold the lock is "just-fresh", not stale.
  const NOW_MS = 2_000_000_000_000;
  const fixedNow = () => new Date(NOW_MS);

  it('treats a foreign lock as fresh when heartbeat is recent (isPrimary=false)', async () => {
    await store.setLock({ ownerId: 'other-window', acquiredAt: 1, heartbeatAt: NOW_MS - 1_000 });
    const p = makeProjector({ ownerId: 'this-window', now: fixedNow });
    p.start();
    expect(p.getCurrentSnapshot().isPrimary).toBe(false);
    p.dispose();
  });

  it('treats a foreign lock at exactly the threshold as just-fresh (isPrimary=false)', async () => {
    await store.setLock({
      ownerId: 'other-window',
      acquiredAt: 1,
      heartbeatAt: NOW_MS - STALENESS_THRESHOLD_MS
    });
    const p = makeProjector({ ownerId: 'this-window', now: fixedNow });
    p.start();
    expect(p.getCurrentSnapshot().isPrimary).toBe(false);
    p.dispose();
  });

  it('treats a foreign lock past the threshold as stale (isPrimary=true)', async () => {
    await store.setLock({
      ownerId: 'other-window',
      acquiredAt: 1,
      heartbeatAt: NOW_MS - (STALENESS_THRESHOLD_MS + 1)
    });
    const p = makeProjector({ ownerId: 'this-window', now: fixedNow });
    p.start();
    expect(p.getCurrentSnapshot().isPrimary).toBe(true);
    p.dispose();
  });

  it('treats a stale lock owned by self as primary (isPrimary=true)', async () => {
    await store.setLock({
      ownerId: 'this-window',
      acquiredAt: 1,
      heartbeatAt: NOW_MS - (STALENESS_THRESHOLD_MS + 1)
    });
    const p = makeProjector({ ownerId: 'this-window', now: fixedNow });
    p.start();
    expect(p.getCurrentSnapshot().isPrimary).toBe(true);
    p.dispose();
  });
});

describe('StateProjector.subscribe', () => {
  it('emits an initial snapshot immediately on subscribe (leading edge)', () => {
    const p = makeProjector();
    p.start();
    const received: WorkflowSnapshot[] = [];
    const sub = p.subscribe((s) => received.push(s));
    expect(received).toHaveLength(1);
    expect(statusOf(received[0])).toBe('idle');
    sub.dispose();
    p.dispose();
  });

  it('coalesces multiple events into one snapshot per debounce window', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    p.subscribe((s) => received.push(s));
    received.length = 0; // drop the leading emit

    // Fire three events within the same 100ms window — synchronously trigger by manually calling notify via setters
    await store.setQueue(emptyQueue());
    await store.setQueue(emptyQueue());
    await store.setQueue(emptyQueue());

    // Still inside the debounce window
    await vi.advanceTimersByTimeAsync(50);
    expect(received).toHaveLength(0);

    // Window elapses → trailing edge fires once
    await vi.advanceTimersByTimeAsync(60);
    expect(received).toHaveLength(1);
    p.dispose();
  });

  it('audit emitter triggers a debounced re-projection', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    p.subscribe((s) => received.push(s));
    received.length = 0; // drop leading emit

    await audit.append({
      runId: 'r',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      payload: {},
      outcome: 'info'
    });

    await vi.advanceTimersByTimeAsync(120);
    expect(received).toHaveLength(1);
    p.dispose();
  });

  it('does not lose the most recent state when audit fires during a projection', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    p.subscribe((s) => received.push(s));
    received.length = 0;

    await audit.append({
      runId: 'r',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      payload: {},
      outcome: 'info'
    });
    await vi.advanceTimersByTimeAsync(50);
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await ownRun();
    await vi.advanceTimersByTimeAsync(110);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(statusOf(last)).toBe('running');
    p.dispose();
  });

  it('disposing a subscription stops future deliveries', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    const sub = p.subscribe((s) => received.push(s));
    received.length = 0;

    sub.dispose();

    await store.setQueue(emptyQueue());
    await vi.advanceTimersByTimeAsync(120);
    expect(received).toHaveLength(0);
    p.dispose();
  });

  it('keeps audit tail capped at 50 entries', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    for (let i = 0; i < 60; i++) {
      await audit.append({
        runId: 'r',
        phase: 'speckit-specify',
        iteration: i,
        eventType: 'phase-end',
        payload: { i },
        outcome: 'success'
      });
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(p.getCurrentSnapshot().auditTail.length).toBe(50);
    p.dispose();
  });
});

describe('StateProjector.dispose', () => {
  it('unsubscribes from store and audit emitters', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    const received: WorkflowSnapshot[] = [];
    p.subscribe((s) => received.push(s));
    received.length = 0;

    p.dispose();

    await store.setQueue(emptyQueue());
    await audit.append({
      runId: 'r',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      payload: {},
      outcome: 'info'
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(received).toHaveLength(0);
  });
});

describe('StateProjector multi-window snapshot equivalence (SC-005)', () => {
  function deterministicNow(): () => Date {
    let t = 1_700_000_000_000;
    return () => {
      t += 1;
      return new Date(t);
    };
  }

  function makeWindowProjector(deps: {
    monoClock: { value: number };
    nowFn: () => Date;
    debounceMs?: number;
  }): StateProjector {
    return new StateProjector({
      store,
      audit,
      ownerId: 'shared-owner',
      debounceMs: deps.debounceMs ?? 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => deps.monoClock.value,
      now: deps.nowFn
    });
  }

  function stripProducedAt(snap: WorkflowSnapshot): Omit<WorkflowSnapshot, 'producedAt'> {
    const { producedAt: _omit, ...rest } = snap;
    return rest;
  }

  it('two projectors driven by the same store + audit + monotonicNow produce byte-equal snapshots', async () => {
    vi.useFakeTimers();
    const monoClock = { value: 0 };
    const nowA = deterministicNow();
    const nowB = deterministicNow();

    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));

    const projA = makeWindowProjector({ monoClock, nowFn: nowA });
    const projB = makeWindowProjector({ monoClock, nowFn: nowB });

    const snapsA: WorkflowSnapshot[] = [];
    const snapsB: WorkflowSnapshot[] = [];
    projA.subscribe((s) => snapsA.push(s));
    projB.subscribe((s) => snapsB.push(s));
    projA.start();
    projB.start();

    snapsA.length = 0;
    snapsB.length = 0;

    monoClock.value = 1_000;
    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'first event' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    monoClock.value = 4_000;
    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'phase-start',
      payload: { summary: 'second event' },
      outcome: 'info'
    });
    await vi.advanceTimersByTimeAsync(120);

    monoClock.value = 7_500;
    await store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), currentPhase: 'speckit-tasks' }, unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);

    monoClock.value = 12_000;
    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 2, tasksTotal: 8 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    expect(snapsA.length).toBeGreaterThan(0);
    expect(snapsB).toHaveLength(snapsA.length);

    for (let i = 0; i < snapsA.length; i++) {
      const a = stripProducedAt(snapsA[i]);
      const b = stripProducedAt(snapsB[i]);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }

    projA.dispose();
    projB.dispose();
  });
});

describe('StateProjector monitor projection (T023)', () => {
  function makeFakeMonitor(opts: { initial?: ReturnType<typeof buildMonitorState> | null } = {}) {
    let state: ReturnType<typeof buildMonitorState> | null = opts.initial ?? null;
    const listeners: Array<(s: typeof state) => void> = [];
    let pausedCalls = 0;
    let resumedCalls = 0;
    return {
      getCurrentState: () => state,
      subscribe: (cb: (s: typeof state) => void) => {
        listeners.push(cb);
        return { dispose: () => { /* noop */ } };
      },
      onWorkflowPaused: () => { pausedCalls++; },
      onWorkflowResumed: () => { resumedCalls++; },
      setState: (s: typeof state) => {
        state = s;
        for (const l of listeners) l(state);
      },
      get pausedCalls() { return pausedCalls; },
      get resumedCalls() { return resumedCalls; }
    };
  }

  function buildMonitorState(overrides: Partial<{
    runId: string; phase: string; status: string; pid: number | null;
    startedAt: string; lastStdoutAt: string | null; lastStderrAt: string | null;
    lastProgressAt: string | null; stdoutLines: number; stderrLines: number;
    firstOutputAt: string | null; lastOutputAt: string | null;
    exitCode: number | null; signal: string | null;
    detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
    msSinceLastStdout: number | null; msSinceLastStderr: number | null;
  }> = {}) {
    return {
      runId: overrides.runId ?? 'r1',
      phase: (overrides.phase ?? 'speckit-plan') as 'speckit-plan',
      status: (overrides.status ?? 'running') as 'running',
      pid: overrides.pid ?? 100,
      startedAt: overrides.startedAt ?? '2026-05-10T12:00:00.000Z',
      lastStdoutAt: overrides.lastStdoutAt ?? null,
      lastStderrAt: overrides.lastStderrAt ?? null,
      lastProgressAt: overrides.lastProgressAt ?? null,
      stdoutLines: overrides.stdoutLines ?? 0,
      stderrLines: overrides.stderrLines ?? 0,
      // Feature FR-R3-007 (T353) — the transport aggregate the summary carries.
      firstOutputAt: overrides.firstOutputAt ?? null,
      lastOutputAt: overrides.lastOutputAt ?? null,
      exitCode: overrides.exitCode ?? null,
      signal: overrides.signal ?? null,
      detectedIssues: overrides.detectedIssues ?? ([] as ReadonlyArray<'rate_limited' | 'stall'>),
      msSinceLastStdout: overrides.msSinceLastStdout ?? null,
      msSinceLastStderr: overrides.msSinceLastStderr ?? null
    };
  }

  it('snapshot.monitor === null when no monitor wired', async () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.monitor).toBeNull();
    p.dispose();
  });

  it('projects running monitor state into snapshot.monitor', async () => {
    const monitor = makeFakeMonitor({
      initial: buildMonitorState({ status: 'running', stdoutLines: 5, msSinceLastStdout: 1_500 })
    });
    const p = new StateProjector({
      store, audit, ownerId: 'this-window', debounceMs: 100, monitor
    });
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.monitor).not.toBeNull();
    expect(snap.monitor!.status).toBe('running');
    expect(snap.monitor!.runId).toBe('r1');
    expect(snap.monitor!.stdoutLines).toBe(5);
    expect(snap.monitor!.msSinceLastStdout).toBe(1_500);
    p.dispose();
  });

  it('terminal monitor states render snapshot.monitor === null', async () => {
    const monitor = makeFakeMonitor({
      initial: buildMonitorState({ status: 'completed' })
    });
    const p = new StateProjector({
      store, audit, ownerId: 'this-window', debounceMs: 100, monitor
    });
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.monitor).toBeNull();
    p.dispose();
  });

  it('forwards workflow paused/resumed transitions to the monitor exactly once', async () => {
    vi.useFakeTimers();
    const monitor = makeFakeMonitor({ initial: buildMonitorState({ status: 'running' }) });
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    const p = new StateProjector({
      store, audit, ownerId: 'this-window', debounceMs: 100, monitor
    });
    p.start();
    await vi.advanceTimersByTimeAsync(120);
    await store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), status: 'paused' }, unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);
    expect(monitor.pausedCalls).toBe(1);
    await store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), status: 'running' }, unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);
    expect(monitor.resumedCalls).toBe(1);
    p.dispose();
  });
});

describe('StateProjector history projection (T045)', () => {
  function makeFakeHistory(initial: ReadonlyArray<unknown> = []) {
    let entries: ReadonlyArray<unknown> = initial;
    const listeners: Array<() => void> = [];
    return {
      list: () => entries as never,
      subscribe: (cb: () => void) => {
        listeners.push(cb);
        return { dispose: () => { /* noop */ } };
      },
      setEntries: (next: ReadonlyArray<unknown>) => {
        entries = next;
        for (const l of listeners) l();
      }
    };
  }

  it('snapshot.history === [] when history is null/empty', () => {
    const p = makeProjector();
    p.start();
    expect(p.getCurrentSnapshot().history).toEqual([]);
    p.dispose();
  });

  it('projects history entries from the store', () => {
    const entry = {
      runId: 'r1',
      featureId: 'f1',
      descriptionPreview: 'demo',
      terminalStatus: 'completed' as const,
      startedAt: '2026-05-10T12:00:00.000Z',
      completedAt: '2026-05-10T12:01:00.000Z',
      durationMs: 60_000,
      lastErrorSummary: null,
      auditLogPointer: '.schegent/audit.log'
    };
    const history = makeFakeHistory([entry]);
    const p = new StateProjector({
      store, audit, ownerId: 'this-window', debounceMs: 100, history
    });
    p.start();
    expect(p.getCurrentSnapshot().history).toHaveLength(1);
    expect(p.getCurrentSnapshot().history[0]?.runId).toBe('r1');
    p.dispose();
  });

  it('projects history reverse-chronologically', () => {
    function entryAt(runId: string, completedIso: string) {
      return {
        runId,
        featureId: 'f',
        descriptionPreview: 'demo',
        terminalStatus: 'completed' as const,
        startedAt: completedIso,
        completedAt: completedIso,
        durationMs: 1_000,
        lastErrorSummary: null,
        auditLogPointer: '.schegent/audit.log'
      };
    }
    // history.list() returns reverse-chrono (HistoryStore handles ordering); the
    // projector preserves whatever order the store provides.
    const newest = entryAt('r-newest', '2026-05-10T12:30:00.000Z');
    const middle = entryAt('r-middle', '2026-05-10T12:15:00.000Z');
    const oldest = entryAt('r-oldest', '2026-05-10T12:00:00.000Z');
    const history = makeFakeHistory([newest, middle, oldest]);
    const p = new StateProjector({
      store, audit, ownerId: 'this-window', debounceMs: 100, history
    });
    p.start();
    const projected = p.getCurrentSnapshot().history;
    expect(projected.map((h) => h.runId)).toEqual(['r-newest', 'r-middle', 'r-oldest']);
    p.dispose();
  });
});

describe('StateProjector extended QueueItem projection (T035)', () => {
  it('projects retryCount, lastErrorSummary, pausedReason, startedAt, updatedAt, completedAt for queue items', async () => {
    const failedReq: FeatureRequest = {
      id: 'q-failed',
      description: 'broken',
      enqueuedAt: 1_000_000,
      createdAt: 1_000_000,
      startedAt: 1_000_500,
      updatedAt: 1_001_000,
      completedAt: 1_001_000,
      status: 'failed',
      position: 0,
      runId: 'r-failed',
      retryCount: 2,
      lastError: 'invocation failed: spec parse error',
      pausedReason: null
    };
    const queue: QueueState = {
      requests: [failedReq],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 0,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await store.setQueue(queue);
    const p = makeProjector();
    p.start();
    const recent = p.getCurrentSnapshot().queue.recent;
    const item = recent.find((q) => q.id === 'q-failed');
    expect(item).toBeDefined();
    expect(item!.retryCount).toBe(2);
    expect(item!.lastErrorSummary).toBe('invocation failed: spec parse error');
    expect(item!.pausedReason).toBeNull();
    expect(item!.startedAt).toBe(new Date(1_000_500).toISOString());
    expect(item!.updatedAt).toBe(new Date(1_001_000).toISOString());
    expect(item!.completedAt).toBe(new Date(1_001_000).toISOString());
    p.dispose();
  });

  it('sanitizes lastError through SanitizedLogger before projecting', async () => {
    const reqWithSecret: FeatureRequest = {
      id: 'q-sec',
      description: 'auth task',
      enqueuedAt: 1_000_000,
      createdAt: 1_000_000,
      startedAt: 1_000_500,
      updatedAt: 1_001_000,
      completedAt: 1_001_000,
      status: 'failed',
      position: 0,
      runId: 'r-sec',
      retryCount: 0,
      lastError: 'token leaked: sk-ant-abc1234567890XYZdef9876543210ABCD',
      pausedReason: null
    };
    await store.setQueue({
      requests: [reqWithSecret],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 0,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    });
    const p = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      debounceMs: 100,
      logger: new SanitizedLogger()
    });
    p.start();
    const item = p.getCurrentSnapshot().queue.recent.find((q) => q.id === 'q-sec');
    expect(item!.lastErrorSummary).toContain('[REDACTED]');
    expect(item!.lastErrorSummary).not.toContain('sk-ant-abc1234567890');
    p.dispose();
  });

  it('sets currentPhase only on the in-flight item, matching run.currentPhase', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: 'run-x',
      featureId: 'q-active',
      featureDir: 'specs/777-x',
      status: 'running',
      currentPhase: 'speckit-tasks',
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
      resumeTargetPhaseId: null
    },
      unfencedCommit('test-fixture')
    );
    const inFlight: FeatureRequest = {
      id: 'q-active',
      description: 'busy',
      enqueuedAt: 1_000_000,
      createdAt: 1_000_000,
      startedAt: 1_000_500,
      updatedAt: 1_000_500,
      completedAt: null,
      status: 'in-flight',
      position: 0,
      runId: 'run-x',
      retryCount: 0,
      lastError: null,
      pausedReason: null
    };
    const pending = pendingRequest('q-pending', 'next', 1, 1_000_000);
    await store.setQueue({
      requests: [inFlight, pending],
      inFlightId: 'q-active',
      paused: false,
      pausedReason: null,
      updatedAt: 0,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    });
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.queue.inFlight?.currentPhase).toBe('speckit-tasks');
    expect(snap.queue.pending[0]?.currentPhase).toBeNull();
    p.dispose();
  });

  it('keeps currentPhase null when there is an in-flight item but no run yet', async () => {
    const inFlight = inFlightRequest('q-active', 'busy');
    await store.setQueue({
      requests: [inFlight],
      inFlightId: 'q-active',
      paused: false,
      pausedReason: null,
      updatedAt: 0,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    });
    const p = makeProjector();
    p.start();
    expect(p.getCurrentSnapshot().queue.inFlight?.currentPhase).toBeNull();
    p.dispose();
  });
});

describe('StateProjector dynamic pipelines (T046, T050, US3)', () => {
  function makePhaseDef(id: string): {
    id: string;
    name: string;
    instruction: string;
  } {
    return {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      instruction: `Run ${id}`
    };
  }

  it('derives phases.length from run.pipeline.phases.length with a 12-phase fixture (T046)', async () => {
    const phaseIds = [
      'speckit-specify',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
      'p9',
      'p10',
      'p11',
      'finalize'
    ];
    const pipelinePhases = phaseIds.map((id) => makePhaseDef(id));
    const run: WorkflowRun = {
      ...sampleRun(),
      currentPhase: 'p3' as never,
      pipeline: {
        id: 'large',
        name: 'Large Pipeline',
        phases: pipelinePhases
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phases).toHaveLength(12);
    expect(runtimeOf(snap).phases.map((t) => t.name)).toEqual(phaseIds);
    p.dispose();
  });

  it('sets activePipeline when run.pipeline.id !== "standard" (T046)', async () => {
    const run: WorkflowRun = {
      ...sampleRun(),
      pipeline: {
        id: 'security',
        name: 'Security Audit',
        phases: [makePhaseDef('speckit-specify'), makePhaseDef('speckit-plan'), makePhaseDef('finalize')]
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runOf(snap)?.pipeline).toBeDefined();
    expect(runOf(snap)?.pipeline!.id).toBe('security');
    expect(runOf(snap)?.pipeline!.name).toBe('Security Audit');
    p.dispose();
  });

  // Feature 098 (FR-008) — the projection carried `run.pipeline.id !== 'standard'`,
  // suppressing the name of any Run whose Pipeline happened to be called that.
  // `standard` was a built-in id; with the catalog runtime-only it is an ordinary
  // string an operator may put on an ordinary Pipeline, and suppressing its name
  // leaves the header blank for no reason the operator can see.
  it('names an imported pipeline even when the operator called it "standard"', async () => {
    const run: WorkflowRun = {
      ...sampleRun(),
      pipeline: {
        id: 'standard',
        name: 'Standard Review',
        phases: [makePhaseDef('speckit-specify'), makePhaseDef('finalize')]
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runOf(snap)?.pipeline).toBeDefined();
    expect(runOf(snap)?.pipeline!.id).toBe('standard');
    expect(runOf(snap)?.pipeline!.name).toBe('Standard Review');
    p.dispose();
  });

  it('omits activePipeline (or marks built-in) when run.pipeline.id === "speckit-new-feature" (T046)', async () => {
    const standardPhases = [
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ].map((id) => makePhaseDef(id));
    const run: WorkflowRun = {
      ...sampleRun(),
      pipeline: {
        id: 'speckit-new-feature',
        name: 'Standard',
        phases: standardPhases
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    // For the built-in pipeline, the run's pipeline may be undefined or carry id
    // 'standard'; accept either, but never surface a custom name.
    const pipeline = runOf(snap)?.pipeline;
    if (pipeline) {
      expect(pipeline.id).toBe('speckit-new-feature');
    }
    expect(runtimeOf(snap).phases).toHaveLength(7);
    p.dispose();
  });

  it('marks loopable phases via tile.isLoopPhase helper implicitly via phase name (T046, T050)', async () => {
    const pipelinePhases = [
      makePhaseDef('speckit-specify'),
      makePhaseDef('speckit-clarify'),
      makePhaseDef('speckit-plan'),
      makePhaseDef('speckit-analyze'),
      makePhaseDef('finalize')
    ];
    const run: WorkflowRun = {
      ...sampleRun(),
      pipeline: {
        id: 'speckit-new-feature',
        name: 'Standard',
        phases: pipelinePhases
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    const byName = new Map(runtimeOf(snap).phases.map((t) => [t.name, t]));
    expect(byName.get('speckit-clarify')).toBeDefined();
    expect(byName.get('speckit-analyze')).toBeDefined();
    expect(byName.get('speckit-specify')).toBeDefined();
    p.dispose();
  });

  // Feature 098 (T055, FR-030/FR-033) — the inverse of what T050 pinned. This
  // case used to assert that a Run carrying no Pipeline snapshot projected the
  // seven built-in tiles; there are no built-in tiles to fall back to, and
  // inventing a Phase list for a Run that never declared one is the fail-open
  // FR-033 forbids. The strip is empty, and it stays empty rather than being
  // filled from somewhere the operator did not import.
  //
  // A Run in this shape is degenerate rather than legacy now — every Run freezes
  // a Pipeline at creation — so the record is built here instead of coming from
  // `sampleRun()`, which carries one.
  it('projects no tiles for a run carrying no pipeline snapshot (T055)', async () => {
    const noPipelineRun: WorkflowRun = { ...sampleRun(), pipeline: undefined };
    expect(noPipelineRun.pipeline).toBeUndefined();
    await store.setRun(DEFAULT_QUEUE_ID, noPipelineRun, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runtimeOf(snap).phases).toEqual([]);
    p.dispose();
  });

  it('marks the active phase in a custom pipeline (T046)', async () => {
    const run: WorkflowRun = {
      ...sampleRun(),
      currentPhase: 'security-audit' as never,
      pipeline: {
        id: 'security',
        name: 'Security',
        phases: [makePhaseDef('speckit-specify'), makePhaseDef('security-audit'), makePhaseDef('finalize')]
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    const activeTile = runtimeOf(snap).phases.find((t) => t.name === 'security-audit');
    expect(activeTile?.state).toBe('active');
    p.dispose();
  });

  it('marks completed tiles for a custom pipeline using phasesCompleted (T046)', async () => {
    const run: WorkflowRun = {
      ...sampleRun(),
      currentPhase: 'security-audit' as never,
      phasesCompleted: [
        {
          phase: 'speckit-specify' as never,
          iteration: 1,
          startedAt: 1,
          endedAt: 2,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ],
      pipeline: {
        id: 'security',
        name: 'Security',
        phases: [makePhaseDef('speckit-specify'), makePhaseDef('security-audit'), makePhaseDef('finalize')]
      }
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await ownRun();
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    const specifyTile = runtimeOf(snap).phases.find((t) => t.name === 'speckit-specify');
    expect(specifyTile?.state).toBe('completed');
    p.dispose();
  });
});
