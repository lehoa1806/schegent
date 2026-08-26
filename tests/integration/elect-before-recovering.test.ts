// FR-R3-070 (feature 152) — the resume path cannot drive a Run another window
// owns, regardless of activation ordering.
//
// The activation-ordering half (elect before installing recovery) is pinned by
// tests/lint/elect-before-recovering.test.ts and exercised in
// tests/unit/extension/activate.test.ts. This file is the composition check for
// the defence-in-depth half: `resumeExistingOnQueue` claims the per-queue
// execution lease before it marks anything in flight, so even a resume that
// slips past ordering (the setImmediate(delay === 0) shape REL-01 reported)
// spawns nothing while a competing window holds the queue.
//
// Two hosts share one ownership registry — the disk arbitration surface — while
// keeping their own mementos, exactly the production topology two VS Code
// windows have on one workspace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { SharedOwnershipFs, OWNERSHIP_DIR } from '../fixtures/state/ownership-harness';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { WorkflowControllerDeps } from '../../src/controller/workflow-controller';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { removeTempRoot } from '../temp-root-cleanup';

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

/** A runner whose every spawn is countable and fails transiently. */
function makeCountingRunner(): { runner: ClaudeCliRunner; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => ({
    stdoutBuffer: (() => {
      const b = new ZippedStreamBuffer();
      b.append('');
      b.finalize();
      return b;
    })(),
    stderrBuffer: (() => {
      const b = new ZippedStreamBuffer();
      b.finalize();
      return b;
    })(),
    exitCode: 1,
    killed: false,
    timedOut: false,
    durationMs: 1
  }));
  return {
    invoke,
    runner: {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner
  };
}

function makeLock(ownerId: string): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(() => true),
    ownerOfRecord: vi.fn(),
    id: ownerId
  } as unknown as WorkspaceLockManager;
}

interface Host {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  invoke: ReturnType<typeof vi.fn>;
}

async function makeHost(
  ownerId: string,
  shared: SharedOwnershipFs,
  workspaceRoot: string
): Promise<Host> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const { runner, invoke } = makeCountingRunner();
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  // The production topology: mementos are per window, arbitration is shared.
  store.useOwnershipStorage(shared, OWNERSHIP_DIR);
  const queue = new QueueManager(store);
  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const deps: WorkflowControllerDeps = { catalog: buildSpeckitCatalog(), auditWriter: audit };
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    makeLock(ownerId),
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000 },
    deps
  );
  return { controller, store, queue, invoke };
}

let tmpA: string;
let tmpB: string;

beforeEach(async () => {
  tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-elect-a-'));
  tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-elect-b-'));
});

afterEach(async () => {
  await removeTempRoot(tmpA);
  await removeTempRoot(tmpB);
});

describe('FR-R3-070 — a resume cannot drive a Run while another window holds the queue', () => {
  it('declines the resume while window A holds the execution lease, and resumes once A releases', async () => {
    const shared = new SharedOwnershipFs();
    const hostB = await makeHost('window-b', shared, tmpB);

    // Window B has a persisted, resumable Run: one real (transiently failing)
    // start, exactly the state an elapsed pendingRetryAt re-arms against.
    const feature = await hostB.queue.enqueue('two-window fixture task');
    await hostB.controller.startNew(feature, null);
    expect(hostB.invoke).toHaveBeenCalledTimes(1);
    expect(hostB.store.getRun(DEFAULT_QUEUE_ID)).not.toBeNull();

    // Window A claims the queue on the shared registry with a fresh heartbeat
    // — a competing window mid-drive on the same checkout.
    const leaseA = new ExecutionLeaseManager(
      await (async () => {
        const storeA = new WorkspaceStateStore(new FakeMemento());
        await storeA.initialize();
        storeA.useOwnershipStorage(shared, OWNERSHIP_DIR);
        return storeA;
      })(),
      'window-a'
    );
    expect((await leaseA.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);

    // The defence in depth: B's resume — the same path activation's elapsed
    // delayed-retry takes — declines instead of spawning a second process.
    const resumedWhileHeld = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumedWhileHeld).toBe(false);
    expect(hostB.invoke).toHaveBeenCalledTimes(1); // still exactly one spawn
    expect(hostB.store.getRun(DEFAULT_QUEUE_ID)!.status).not.toBe('running');

    // A releases; the same resume now proceeds — the decline was contention,
    // not a broken path.
    await leaseA.release(DEFAULT_QUEUE_ID);
    const resumedAfterRelease = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumedAfterRelease).toBe(true);
    expect(hostB.invoke).toHaveBeenCalledTimes(2);
  });

  it('a stale holder does not block the resume (crash recovery keeps working)', async () => {
    const shared = new SharedOwnershipFs();
    const hostB = await makeHost('window-b', shared, tmpB);
    const feature = await hostB.queue.enqueue('stale-holder fixture task');
    await hostB.controller.startNew(feature, null);
    expect(hostB.invoke).toHaveBeenCalledTimes(1);

    // A crashed window left a lease whose heartbeat is far past the 15 s
    // staleness threshold: the claim must reclaim, not deadlock recovery.
    const staleClock = { now: () => Date.now() - 60_000 };
    const storeA = new WorkspaceStateStore(new FakeMemento());
    await storeA.initialize();
    storeA.useOwnershipStorage(shared, OWNERSHIP_DIR);
    const leaseA = new ExecutionLeaseManager(
      storeA,
      'window-a',
      staleClock as unknown as ConstructorParameters<typeof ExecutionLeaseManager>[2]
    );
    expect((await leaseA.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);

    const resumed = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumed).toBe(true);
    expect(hostB.invoke).toHaveBeenCalledTimes(2);
  });
});
