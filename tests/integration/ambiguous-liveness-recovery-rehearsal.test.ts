/**
 * FR-R7-14 (14-22) — Ambiguous process liveness recovery rehearsal on a disposable Git checkout.
 *
 * Exercises restart recovery across all process-liveness verdicts (`alive`, `orphaned-group`,
 * `dead`, `unrecorded`, and `unanswerable`) via `checkLiveness` + `resumePersistedRuns`
 * (`src/services/process-liveness.ts`, `src/services/resume-decision.ts`) alongside connected
 * workflow `recovery-uncertain-effect` reconciliation (`WorkflowRecoveryService`), contrasting
 * fenced local state writes (`compareAndSetConnectedRun`) with already-started external
 * working-tree / Git effects.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunResumeEventType, RunResumePayload } from '../../src/contracts/audit-events';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import {
  RESUME_ON,
  START_TIME_TOLERANCE_MS,
  type LivenessVerdict,
  type SpawnIdentity
} from '../../src/contracts/spawn-identity';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import {
  checkLiveness,
  createLivenessProbe,
  type LivenessProbe
} from '../../src/services/process-liveness';
import {
  declineMessage,
  orphanedGroupDeclineMessage,
  resumePersistedRuns
} from '../../src/services/resume-decision';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  WorkflowRecoveryService,
  type WorkflowRecoveryStore
} from '../../src/services/workflow-execution/workflow-recovery-service';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const QUEUE_ID = 'default';
const RECORDED_START_MS = 1_760_000_000_000;

interface RecordedAudit {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
  readonly eventType: RunResumeEventType;
  readonly payload: RunResumePayload;
  readonly outcome: 'info' | 'failure';
}

function createDisposableGitCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'schegent-liveness-rehearsal-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'rehearsal@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Rehearsal Operator'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.txt'), 'baseline\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial baseline'], { cwd: dir });
  return dir;
}

function createMemoryRecoveryStore(): WorkflowRecoveryStore & {
  readonly seed: (run: ConnectedWorkflowRun) => void;
} {
  const runs = new Map<string, ConnectedWorkflowRun>();
  return {
    get(id: string) {
      return runs.get(id) ?? null;
    },
    list() {
      return Array.from(runs.values());
    },
    seed(run: ConnectedWorkflowRun) {
      runs.set(run.connectedRunId, run);
    },
    async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRevision: number) {
      const current = runs.get(next.connectedRunId) ?? null;
      if (current === null || current.revision !== expectedRevision) {
        return { outcome: 'stale' as const, current };
      }
      runs.set(next.connectedRunId, next);
      return { outcome: 'written' as const, run: next };
    }
  };
}

const PHASES: readonly PhaseDefinition[] = [
  { phaseId: 'implement', name: 'Implement', version: 1, instruction: 'Apply edits', sideEffects: 'git' },
  { phaseId: 'verify', name: 'Verify', version: 1, instruction: 'Verify edits', sideEffects: 'none' }
];

const WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-liveness-rehearsal',
  name: 'Liveness Rehearsal Workflow',
  version: 1,
  startNodeIds: ['n1'],
  nodes: [
    { nodeId: 'n1', kind: 'phase', phaseId: 'implement' },
    { nodeId: 'n2', kind: 'phase', phaseId: 'verify' }
  ],
  connections: [
    {
      from: { nodeId: 'n1' },
      to: { kind: 'node', nodeId: 'n2' },
      handoff: 'manual'
    }
  ]
};

describe('FR-R7-14 (14-22) — Ambiguous process liveness recovery rehearsal on a disposable Git checkout', () => {
  let checkoutDir: string;

  beforeEach(() => {
    checkoutDir = createDisposableGitCheckout();
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  async function rehearseActivationResume(
    identity: SpawnIdentity | undefined,
    probe: LivenessProbe
  ): Promise<{
    readonly verdict: LivenessVerdict;
    readonly audits: readonly RecordedAudit[];
    readonly resumedQueues: readonly string[];
    readonly notifications: readonly string[];
    readonly logs: readonly string[];
  }> {
    const audits: RecordedAudit[] = [];
    const resumedQueues: string[] = [];
    const notifications: string[] = [];
    const logs: string[] = [];
    let observedVerdict: LivenessVerdict = 'unrecorded';

    await resumePersistedRuns({
      runs: () => [
        [
          QUEUE_ID,
          {
            id: RUN_ID,
            currentPhase: 'implement',
            currentIteration: 1,
            ...(identity !== undefined ? { spawnIdentity: identity } : {})
          }
        ]
      ],
      liveness: async (id) => {
        observedVerdict = await checkLiveness(id, probe);
        return observedVerdict;
      },
      appendAudit: async (entry) => {
        audits.push(entry);
      },
      resume: (queueId) => {
        resumedQueues.push(queueId);
      },
      notify: (message) => {
        notifications.push(message);
      },
      log: (message) => {
        logs.push(message);
      }
    });

    return {
      verdict: observedVerdict,
      audits,
      resumedQueues,
      notifications,
      logs
    };
  }

  it('declines automatic resume on confirmed `alive` process, surfaces operator notice, and starts zero duplicate runs', async () => {
    const identity: SpawnIdentity = { pid: 42_100, pgid: 42_100, startedAtMs: RECORDED_START_MS };
    const probe: LivenessProbe = {
      platform: 'darwin',
      exists: (pid) => pid === identity.pid,
      groupExists: () => true,
      startedAtMs: async () => RECORDED_START_MS + 500
    };

    const result = await rehearseActivationResume(identity, probe);

    expect(result.verdict).toBe('alive');
    expect(RESUME_ON).not.toContain('alive');
    expect(result.resumedQueues).toEqual([]);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({
      runId: RUN_ID,
      eventType: 'run-resume-declined-orphan-alive',
      outcome: 'failure',
      payload: { queueId: QUEUE_ID, runId: RUN_ID, liveness: 'alive' }
    });
    expect(result.notifications).toEqual([
      declineMessage({ queueId: QUEUE_ID, runId: RUN_ID, spawnIdentity: identity })
    ]);
  });

  it('declines automatic resume on `orphaned-group` (leader exited, process-group descendant alive) with distinct operator guidance', async () => {
    const identity: SpawnIdentity = { pid: 42_200, pgid: 42_200, startedAtMs: RECORDED_START_MS };
    const probe: LivenessProbe = {
      platform: 'darwin',
      exists: () => false,
      groupExists: (pgid) => pgid === identity.pgid,
      startedAtMs: async () => null
    };

    const result = await rehearseActivationResume(identity, probe);

    expect(result.verdict).toBe('orphaned-group');
    expect(RESUME_ON).not.toContain('orphaned-group');
    expect(result.resumedQueues).toEqual([]);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({
      eventType: 'run-resume-declined-orphan-alive',
      outcome: 'failure',
      payload: { queueId: QUEUE_ID, runId: RUN_ID, liveness: 'orphaned-group' }
    });
    expect(result.notifications).toEqual([
      orphanedGroupDeclineMessage({ queueId: QUEUE_ID, runId: RUN_ID, spawnIdentity: identity })
    ]);
    expect(result.notifications[0]).toContain('processes it started are still alive in its process group');
  });

  it('resumes on confirmed `dead` (both absent group and recycled PID whose start time diverges beyond tolerance)', async () => {
    const identity: SpawnIdentity = { pid: 42_300, pgid: 42_300, startedAtMs: RECORDED_START_MS };

    // Case 1: leader absent and process group empty
    const absentResult = await rehearseActivationResume(identity, {
      platform: 'darwin',
      exists: () => false,
      groupExists: () => false,
      startedAtMs: async () => null
    });
    expect(absentResult.verdict).toBe('dead');
    expect(absentResult.resumedQueues).toEqual([QUEUE_ID]);
    expect(absentResult.audits[0]).toMatchObject({
      eventType: 'run-resumed',
      outcome: 'info',
      payload: { liveness: 'dead' }
    });
    expect(absentResult.notifications).toEqual([]);

    // Case 2: PID exists, but OS start time proves it is a recycled unrelated process
    const recycledResult = await rehearseActivationResume(identity, {
      platform: 'darwin',
      exists: () => true,
      groupExists: () => true,
      startedAtMs: async () => RECORDED_START_MS + START_TIME_TOLERANCE_MS + 10_000
    });
    expect(recycledResult.verdict).toBe('dead');
    expect(recycledResult.resumedQueues).toEqual([QUEUE_ID]);
    expect(recycledResult.audits[0]).toMatchObject({
      eventType: 'run-resumed',
      outcome: 'info',
      payload: { liveness: 'dead' }
    });
  });

  it('resumes on inconclusive `unanswerable` identity (missing start time, EPERM, or win32), records explicit `unanswerable` audit risk annotation, and leaves prior checkout writes untouched', async () => {
    const identity: SpawnIdentity = { pid: 42_400, pgid: 42_400, startedAtMs: RECORDED_START_MS };

    // Simulate an external working-tree mutation started by the interrupted attempt before crash
    const externalFile = join(checkoutDir, 'started-external-edit.txt');
    writeFileSync(externalFile, 'partial write before host restart\n', 'utf8');

    const probes: ReadonlyArray<readonly [string, LivenessProbe]> = [
      [
        'ps start time unavailable',
        {
          platform: 'darwin',
          exists: () => true,
          groupExists: () => true,
          startedAtMs: async () => null
        }
      ],
      [
        'EPERM on exists probe',
        {
          platform: 'darwin',
          exists: () => {
            const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
            throw err;
          },
          groupExists: () => false,
          startedAtMs: async () => null
        }
      ],
      [
        'Windows platform job-object permanent limit',
        {
          platform: 'win32',
          exists: () => true,
          groupExists: () => true,
          startedAtMs: async () => RECORDED_START_MS
        }
      ]
    ];

    expect(RESUME_ON).toContain('unanswerable');
    for (const [label, probe] of probes) {
      const result = await rehearseActivationResume(identity, probe);
      expect(result.verdict, label).toBe('unanswerable');
      expect(result.resumedQueues, label).toEqual([QUEUE_ID]);
      expect(result.audits[0], label).toMatchObject({
        eventType: 'run-resumed',
        outcome: 'info',
        payload: { queueId: QUEUE_ID, runId: RUN_ID, liveness: 'unanswerable' }
      });
      // Inconclusive identity is NEVER folded into `dead`, so duplicate-effect exposure stays auditable
      expect(result.audits[0]?.payload.liveness, label).not.toBe('dead');
    }

    // Resuming does not roll back external working-tree files that already landed on disk
    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, 'utf8')).toBe('partial write before host restart\n');
  });

  it('pauses connected workflow attempts without durable completion as `recovery-uncertain-effect` (zero duplicate dispatch), while local CAS fencing leaves already-started Git/file effects intact', async () => {
    const store = createMemoryRecoveryStore();
    let dispatchCount = 0;
    const dispatchPhase = async () => {
      dispatchCount += 1;
      return { outcome: 'dispatched' as const, queueItemId: `qi-${dispatchCount}` };
    };

    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'connected-liveness-1',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: PHASES,
      startedAt: 1_000,
      queueId: QUEUE_ID
    });
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    store.seed(created.run);
    await dispatchComposableNode(
      { connectedRuns: store, dispatchPhase },
      {
        run: created.run,
        invocationId: created.rootInvocationId,
        nodeId: 'n1',
        startedAt: 1_050
      }
    );
    expect(dispatchCount).toBe(1);

    const preCrashRun = store.get('connected-liveness-1')!;
    const preCrashRevision = preCrashRun.revision;

    // Simulate an already-started external Git effect in the disposable checkout BEFORE crash
    const committedArtifact = join(checkoutDir, 'external-commit-artifact.txt');
    writeFileSync(committedArtifact, 'external side effect committed before crash\n', 'utf8');
    execFileSync('git', ['add', 'external-commit-artifact.txt'], { cwd: checkoutDir });
    execFileSync('git', ['commit', '-q', '-m', 'external effect before host crash'], { cwd: checkoutDir });
    const headBeforeRecovery = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutDir,
      encoding: 'utf8'
    }).trim();

    // Host restarts with NO durable completion evidence for the in-flight attempt
    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase,
      checkDurableAttemptEvidence: () => ({ completed: false })
    });
    const reconciled = await recovery.reconcileRun('connected-liveness-1', 2_000);

    expect(reconciled?.disposition?.status).toBe('uncertain-effect-paused');
    expect(dispatchCount).toBe(1); // ZERO automatic duplicate dispatch!
    const pausedFrame = reconciled!.run.invocations![created.rootInvocationId]!;
    expect(pausedFrame.status).toBe('paused');
    expect(pausedFrame.controlMarkers?.manualPauseCause).toBe('recovery-uncertain-effect');
    expect(pausedFrame.attemptsByNodeId['n1'].at(0)?.status).toBe('paused');
    expect(reconciled?.projection.rootAllowedActions).toEqual(
      expect.arrayContaining(['retry-phase', 'resume', 'cancel'])
    );

    // Local state writes ARE fenced: a stale pre-crash writer cannot overwrite the recovered run
    const staleWrite = await store.compareAndSetConnectedRun(
      { ...preCrashRun, revision: preCrashRevision + 1 },
      preCrashRevision
    );
    expect(staleWrite.outcome).toBe('stale');

    // Already-started external Git commit and file remain on disk — local revision fencing cannot undo them
    const headAfterRecovery = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutDir,
      encoding: 'utf8'
    }).trim();
    expect(headAfterRecovery).toBe(headBeforeRecovery);
    expect(existsSync(committedArtifact)).toBe(true);

    // Contrast: when durable completion evidence IS present, recovery settles cleanly to waiting-for-handoff
    const cleanStore = createMemoryRecoveryStore();
    cleanStore.seed(created.run);
    await dispatchComposableNode(
      { connectedRuns: cleanStore, dispatchPhase },
      {
        run: created.run,
        invocationId: created.rootInvocationId,
        nodeId: 'n1',
        startedAt: 1_050
      }
    );
    const settledRecovery = new WorkflowRecoveryService({
      connectedRuns: cleanStore,
      dispatchPhase,
      checkDurableAttemptEvidence: () => ({
        completed: true,
        status: 'completed',
        completedAt: 1_500
      })
    });
    const settled = await settledRecovery.reconcileRun('connected-liveness-1', 2_100);
    expect(settled?.disposition?.status).toBe('settled-from-evidence');
    expect(settled?.run.invocations?.[created.rootInvocationId]?.status).toBe('waiting-for-handoff');
    expect(settled?.run.invocations?.[created.rootInvocationId]?.controlMarkers?.manualPauseCause ?? null).toBeNull();

    // Ensure completeComposableNodeAttempt remains clean when an operator resolves manually
    const manualRun = createComposableWorkflowRunSnapshot({
      connectedRunId: 'connected-liveness-2',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: PHASES,
      startedAt: 3_000,
      queueId: QUEUE_ID
    });
    expect(manualRun.outcome).toBe('created');
    if (manualRun.outcome !== 'created') return;
    cleanStore.seed(manualRun.run);
    await dispatchComposableNode(
      { connectedRuns: cleanStore, dispatchPhase },
      { run: manualRun.run, invocationId: manualRun.rootInvocationId, nodeId: 'n1', startedAt: 3_010 }
    );
    await completeComposableNodeAttempt(
      { connectedRuns: cleanStore, dispatchPhase },
      {
        run: cleanStore.get('connected-liveness-2')!,
        invocationId: manualRun.rootInvocationId,
        nodeId: 'n1',
        status: 'completed',
        completedAt: 3_050
      }
    );
    expect(cleanStore.get('connected-liveness-2')?.invocations?.[manualRun.rootInvocationId]?.status).toBe(
      'waiting-for-handoff'
    );
  });

  const posixOnly = process.platform === 'win32' ? it.skip : it;
  posixOnly('observes a real detached POSIX child as `alive` (or `unanswerable` under restricted ps) while running and `dead` after group termination', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      cwd: checkoutDir,
      detached: true,
      stdio: 'ignore'
    });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;

    const identity: SpawnIdentity = {
      pid,
      pgid: pid,
      startedAtMs: Date.now()
    };
    const probe = createLivenessProbe();
    try {
      const liveVerdict = await checkLiveness(identity, probe);
      // On unrestricted macOS/Linux hosts `ps -o lstart=` resolves and yields `alive`; under
      // process-inspection sandboxes `ps` may fail closed to `unanswerable`, never `dead`.
      expect(['alive', 'unanswerable']).toContain(liveVerdict);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process already exited before cleanup.
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
    }

    const deadVerdict = await checkLiveness(identity, probe);
    expect(deadVerdict).toBe('dead');
  });
});
