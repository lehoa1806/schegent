// Unit tests for GuardedRunService (T012 / FR-006..FR-010).
//
// Covers contract obligations from
// `specs/007-principal-review-remediation/contracts/guarded-run-service.md`:
// - schedule-while-foreign-fresh-lock → rejected-foreign-lock
// - schedule-while-paused → rejected-paused
// - schedule-while-running (lock held by self) → enqueued
// - start-while-running → rejected-already-running (defense-in-depth;
//   operator entry points are wired through scheduleOrEnqueue per
//   feature 017 BUG-003 / FR-036)
// - early-validation failure → rejected-validation, lock NOT acquired
// - successful enqueue → enqueued exactly once

import { describe, expect, it, vi } from 'vitest';
import { GuardedRunService } from '../../../src/services/guarded-run-service';
import { QueueManager } from '../../../src/queue/queue-manager';
import {
  WorkspaceLockManager,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler
} from '../../../src/state/lock';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type {
  PipelineCatalog,
  PipelineDef
} from '../../../src/config/pipeline-config';

function makeCatalog(pipelineIds: readonly string[]): PipelineCatalog {
  const pipelines: PipelineDef[] = pipelineIds.map((id) => ({
    id,
    name: id,
    phases: ['speckit-specify']
  }));
  const pipelinesById = new Map<string, PipelineDef>();
  for (const p of pipelines) pipelinesById.set(p.id, p);
  return {
    phases: [],
    pipelines,
    models: { claude: [], codex: [], agy: [] },
    defaultPipelineId: pipelineIds[0] ?? 'default',
    phasesById: new Map(),
    pipelinesById
  };
}

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

const noopScheduler: Scheduler = {
  setInterval(_fn, _ms) {
    return { clear() {} };
  }
};

class MutableClock implements Clock {
  private t: number;
  constructor(initial: number) {
    this.t = initial;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(delta: number): void {
    this.t += delta;
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    sanitize: vi.fn((s: string) => s)
  };
}

function makeAudit() {
  return {
    append: vi.fn(async () => ({}) as unknown as import('../../../src/audit/audit-entry').AuditEntry)
  };
}

interface FakeController {
  running: boolean;
  startNew: ReturnType<typeof vi.fn>;
  getCatalog: ReturnType<typeof vi.fn>;
}

function makeController(
  initialRunning = false,
  catalog: PipelineCatalog = makeCatalog(['speckit-default'])
): FakeController {
  const c: FakeController = {
    running: initialRunning,
    startNew: vi.fn(),
    getCatalog: vi.fn(() => catalog)
  };
  c.startNew.mockResolvedValue(undefined);
  return c;
}

interface Harness {
  store: WorkspaceStateStore;
  queue: QueueManager;
  lock: WorkspaceLockManager;
  controller: FakeController;
  logger: ReturnType<typeof makeLogger>;
  audit: ReturnType<typeof makeAudit>;
  service: GuardedRunService;
  clock: MutableClock;
  ownerId: string;
}

async function makeHarness(opts?: {
  ownerId?: string;
  controllerRunning?: boolean;
  catalog?: PipelineCatalog;
}): Promise<Harness> {
  const ownerId = opts?.ownerId ?? 'self-window';
  const controller = makeController(opts?.controllerRunning ?? false, opts?.catalog);
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new MutableClock(1_000_000);
  const lock = new WorkspaceLockManager(store, ownerId, clock, noopScheduler);

  const logger = makeLogger();
  const audit = makeAudit();

  const service = new GuardedRunService({
    lock,
    queue,
    controller: controller as unknown as import('../../../src/controller/workflow-controller').SchegentWorkflowController,
    logger: logger as unknown as import('../../../src/lib/logger').SanitizedLogger,
    audit: audit as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
    store,
    clock: () => clock.now(),
    ...(opts?.catalog ? { catalogProvider: () => opts.catalog as PipelineCatalog } : {})
  });

  return {
    store,
    queue,
    lock,
    controller,
    logger,
    audit,
    service,
    clock,
    ownerId
  };
}

describe('GuardedRunService.scheduleOrEnqueue (FR-006/FR-007/FR-008)', () => {
  it('rejects with rejected-foreign-lock when a fresh foreign lock is present', async () => {
    const h = await makeHarness();
    const now = h.clock.now();
    await h.store.setLock({
      ownerId: 'other-window',
      acquiredAt: now - 1_000,
      heartbeatAt: now - 1_000 // fresh: age (1s) < STALENESS_THRESHOLD_MS
    });

    const result = await h.service.scheduleOrEnqueue({
      description: 'feature x',
      scheduledAt: now,
      via: 'command-palette'
    });

    expect(result.outcome).toBe('rejected-foreign-lock');
    expect(result.reason).toMatch(/foreign-fresh:other-window/);
    expect(h.store.getQueue('default').requests).toHaveLength(0);
    expect(h.audit.append).toHaveBeenCalledTimes(1);
  });

  it('allows enqueue when foreign lock has expired (older than staleness threshold)', async () => {
    const h = await makeHarness();
    const now = h.clock.now();
    await h.store.setLock({
      ownerId: 'other-window',
      acquiredAt: now - STALENESS_THRESHOLD_MS - 5_000,
      heartbeatAt: now - STALENESS_THRESHOLD_MS - 5_000 // stale
    });

    const result = await h.service.scheduleOrEnqueue({
      description: 'feature x',
      scheduledAt: now,
      via: 'command-palette'
    });

    expect(result.outcome).toBe('enqueued');
    expect(h.store.getQueue('default').requests).toHaveLength(1);
  });

  it('rejects with rejected-paused when the queue is paused', async () => {
    const h = await makeHarness();
    await h.queue.setQueuePausedState(true, undefined, 'operator-paused', 'operator');

    const result = await h.service.scheduleOrEnqueue({
      description: 'feature x',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });

    expect(result.outcome).toBe('rejected-paused');
    expect(h.store.getQueue('default').requests).toHaveLength(0);
    expect(h.audit.append).toHaveBeenCalledTimes(1);
  });

  it('enqueues a new item behind the in-flight one when controller is running and lock is held by self', async () => {
    const h = await makeHarness({ controllerRunning: true });
    // Acquire self lock so foreign-lock check passes.
    const acquired = await h.lock.tryAcquire();
    expect(acquired.acquired).toBe(true);
    // Simulate an in-flight item.
    const first = await h.queue.enqueue('first');
    await h.queue.markInFlight(first.id, 'run-1');

    const result = await h.service.scheduleOrEnqueue({
      description: 'second',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });

    expect(result.outcome).toBe('enqueued');
    expect(h.store.getQueue('default').requests).toHaveLength(2);
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  // Feature 017 — BUG-003 regression. Operator submission via Dashboard /
  // Command Palette routes through `scheduleOrEnqueue` and MUST persist
  // the new FeatureRequest as `pending` even when `controller.running`
  // is true. The legacy `'rejected-already-running'` outcome MUST NOT
  // be returned on a `controller.running` basis.
  it('accepts submissions via `dashboard-submit` while the controller is running and never returns rejected-already-running', async () => {
    const h = await makeHarness({ controllerRunning: true });
    const acquired = await h.lock.tryAcquire();
    expect(acquired.acquired).toBe(true);
    const first = await h.queue.enqueue('first');
    await h.queue.markInFlight(first.id, 'run-1');

    const result = await h.service.scheduleOrEnqueue({
      description: 'second',
      scheduledAt: h.clock.now(),
      via: 'dashboard-submit'
    });

    expect(result.outcome).toBe('enqueued');
    expect(result.outcome).not.toBe('rejected-already-running');
    const pending = h.store
      .getQueue('default')
      .requests.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.description).toBe('second');
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('rejects empty descriptions with rejected-validation', async () => {
    const h = await makeHarness();
    const result = await h.service.scheduleOrEnqueue({
      description: '   ',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('description-empty');
    expect(h.store.getQueue('default').requests).toHaveLength(0);
  });

  it('rejects descriptions exceeding the 32k cap with rejected-validation', async () => {
    const h = await makeHarness();
    const tooLong = 'x'.repeat(33_000);
    const result = await h.service.scheduleOrEnqueue({
      description: tooLong,
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('description-too-long');
    expect(h.store.getQueue('default').requests).toHaveLength(0);
  });
});

describe('GuardedRunService — rejection auditing', () => {
  // Relocated from the retired `startNow` suite. `emitRejection` is shared, so
  // the payload contract still needs a test; only the operation it reports
  // changed, because `schedule` is now the sole operation the service performs.
  it('emits an audit record on every rejection so operators can observe attempted bypasses', async () => {
    const h = await makeHarness();
    await h.service.scheduleOrEnqueue({
      description: '',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(h.audit.append).toHaveBeenCalled();
    const calls = h.audit.append.mock.calls as unknown as Array<
      Array<{ eventType: string; outcome: string; payload: Record<string, unknown> }>
    >;
    const call = calls[0][0];
    expect(call.eventType).toBe('warning');
    expect(call.outcome).toBe('failure');
    expect(call.payload.source).toBe('guarded-run-service');
    expect(call.payload.operation).toBe('schedule');
    expect(call.payload.outcome).toBe('rejected-validation');
  });
});

describe('GuardedRunService — pipelineId & rerun (T020/T021/T022)', () => {
  it('scheduleOrEnqueue preserves pipelineId on the enqueued FeatureRequest', async () => {
    const h = await makeHarness({
      catalog: makeCatalog(['speckit-default', 'fast-fix'])
    });
    const result = await h.service.scheduleOrEnqueue({
      description: 'do thing',
      scheduledAt: h.clock.now(),
      via: 'command-palette',
      pipelineId: 'fast-fix'
    });
    expect(result.outcome).toBe('enqueued');
    expect(h.store.getQueue('default').requests[0]?.pipelineId).toBe('fast-fix');
  });

  it('scheduleOrEnqueue rejects an unknown pipelineId with rejected-validation', async () => {
    const h = await makeHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.scheduleOrEnqueue({
      description: 'do thing',
      scheduledAt: h.clock.now(),
      via: 'command-palette',
      pipelineId: 'unknown-pipeline'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toMatch(/pipeline-id-unknown:unknown-pipeline/);
    expect(h.store.getQueue('default').requests).toHaveLength(0);
  });

  it('scheduleOrEnqueue preserves the rerun block on the enqueued FeatureRequest', async () => {
    const h = await makeHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.scheduleOrEnqueue({
      description: 'do thing',
      scheduledAt: h.clock.now(),
      via: 'rerun-from-history',
      pipelineId: 'speckit-default',
      rerun: {
        originalRunId: 'run-prev',
        originalDescription: 'do thing',
        reason: 'manual'
      }
    });
    expect(result.outcome).toBe('enqueued');
    const enqueued = h.store.getQueue('default').requests[0];
    expect(enqueued?.rerun).toBeDefined();
    expect(enqueued?.rerun?.originalRunId).toBe('run-prev');
    expect(enqueued?.rerun?.reason).toBe('manual');
  });

  it('rejects rerun without pipelineId (T022 invariant: rerun-requires-pipeline-id)', async () => {
    const h = await makeHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.scheduleOrEnqueue({
      description: 'do thing',
      scheduledAt: h.clock.now(),
      via: 'rerun-from-history',
      // pipelineId deliberately omitted
      rerun: {
        originalRunId: 'run-prev',
        originalDescription: 'do thing',
        reason: 'manual'
      }
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('rerun-requires-pipeline-id');
    // Validation rejects before the queue write; no lock is taken either way.
    expect(h.store.getLock()).toBeNull();
    expect(h.store.getQueue('default').requests).toHaveLength(0);
  });

  it('rejects rerun with an invalid reason value', async () => {
    const h = await makeHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.scheduleOrEnqueue({
      description: 'do thing',
      scheduledAt: h.clock.now(),
      via: 'rerun-from-history',
      pipelineId: 'speckit-default',
      rerun: {
        originalRunId: 'run-prev',
        originalDescription: 'do thing',
        reason: 'bogus' as 'manual'
      }
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('rerun-reason-invalid');
  });
});

describe('GuardedRunService — sanitization', () => {
  it('passes reason strings through logger.sanitize() before returning or auditing', async () => {
    const h = await makeHarness();
    // Inject a foreign lock whose ownerId would be sanitized.
    await h.store.setLock({
      ownerId: 'other-window-sk-secret',
      acquiredAt: h.clock.now() - 1_000,
      heartbeatAt: h.clock.now() - 1_000
    });
    h.logger.sanitize.mockImplementation((s: string) => s.replace('sk-secret', '[REDACTED]'));

    const result = await h.service.scheduleOrEnqueue({
      description: 'feature',
      scheduledAt: h.clock.now(),
      via: 'webview'
    });
    expect(result.outcome).toBe('rejected-foreign-lock');
    expect(result.reason).toContain('[REDACTED]');
    expect(result.reason).not.toContain('sk-secret');
  });
});
