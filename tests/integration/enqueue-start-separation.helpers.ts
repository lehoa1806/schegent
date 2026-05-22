// Feature 065 — Shared helpers for User Story 1..5 integration tests
// (T024 / T024a / T024b / T030 / T034 / T035 / T039 / T043 / T049 ... ).
//
// Provides:
//   • `FakeMemento` (in-memory VS Code Memento)
//   • `MutableClock` (deterministic time for the host services)
//   • `AuditLogCapture` (records `AuditLogWriter.append` calls)
//   • `FakeController` (records `startNew` invocations; never spawns CLI)
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
  running: boolean;
  startNew: ReturnType<typeof vi.fn>;
  getCatalog?: () => PipelineCatalog | null | undefined;
}

export function makeController(initial?: { running?: boolean; catalog?: PipelineCatalog }): FakeController {
  const c: FakeController = {
    running: initial?.running ?? false,
    startNew: vi.fn(),
    getCatalog: () => initial?.catalog ?? null
  };
  c.startNew.mockResolvedValue(undefined);
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
    models: [],
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
    lock,
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
      const cur = store.getQueue();
      if (cur.queueLifecycle === 'idle-pending') {
        await store.setQueue({
          ...cur,
          queueLifecycle: 'running',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: clock.now()
        });
      }
      // Drain whatever is pending.
      await autoDrain.drainIfIdle();
      // Avoid unused-var lint when test never asserts queueId.
      void queueId;
    },
    now: () => clock.now(),
    setTimer: fakeTimer.setTimer,
    clearTimer: fakeTimer.clearTimer
  });

  const service = new GuardedRunService({
    lock,
    queue,
    controller: controller as unknown as SchegentWorkflowController,
    logger: logger as unknown as SanitizedLogger,
    audit: audit as unknown as AuditLogWriter,
    store,
    cliPathProvider: () => process.execPath,
    workspaceRoot,
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
