// Feature 065 — Shared helpers for User Story 1..5 integration tests
// (T024 / T024a / T024b / T030 / T034 / T035 / T039 / T043 / T049 ... ).
//
// Provides:
//   • `FakeMemento` (in-memory VS Code Memento)
//   • `MutableClock` (deterministic time for the host services)
//   • `AuditLogCapture` (records `AuditLogWriter.append` calls)
//   • `FakeController` (records `admitNew` invocations; never spawns CLI)
//   • `FakeScheduledStartCoordinator` (records arm/cancel; integrates with
//     a fake setTimeout so tests can assert audit events deterministically)
//   • `makeHarness()` — wires `WorkspaceStateStore` + `QueueManager` +
//     `GuardedRunService` + `ScheduledStartCoordinator` + `AutoDrainCoordinator`
//
// Each helper is intentionally side-effect-free at module import time.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import {
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import {
  WorkspaceLockManager,
  type Clock,
  type Scheduler
} from '../../src/state/lock';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import {
  ScheduledStartCoordinator
} from '../../src/services/scheduled-start-coordinator';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import type { AuditEntry } from '../../src/audit/audit-entry';
import type { PipelineCatalog, PipelineDef } from '../../src/config/pipeline-config';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { SanitizedLogger } from '../../src/lib/logger';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';

export class FakeMemento implements Memento {
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

export class MutableClock implements Clock {
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

export const noopScheduler: Scheduler = {
  setInterval(_fn, _ms) {
    return { clear() {} };
  }
};

export function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    sanitize: vi.fn((s: string) => s)
  };
}

export interface AuditLogCapture {
  readonly append: (entry: Omit<AuditEntry, 'occurredAt'>) => Promise<AuditEntry>;
  readonly entries: AuditEntry[];
  byType(eventType: string): AuditEntry[];
}

export function makeAuditCapture(): AuditLogCapture {
  const entries: AuditEntry[] = [];
  const capture: AuditLogCapture = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'occurredAt'>) => {
      const full = {
        ...entry,
        occurredAt: ((entry as unknown as { payload?: { occurredAt?: number } }).payload?.occurredAt as number | undefined) ?? Date.now()
      } as AuditEntry;
      entries.push(full);
      return full;
    }),
    entries,
    byType(eventType: string) {
      return entries.filter((e) => e.eventType === eventType);
    }
  };
  return capture;
}

export interface FakeController {
  /**
   * Still here after feature 093 (T082) because `GuardedRunService.startNow()`
   * reads it — its own defense-in-depth guard, a different site from the drain
   * step 4b that T081 deleted. The drain no longer consults it at all.
   */
  running: boolean;
  /**
   * Feature 093 (T082) — the execution-capacity gate (drain step 4) reads the
   * sessions the window owns. These Runs are never driven and never terminate,
   * so every admission stays live and the count is the admission count.
   */
  liveRunCount: number;
  /**
   * Feature 093 (T049a) — the drain calls `admitNew`, which resolves once the
   * Task is in flight and returns the promise of the Run's execution. Assertions
   * in this suite are all about *whether* a start happened, so the drive is an
   * already-resolved promise and nothing else changes.
   */
  admitNew: ReturnType<typeof vi.fn>;
  admitResume: ReturnType<typeof vi.fn>;
  getCatalog?: () => PipelineCatalog | null | undefined;
}

export function makeController(initial?: { running?: boolean; catalog?: PipelineCatalog }): FakeController {
  const c: FakeController = {
    running: initial?.running ?? false,
    liveRunCount: 0,
    admitNew: vi.fn(),
    admitResume: vi.fn(),
    getCatalog: () => initial?.catalog ?? null
  };
  c.admitNew.mockImplementation(async () => {
    c.liveRunCount++;
    return { completed: Promise.resolve() };
  });
  c.admitResume.mockResolvedValue({ resumed: false, completed: Promise.resolve() });
  return c;
}

export function makeCatalog(pipelineIds: readonly string[] = ['default']): PipelineCatalog {
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

export interface FakeTimer {
  scheduledFireAt: number;
  fn: () => void;
  cleared: boolean;
}

export interface FakeTimerControl {
  readonly timers: FakeTimer[];
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (handle: NodeJS.Timeout) => void;
  fireDue: (now: number) => void;
}

export function makeFakeTimerControl(clock: MutableClock): FakeTimerControl {
  const timers: FakeTimer[] = [];
  let nextHandle = 1;
  const handleToTimer = new Map<number, FakeTimer>();
  const ctrl: FakeTimerControl = {
    timers,
    setTimer: (fn, ms) => {
      const t: FakeTimer = {
        scheduledFireAt: clock.now() + ms,
        fn,
        cleared: false
      };
      timers.push(t);
      const handle = nextHandle++ as unknown as NodeJS.Timeout;
      handleToTimer.set(handle as unknown as number, t);
      return handle;
    },
    clearTimer: (handle) => {
      const t = handleToTimer.get(handle as unknown as number);
      if (t) t.cleared = true;
    },
    fireDue: (now) => {
      // Find the earliest non-cleared timer that's due.
      // Sort so we fire in chronological order in case multiple are pending.
      const due = timers
        .filter((t) => !t.cleared && t.scheduledFireAt <= now)
        .sort((a, b) => a.scheduledFireAt - b.scheduledFireAt);
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        t.fn();
      }
    }
  };
  return ctrl;
}

export interface Harness {
  readonly memento: FakeMemento;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  readonly controller: FakeController;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly audit: AuditLogCapture;
  readonly clock: MutableClock;
  readonly fakeTimer: FakeTimerControl;
  readonly service: GuardedRunService;
  readonly coordinator: ScheduledStartCoordinator;
  readonly autoDrain: AutoDrainCoordinator;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  cleanup: () => void;
}

export async function makeHarness(opts: {
  ownerId?: string;
  initialNow?: number;
  catalog?: PipelineCatalog;
  withScaffolding?: boolean;
  /**
   * FR-R3-070 — lets a test model a competing window holding the workspace
   * lock. Wired through to the coordinator's foreign-lock probe; undefined
   * keeps the pre-existing single-window behaviour.
   */
  isForeignLockHeld?: () => boolean;
} = {}): Promise<Harness> {
  const ownerId = opts.ownerId ?? 'self-window';
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new MutableClock(opts.initialNow ?? 1_700_000_000_000);
  const lock = new WorkspaceLockManager(store, ownerId, clock, noopScheduler);

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-065-it-'));
  if (opts.withScaffolding !== false) {
    fs.mkdirSync(path.join(workspaceRoot, '.specify'), { recursive: true });
  }

  const logger = makeLogger();
  const audit = makeAuditCapture();
  const fakeTimer = makeFakeTimerControl(clock);
  const catalog = opts.catalog ?? makeCatalog(['default']);
  const controller = makeController({ catalog });

  const autoDrain = new AutoDrainCoordinator({
    store,
    queue,
    executionLease: new ExecutionLeaseManager(store, lock.id, clock, noopScheduler),
    controller: controller as unknown as SchegentWorkflowController
  });

  const coordinator = new ScheduledStartCoordinator({
    store,
    auditWriter: audit as unknown as Pick<AuditLogWriter, 'append'>,
    logger: logger as unknown as Pick<SanitizedLogger, 'warn'>,
    onFire: async (queueId) => {
      // After firing, the host transitions the queue lifecycle out of
      // `idle-pending` to mimic real behavior. Tests can override via
      // queue state mutations directly when needed.
      //
      // FR-R3-002 (T289) — every read and write here names `queueId`. This
      // handler used to address `'default'` and discard the fired id with a
      // `void queueId`, which is seam 2 of FUNC-02 reproduced in scaffolding:
      // a schedule armed on queue B promoted queue A. It compiled and stayed
      // green only because a single-queue harness makes the two the same id.
      const cur = store.getQueue(queueId);
      if (cur.queueLifecycle === 'idle-pending') {
        await store.setQueue({
          ...cur,
          queueLifecycle: 'running',
          pauseSource: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: clock.now()
        }, queueId);
      }
      // Drain whatever is pending on the queue that fired.
      await autoDrain.drainIfIdle(queueId);
    },
    now: () => clock.now(),
    setTimer: fakeTimer.setTimer,
    clearTimer: fakeTimer.clearTimer,
    ...(opts.isForeignLockHeld ? { isForeignLockHeld: opts.isForeignLockHeld } : {})
  });

  const service = new GuardedRunService({
    // FR-R3-136 (FR-008) — this suite exercises a trusted workspace; the
    // untrusted rows live in the trust-specific describe block.
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller: controller as unknown as SchegentWorkflowController,
    logger: logger as unknown as SanitizedLogger,
    audit: audit as unknown as AuditLogWriter,
    store,
    clock: () => clock.now(),
    catalogProvider: () => catalog,
    scheduledStartCoordinator: coordinator
  });

  // Feature 065 — wire the pause/resume hooks so integration tests
  // exercise the lifecycle transitions through the same code path as
  // production.
  queue.setScheduledStartCancelHook({
    cancel: (queueId, reason) => coordinator.cancel(queueId, reason)
  });
  queue.setLifecycleAuditHook({
    append: (entry) => audit.append(entry as never)
  });

  return {
    memento,
    store,
    queue,
    lock,
    controller,
    logger,
    audit,
    clock,
    fakeTimer,
    service,
    coordinator,
    autoDrain,
    workspaceRoot,
    ownerId,
    cleanup() {
      try {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
      coordinator.dispose();
    }
  };
}
