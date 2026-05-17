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
// - successful start → started, controller.startNew called once
// - successful enqueue → enqueued exactly once

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardedRunService } from '../../../src/services/guarded-run-service';
import { QueueManager } from '../../../src/queue/queue-manager';
import {
  WorkspaceLockManager,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler
} from '../../../src/state/lock';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { PipelineCatalog, PipelineDef } from '../../../src/config/pipeline-config';

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
    models: [],
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
}

function makeController(initialRunning = false): FakeController {
  const c: FakeController = {
    running: initialRunning,
    startNew: vi.fn()
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
  workspaceRoot: string;
  clock: MutableClock;
  ownerId: string;
}

async function makeHarness(opts?: {
  ownerId?: string;
  controllerRunning?: boolean;
  cliPath?: string;
  withScaffolding?: boolean;
  catalog?: PipelineCatalog;
}): Promise<Harness> {
  const ownerId = opts?.ownerId ?? 'self-window';
  const controller = makeController(opts?.controllerRunning ?? false);
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new MutableClock(1_000_000);
  const lock = new WorkspaceLockManager(store, ownerId, clock, noopScheduler);

  // Workspace root with .specify/ scaffolding so assertScaffoldingPresent passes.
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-grs-test-'));
  if (opts?.withScaffolding !== false) {
    fs.mkdirSync(path.join(workspaceRoot, '.specify'), { recursive: true });
  }

  const logger = makeLogger();
  const audit = makeAudit();
  const cliPath = opts?.cliPath ?? process.execPath; // node binary, X_OK guaranteed

  const service = new GuardedRunService({
    lock,
    queue,
    controller: controller as unknown as import('../../../src/controller/workflow-controller').SchegentWorkflowController,
    logger: logger as unknown as import('../../../src/lib/logger').SanitizedLogger,
    audit: audit as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
    store,
    cliPathProvider: () => cliPath,
    workspaceRoot,
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
    workspaceRoot,
    clock,
    ownerId
  };
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

let createdRoots: string[] = [];

afterEach(() => {
  for (const r of createdRoots) cleanupRoot(r);
  createdRoots = [];
});

async function trackedHarness(opts?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
  const h = await makeHarness(opts);
  createdRoots.push(h.workspaceRoot);
  return h;
}

describe('GuardedRunService.scheduleOrEnqueue (FR-006/FR-007/FR-008)', () => {
  it('rejects with rejected-foreign-lock when a fresh foreign lock is present', async () => {
    const h = await trackedHarness();
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
    expect(h.store.getQueue().requests).toHaveLength(0);
    expect(h.audit.append).toHaveBeenCalledTimes(1);
  });

  it('allows enqueue when foreign lock has expired (older than staleness threshold)', async () => {
    const h = await trackedHarness();
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
    expect(h.store.getQueue().requests).toHaveLength(1);
  });

  it('rejects with rejected-paused when the queue is paused', async () => {
    const h = await trackedHarness();
    await h.queue.setPaused(true, 'operator-paused');

    const result = await h.service.scheduleOrEnqueue({
      description: 'feature x',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });

    expect(result.outcome).toBe('rejected-paused');
    expect(h.store.getQueue().requests).toHaveLength(0);
    expect(h.audit.append).toHaveBeenCalledTimes(1);
  });

  it('enqueues a new item behind the in-flight one when controller is running and lock is held by self', async () => {
    const h = await trackedHarness({ controllerRunning: true });
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
    expect(h.store.getQueue().requests).toHaveLength(2);
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  // Feature 017 — BUG-003 regression. Operator submission via Dashboard /
  // Command Palette routes through `scheduleOrEnqueue` and MUST persist
  // the new FeatureRequest as `pending` even when `controller.running`
  // is true. The legacy `'rejected-already-running'` outcome MUST NOT
  // be returned on a `controller.running` basis.
  it('accepts submissions via `dashboard-submit` while the controller is running and never returns rejected-already-running', async () => {
    const h = await trackedHarness({ controllerRunning: true });
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
      .getQueue()
      .requests.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.description).toBe('second');
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('rejects empty descriptions with rejected-validation', async () => {
    const h = await trackedHarness();
    const result = await h.service.scheduleOrEnqueue({
      description: '   ',
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('description-empty');
    expect(h.store.getQueue().requests).toHaveLength(0);
  });

  it('rejects descriptions exceeding the 32k cap with rejected-validation', async () => {
    const h = await trackedHarness();
    const tooLong = 'x'.repeat(33_000);
    const result = await h.service.scheduleOrEnqueue({
      description: tooLong,
      scheduledAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('description-too-long');
    expect(h.store.getQueue().requests).toHaveLength(0);
  });
});

describe('GuardedRunService.startNow (FR-006/FR-009/FR-010)', () => {
  it('starts the controller and acquires the lock when inputs are valid', async () => {
    const h = await trackedHarness();

    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });

    expect(result.outcome).toBe('started');
    expect(result.runId).toBeTruthy();
    expect(result.feature?.description).toBe('do thing');
    // Lock acquired by self; controller.startNew called exactly once.
    expect(h.lock.isHeld()).toBe(true);
    expect(h.controller.startNew).toHaveBeenCalledTimes(1);
    // Queue mutated with exactly one new feature.
    expect(h.store.getQueue().requests).toHaveLength(1);
  });

  it('rejects with rejected-already-running when controller.running is true (defense-in-depth — BUG-003 routes operator paths around this)', async () => {
    // Feature 017 — BUG-003. This branch is now defense-in-depth only.
    // Production paths (Dashboard `CMD_START`, Command Palette
    // `schegent.auto`) dispatch through `runEnqueue()` →
    // `scheduleOrEnqueue()` so this `startNow()` path is unreachable
    // from operator input. The check remains so future internal callers
    // can not accidentally call `startNew()` mid-run.
    const h = await trackedHarness({ controllerRunning: true });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-already-running');
    // Lock must NOT be acquired by us when we reject due to controller-running.
    expect(h.lock.isHeld()).toBe(false);
    expect(h.controller.startNew).not.toHaveBeenCalled();
    expect(h.store.getQueue().requests).toHaveLength(0);
  });

  it('rejects with rejected-foreign-lock when a fresh foreign lock is present and does NOT acquire the lock', async () => {
    const h = await trackedHarness();
    const now = h.clock.now();
    await h.store.setLock({
      ownerId: 'other-window',
      acquiredAt: now - 1_000,
      heartbeatAt: now - 1_000
    });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: now,
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-foreign-lock');
    // Foreign lock must remain on record; we never overwrote it.
    expect(h.store.getLock()?.ownerId).toBe('other-window');
    expect(h.controller.startNew).not.toHaveBeenCalled();
    expect(h.store.getQueue().requests).toHaveLength(0);
  });

  it('rejects with rejected-validation on early-validation failure WITHOUT acquiring the lock (FR-010)', async () => {
    const h = await trackedHarness();
    // Early-validation failure: empty description.
    const result = await h.service.startNow({
      description: '',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('description-empty');
    // FR-010: lock must not be held after a rejected outcome.
    expect(h.store.getLock()).toBeNull();
    expect(h.lock.isHeld()).toBe(false);
    expect(h.controller.startNew).not.toHaveBeenCalled();
    expect(h.store.getQueue().requests).toHaveLength(0);
  });

  it('rejects with rejected-validation when the CLI is not available (no lock acquired)', async () => {
    const h = await trackedHarness({
      cliPath: '/this/binary/does/not/exist'
    });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('cli-not-found');
    expect(h.store.getLock()).toBeNull();
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('rejects with rejected-validation when scaffolding is missing (no lock acquired)', async () => {
    const h = await trackedHarness({ withScaffolding: false });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('rejected-validation');
    expect(result.reason).toBe('scaffolding-missing');
    expect(h.store.getLock()).toBeNull();
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('does not double-acquire the lock; lock release is centralized in the controller (FR-009)', async () => {
    const h = await trackedHarness();

    // Spy on lock.tryAcquire and lock.release to count how many times each is called.
    const tryAcquireSpy = vi.spyOn(h.lock, 'tryAcquire');
    const releaseSpy = vi.spyOn(h.lock, 'release');

    const result = await h.service.startNow({
      description: 'feature',
      startedAt: h.clock.now(),
      via: 'command-palette'
    });
    expect(result.outcome).toBe('started');
    // The service acquires once; release is the controller's responsibility,
    // so the service should NOT call release on the success path.
    expect(tryAcquireSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('emits an audit record on every rejection so operators can observe attempted bypasses', async () => {
    const h = await trackedHarness();
    await h.service.startNow({
      description: '',
      startedAt: h.clock.now(),
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
    expect(call.payload.operation).toBe('start');
    expect(call.payload.outcome).toBe('rejected-validation');
  });
});

describe('GuardedRunService — pipelineId & rerun (T020/T021/T022)', () => {
  it('startNow preserves pipelineId on the enqueued FeatureRequest', async () => {
    const h = await trackedHarness({
      catalog: makeCatalog(['speckit-default', 'fast-fix'])
    });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'command-palette',
      pipelineId: 'fast-fix'
    });
    expect(result.outcome).toBe('started');
    expect(result.feature?.pipelineId).toBe('fast-fix');
  });

  it('scheduleOrEnqueue rejects an unknown pipelineId with rejected-validation', async () => {
    const h = await trackedHarness({
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
    expect(h.store.getQueue().requests).toHaveLength(0);
  });

  it('startNow preserves the rerun block on the enqueued FeatureRequest', async () => {
    const h = await trackedHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
      via: 'rerun-from-history',
      pipelineId: 'speckit-default',
      rerun: {
        originalRunId: 'run-prev',
        originalDescription: 'do thing',
        reason: 'manual'
      }
    });
    expect(result.outcome).toBe('started');
    expect(result.feature?.rerun).toBeDefined();
    expect(result.feature?.rerun?.originalRunId).toBe('run-prev');
    expect(result.feature?.rerun?.reason).toBe('manual');
  });

  it('rejects rerun without pipelineId (T022 invariant: rerun-requires-pipeline-id)', async () => {
    const h = await trackedHarness({
      catalog: makeCatalog(['speckit-default'])
    });
    const result = await h.service.startNow({
      description: 'do thing',
      startedAt: h.clock.now(),
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
    // Lock must NOT be acquired on early-validation rejection.
    expect(h.store.getLock()).toBeNull();
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('rejects rerun with an invalid reason value', async () => {
    const h = await trackedHarness({
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
    const h = await trackedHarness();
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
