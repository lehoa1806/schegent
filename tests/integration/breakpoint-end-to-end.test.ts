import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 028 — Walkthrough 2 (future-phase breakpoint) end-to-end.
//
// Pipeline runs A → B → C → D. Operator sets a breakpoint on phase C while
// phase A is in-flight. Pipeline proceeds through A and B; when the runner
// is about to dispatch C, the breakpoint accessor returns
// `{'C'}` and PhaseRunner short-circuits with `outcome: 'paused-at-breakpoint'`
// BEFORE invoking the CLI. The controller's `driveRun` post-runner switch:
//   - filters the consumed breakpoint out of `phaseBreakpoints`
//   - emits `phase-breakpoint-cleared` { cause: 'consumed-by-fire' }
//   - sets `manualPauseCause: 'breakpoint-paused'`,
//     `resumeTargetPhaseId: 'C'`
//   - cascade-pauses the host queue (`pauseSource: 'cascade'`)
//   - releases the workspace lock
// `resumeActivePhase` then invokes C and the run continues through D.
//
// This test exercises the full integration: PhaseRunner +
// PhaseBreakpointAccessor + AuditLogWriter + WorkflowController +
// QueueManager + WorkspaceStateStore.

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
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type {
  RawInvocationOutput,
  InvocationRequest
} from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
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

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-bp-e2e-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 028 — Walkthrough 2 (future-phase breakpoint)', () => {
  it('pipeline runs preceding phases, halts before marked phase, resume invokes it', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const invokedPhases: string[] = [];
    const invoke = vi.fn(
      async (req: InvocationRequest): Promise<RawInvocationOutput> => {
        invokedPhases.push(req.phase);
        // Yield to the macrotask queue between phases so the test's polling
        // loop can observe intermediate states and intervene.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(cleanStdout(req.phase)); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
          killed: false,
          timedOut: false,
          durationMs: 1
        };
      }
    );
    const cliRunner = {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;

    const phaseBreakpointAccessor = createPhaseBreakpointAccessor(() => store.getRun(DEFAULT_QUEUE_ID));
    const phaseRunner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      audit,
      logger,
      null,
      null,
      null,
      null,
      null,
      phaseBreakpointAccessor
    );

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 },
      { catalog: buildSpeckitCatalog() }
    );

    // Enqueue task A and start the pipeline. featureDir is set so the
    // pipeline begins at speckit-clarify (skipping the initial
    // speckit-specify branch). Fire-and-forget so the test can intervene
    // mid-pipeline.
    const taskA = await queue.enqueue('feature with breakpoint');
    const runPromise = controller.startNew(taskA, 'specs/001-existing');

    // Wait for clarify (phase A) to complete so the controller has an
    // in-flight run id to attach the breakpoint to.
    // Bounded by elapsed time rather than by a round count. Each round
    // sleeps 10ms, so the old cap was ~2000ms of sleep plus however long the
    // scheduler took to come back — which under load is the larger term.
    // On exhaustion this used to `break` and fall through to an assertion
    // that reported the wrong thing: the run's status, rather than the fact
    // that nobody had waited long enough to see it.
    const phaseADoneBy = Date.now() + 25_000;
    while (Date.now() < phaseADoneBy) {
      const r = store.getRun(DEFAULT_QUEUE_ID);
      if (
        r &&
        (r.phasesCompleted.some((p) => p.phase === 'speckit-clarify') ||
          r.status === 'paused' ||
          r.status === 'completed' ||
          r.status === 'failed')
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    // While the run is mid-pipeline (post-clarify, pre-implement), set a
    // breakpoint on speckit-implement (phase C in the walkthrough).
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    const setResult = await controller.setPhaseBreakpoint(run.id, 'speckit-implement');
    expect(setResult).toEqual({ ok: true });

    // Wait for the breakpoint to fire (run reaches the marked phase) and
    // for the runPromise to settle (driveRun has broken out of its loop).
    await runPromise;

    // Assert: the pipeline halted at the breakpoint, CLI was NOT invoked
    // for the marked phase, and intermediate phases ran.
    const halted = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(halted.status).toBe('paused');
    expect(halted.manualPauseCause).toBe('breakpoint-paused');
    expect(halted.resumeTargetPhaseId).toBe('speckit-implement');
    expect(halted.phaseBreakpoints).toHaveLength(0); // consumed-by-fire
    expect(invokedPhases).not.toContain('speckit-implement');
    // Intermediate phases between clarify and implement should have run.
    expect(invokedPhases).toContain('speckit-clarify');
    expect(invokedPhases).toContain('speckit-plan');
    expect(invokedPhases).toContain('speckit-tasks');
    expect(invokedPhases).toContain('speckit-analyze');

    // The host queue should be cascade-paused.
    const regAfterFire = findQueue(store.getProjectedQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(regAfterFire?.state).toBe('manually-paused');
    expect(regAfterFire?.pauseSource).toBe('cascade');

    // Resume: invokes the marked phase and completes the pipeline.
    await controller.resumeActivePhase();
    // Bounded by elapsed time rather than by a round count. Each round
    // sleeps 10ms, so the old cap was ~5000ms of sleep plus however long the
    // scheduler took to come back — which under load is the larger term.
    // On exhaustion this used to `break` and fall through to an assertion
    // that reported the wrong thing: the run's status, rather than the fact
    // that nobody had waited long enough to see it.
    const resumedDoneBy = Date.now() + 25_000;
    while (Date.now() < resumedDoneBy) {
      const r = store.getRun(DEFAULT_QUEUE_ID);
      if (r && (r.status === 'completed' || r.status === 'failed' || r.status === 'canceled')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const resumed = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(resumed.status).toBe('completed');
    expect(resumed.manualPauseAt).toBeNull();
    expect(resumed.manualPauseCause).toBeNull();
    expect(resumed.resumeTargetPhaseId).toBeNull();
    // After resume the marked phase WAS invoked, plus downstream phases.
    expect(invokedPhases).toContain('speckit-implement');
    expect(invokedPhases).toContain('finalize');

    // Host queue is cascade-cleared post-resume.
    const regAfterResume = findQueue(store.getProjectedQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(regAfterResume?.state).toBe('active');
    expect(regAfterResume?.pauseSource).toBeNull();
  });
});
