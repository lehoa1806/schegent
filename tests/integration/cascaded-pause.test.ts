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
import { findQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
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
        stdout: cleanStdout(req.phase),
        stderr: '',
        exitCode: 0,
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
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000, perPhaseRulesEnabled: false }
    );

    // Enqueue two tasks: A (will run) and B (must stay pending).
    const taskA = await queue.enqueue('feature A');
    const taskB = await queue.enqueue('feature B');

    // Start A with featureDir set so the pipeline begins at clarify (the
    // phase we trigger pause on).
    await controller.startNew(taskA, 'specs/001-existing');

    // Phase 1: confirm the run halted mid-phase + the queue cascaded.
    const runPaused = store.getRun()!;
    expect(runPaused.status).toBe('paused');
    expect(runPaused.manualPauseCause).toBe('operator-paused');
    expect(pausedDuringPhase).toBe('speckit-clarify');

    const regAfterPause = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
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
    await controller.resumeActivePhase();
    for (let i = 0; i < 200; i++) {
      const r = store.getRun();
      if (r && (r.status === 'completed' || r.status === 'failed' || r.status === 'canceled')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    // The host queue's cascade-pause is cleared as part of resumeActivePhase
    // (before resumeExisting fires), so the registry state flips back to
    // 'active' as soon as the IPC returns.
    const regAfterResume = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(regAfterResume?.state).toBe('active');
    expect(regAfterResume?.pauseSource).toBeNull();

    const runResumed = store.getRun()!;
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
