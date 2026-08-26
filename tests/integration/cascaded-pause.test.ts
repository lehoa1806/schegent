import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 028 — Walkthrough 1 (Cascaded active-phase pause) end-to-end.
//
// Multi-task queue: A in-flight, B pending. Mid-phase pause on A cascades
// to the queue → B does NOT dispatch. Resume → queue cascade-resumes and
// the run continues to completion.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
// Feature 098 (T080) — the controller no longer carries a compiled-in catalog,
// so a test that drives Phases supplies one. See the fixture header for why the
// ids here are the real Spec Kit ones.
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { ExecutionLeasePort } from '../../src/services/auto-drain-coordinator';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { findQueue } from '../../src/queue/queue-registry';

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

const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

/**
 * Feature 092 (T070) — the drain gate this test leans on, re-aimed.
 *
 * This test has always needed the auto-drain to refuse, so that task B staying
 * pending means "the cascade held" rather than "the scheduler happened not to
 * run yet". It got that from `makeLock().tryAcquire` returning `acquired:false`,
 * because the workspace lock WAS the drain's last gate.
 *
 * Feature 092 split that lock: window primacy stayed on it, and the drain's
 * claim moved to a per-queue execution lease. So the refusal moves too. Nothing
 * about the walkthrough changed — the same gate is being closed, under the name
 * it now has. Left on the lock, this test would assert the cascade while the
 * drain was in fact free to dispatch, which is the opposite of what it checks.
 */
/**
 * FR-R3-070 (feature 152) — the same reasoning one gate later. The resume seam
 * now claims the execution lease too (`resumeExistingOnQueue` mirrors the
 * drain's step 6), so a lease that refuses EVERYTHING no longer models this
 * walkthrough: its premise is that the window that owns the paused Run may
 * resume it, while the drain stays refused. `grantNext()` opens exactly one
 * claim — the operator's resume — and every other claim (including the
 * post-terminal drain sweep that would otherwise dispatch task B) still
 * refuses, which is what keeps "B stays pending" meaning "the cascade held".
 */
function makeRefusingLease(): ExecutionLeasePort & { grantNext: () => void } {
  let grants = 0;
  return {
    grantNext: () => {
      grants += 1;
    },
    // FR-R3-077 — a refusing-lease double holds nothing, so it claims nothing.
    claimFor: () => null,
    tryAcquire: vi.fn(async () => {
      if (grants > 0) {
        grants -= 1;
        return { acquired: true, ownerId: 'this-window' };
      }
      return { acquired: false, ownerId: 'other-window' };
    }),
    release: vi.fn(async () => {})
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cascaded-pause-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 028 — Walkthrough 1 (cascaded active-phase pause)', () => {
  it('mid-phase pause cascades to host queue; pending task does NOT dispatch; resume cascade-resumes the queue', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);

    const lease = makeRefusingLease();
    // We control when pause is triggered by injecting it from the CLI mock
    // mid-phase: during the FIRST `speckit-clarify` invocation, the runner
    // returns clean stdout BUT calls `controller.pauseActivePhase()` first,
    // so when the controller checks `manualPauseAt` at the cooperative
    // pause boundary it halts.
    // eslint-disable-next-line prefer-const -- assigned once below; required upfront so the `invoke` closure can reference it.
    let controller!: SchegentWorkflowController;
    let pausedDuringPhase: string | null = null;
    const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
      if (req.phase === 'speckit-clarify' && pausedDuringPhase === null) {
        pausedDuringPhase = req.phase;
        await controller.pauseActivePhase();
      }
      return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(cleanStdout(req.phase)); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
        killed: false,
        timedOut: false,
        durationMs: 1
      };
    });
    const cliRunner = {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;
    const phaseRunner = new PhaseRunner(cliRunner, new PromptBuilder(), audit, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 },
      { catalog: buildSpeckitCatalog(), executionLease: lease }
    );

    // Enqueue two tasks: A (will run) and B (must stay pending).
    const taskA = await queue.enqueue('feature A');
    const taskB = await queue.enqueue('feature B');

    // Start A with featureDir set so the pipeline begins at clarify (the
    // phase we trigger pause on).
    await controller.startNew(taskA, 'specs/001-existing');

    // Phase 1: confirm the run halted mid-phase + the queue cascaded.
    const runPaused = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(runPaused.status).toBe('paused');
    expect(runPaused.manualPauseCause).toBe('operator-paused');
    expect(pausedDuringPhase).toBe('speckit-clarify');

    const regAfterPause = findQueue(store.getProjectedQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(regAfterPause?.state).toBe('manually-paused');
    expect(regAfterPause?.pauseSource).toBe('cascade');

    // Task A is paused (task-level pauseCause from the existing cooperative
    // halt path); task B remains pending (was never dispatched).
    const aRow = queue.findById(taskA.id);
    const bRow = queue.findById(taskB.id);
    expect(aRow?.status).toBe('paused');
    expect(bRow?.status).toBe('pending');

    // Phase 2: resume the phase. resumeActivePhase calls cascadedResume on
    // the host queue (FR-002) and schedules `resumeExisting` via
    // setImmediate. Wait for that microtask to drain and the resumed run
    // to complete naturally (it will drive clarify → plan → tasks →
    // analyze → implement → finalize → done).
    // FR-R3-070 — the resume seam claims the lease; open exactly one grant
    // for it (see makeRefusingLease). Everything else keeps refusing.
    lease.grantNext();
    await controller.resumeActivePhase();
    // Bounded by elapsed time rather than by a round count. Each round
    // sleeps 10ms, so the old cap was ~2000ms of sleep plus however long the
    // scheduler took to come back — which under load is the larger term.
    // On exhaustion this used to `break` and fall through to an assertion
    // that reported the wrong thing: the run's status, rather than the fact
    // that nobody had waited long enough to see it.
    const settleBy = Date.now() + 25_000;
    while (Date.now() < settleBy) {
      const r = store.getRun(DEFAULT_QUEUE_ID);
      if (r && (r.status === 'completed' || r.status === 'failed' || r.status === 'canceled')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    // The host queue's cascade-pause is cleared as part of resumeActivePhase
    // (before resumeExisting fires), so the registry state flips back to
    // 'active' as soon as the IPC returns.
    const regAfterResume = findQueue(store.getProjectedQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(regAfterResume?.state).toBe('active');
    expect(regAfterResume?.pauseSource).toBeNull();

    const runResumed = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(runResumed.manualPauseAt).toBeNull();
    expect(runResumed.manualPauseCause).toBeNull();
    expect(runResumed.status).toBe('completed');

    // Task B was never dispatched during the pause window; it remains
    // pending after the original run completes (scheduler dispatch is the
    // GuardedRunService's job, out of scope for this controller-level
    // integration test).
    expect(queue.findById(taskB.id)?.status).toBe('pending');
  });
});
