import { describe, expect, it } from 'vitest';
import type { Memento } from '../../src/state/workspace-state';
import type { FrozenPhaseQuotaTarget } from '../../src/contracts/backend-availability';
import type { ExecutionFence } from '../../src/contracts/control-ledger';
import { BackendAvailabilityService } from '../../src/services/backend-availability-service';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { CandidateBlockExecutor } from '../../src/services/workflow-execution/candidate-block-executor';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import { ControlNotificationService } from '../../src/services/workflow-execution/control-notification-service';
import { QuotaPermitArbiter } from '../../src/services/workflow-execution/quota-permit-arbiter';

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, structuredClone(value));
      }
    }
  };
}

function makeFence(rootGeneration = 1): ExecutionFence {
  return {
    primacyClaim: 'primacy-1',
    queueClaim: 'queue-1',
    rootGeneration
  };
}

describe('Candidate block recovery integration tests (FR-R5-F30 / SPEC-08)', () => {
  it('executes transient retry, cooldown switch to fallback, waiting when all unavailable, recovery after polling, and single return commit', async () => {
    const memento = makeMemoryMemento();
    let wallMs = 5_000_000;
    let monoMs = 50_000;
    const hostEpoch = 'epoch-int-1';

    const clock = {
      nowWallMs: () => wallMs,
      nowMonotonicMs: () => monoMs,
      hostEpoch,
      advance(ms: number) {
        wallMs += ms;
        monoMs += ms;
      }
    };

    const ledgerStore = new ControlLedgerStore(memento);
    const admissionService = new ControlAttemptAdmissionService({
      ledgerStore,
      clock
    });
    const availabilityService = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: (kind) => ({
        adapterId: `adapter-${kind}`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: 'supported',
        resolveQuotaContext: (target: FrozenPhaseQuotaTarget) => ({
          version: 1,
          adapterId: `adapter-${target.runner}`,
          adapterVersion: 1,
          quotaIds: [`quota:${target.runner}`],
          identity: 'qualified',
          statusCheck: 'supported'
        }),
        checkAvailability: async (context) => ({
          version: 1,
          adapterId: context.adapterId,
          outcomes: context.quotaIds.map((quotaId) => ({
            quotaId,
            status: 'ready' as const
          })),
          costMicrousd: 0
        })
      })
    });
    const permitArbiter = new QuotaPermitArbiter({
      ledgerStore,
      clock
    });
    const notificationService = new ControlNotificationService({
      ledgerStore,
      clock
    });
    const executor = new CandidateBlockExecutor({
      ledgerStore,
      admissionService,
      availabilityService,
      permitArbiter,
      notificationService,
      clock
    });

    const fence = makeFence(1);
    await admissionService.prepareRootLink({
      ledgerRunId: 'root-rec',
      connectedRunId: 'run-rec',
      rootWorkflowId: 'wf-rec',
      queueId: 'default',
      fence
    });
    await admissionService.activateRootLink({
      ledgerRunId: 'root-rec',
      connectedRunId: 'run-rec',
      fence
    });

    const claudeTarget: FrozenPhaseQuotaTarget = {
      phaseId: 'phase-claude',
      runner: 'claude'
    };
    const codexTarget: FrozenPhaseQuotaTarget = {
      phaseId: 'phase-codex',
      runner: 'codex'
    };

    // Seed initial ready observations for both backends
    await availabilityService.checkCandidateAvailability({
      candidateOccurrenceId: 'seed-claude',
      frozenPhase: claudeTarget,
      generation: 1,
      subscribers: [{ rootRunId: 'root-rec', sequence: 1, generation: 1 }]
    });
    clock.advance(61_000);
    await availabilityService.checkCandidateAvailability({
      candidateOccurrenceId: 'seed-codex',
      frozenPhase: codexTarget,
      generation: 1,
      subscribers: [{ rootRunId: 'root-rec', sequence: 1, generation: 1 }]
    });

    await executor.initializeCandidateBlock({
      rootRunId: 'root-rec',
      workflowId: 'wf-rec',
      frameKey: 'frame:cand',
      invocationId: 'inv-cand',
      nodeId: 'node-cand',
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-claude',
          nodeId: 'phase-claude',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 3,
          quotaTarget: claudeTarget
        },
        {
          candidateId: 'cand-codex',
          nodeId: 'phase-codex',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2,
          quotaTarget: codexTarget
        }
      ],
      fence
    });

    // 1. Dispatch cand-claude attempt 1 -> fails with rate_limit cooldown
    const step1 = await executor.stepCandidateBlock({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      fence
    });
    expect(step1.action.kind).toBe('dispatch-candidate');
    if (step1.action.kind === 'dispatch-candidate') {
      expect(step1.action.candidate.candidateId).toBe('cand-claude');
    }

    await executor.settleCandidateAttempt({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      attemptId: step1.attempt!.attemptId,
      candidateId: 'cand-claude',
      fence,
      outcome: 'retryable-availability',
      failureCode: 'rate_limit',
      resetsAtMs: clock.nowWallMs() + 120_000,
      quotaTarget: claudeTarget
    });

    // 2. Next step switches to ready fallback cand-codex!
    const step2 = await executor.stepCandidateBlock({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      fence
    });
    expect(step2.action.kind).toBe('dispatch-candidate');
    if (step2.action.kind === 'dispatch-candidate') {
      expect(step2.action.candidate.candidateId).toBe('cand-codex');
      expect(step2.action.switchedFromCandidateId).toBe('cand-claude');
    }

    // cand-codex hits rate_limit too
    await executor.settleCandidateAttempt({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      attemptId: step2.attempt!.attemptId,
      candidateId: 'cand-codex',
      fence,
      outcome: 'retryable-availability',
      failureCode: 'rate_limit',
      resetsAtMs: clock.nowWallMs() + 180_000,
      quotaTarget: codexTarget
    });

    // 3. Now both candidates are in cooldown -> enters waiting-availability without consuming an attempt
    const rootBeforeWait = ledgerStore.getRoot('root-rec')!;
    const attemptsBeforeWait = rootBeforeWait.dispatchedAttempts;

    const step3 = await executor.stepCandidateBlock({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      fence
    });
    expect(step3.action.kind).toBe('wait-availability');
    expect(step3.frame?.status).toBe('waiting-availability');
    expect(ledgerStore.getRoot('root-rec')?.dispatchedAttempts).toBe(
      attemptsBeforeWait
    );

    // 4. Advance past claude cooldown + 60s buffer and run availability check -> claude becomes ready again
    clock.advance(185_000);
    await availabilityService.checkCandidateAvailability({
      candidateOccurrenceId: 'poll-claude',
      frozenPhase: claudeTarget,
      generation: 1,
      subscribers: [{ rootRunId: 'root-rec', sequence: 1, generation: 1 }]
    });

    // 5. Step dispatches cand-claude attempt 2 and succeeds -> commits returnCommitId once
    const step4 = await executor.stepCandidateBlock({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      fence
    });
    expect(step4.action.kind).toBe('dispatch-candidate');
    if (step4.action.kind === 'dispatch-candidate') {
      expect(step4.action.candidate.candidateId).toBe('cand-claude');
      expect(step4.action.attemptOrdinal).toBe(2);
    }

    const settledWin = await executor.settleCandidateAttempt({
      rootRunId: 'root-rec',
      frameKey: 'frame:cand',
      attemptId: step4.attempt!.attemptId,
      candidateId: 'cand-claude',
      fence,
      outcome: 'succeeded',
      validatedOutputs: { summary: 'done.md' },
      decisionResults: { readyToMerge: true }
    });
    expect(settledWin.returnCommitted).toBe(true);
    expect(settledWin.frame?.status).toBe('completed');
    expect(settledWin.frame?.winningCandidateId).toBe('cand-claude');
  });

  it('reconciles candidate block across host restart without duplicate attempt dispatch or duplicate return commit', async () => {
    const memento = makeMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    let runningProcess = true;

    const admission1 = new ControlAttemptAdmissionService({
      ledgerStore,
      processEvidencePort: {
        inspectAttempt: async () => ({
          processState: runningProcess ? 'running' : 'exited-clean',
          ...(runningProcess ? {} : { durableTerminalStatus: 'completed' })
        })
      }
    });
    const executor1 = new CandidateBlockExecutor({
      ledgerStore,
      admissionService: admission1
    });

    const fence1 = makeFence(1);
    await admission1.prepareRootLink({
      ledgerRunId: 'root-restart',
      connectedRunId: 'run-restart',
      rootWorkflowId: 'wf-restart',
      queueId: 'default',
      fence: fence1
    });
    await admission1.activateRootLink({
      ledgerRunId: 'root-restart',
      connectedRunId: 'run-restart',
      fence: fence1
    });

    await executor1.initializeCandidateBlock({
      rootRunId: 'root-restart',
      workflowId: 'wf-restart',
      frameKey: 'frame:restart',
      invocationId: 'inv-restart',
      nodeId: 'node-restart',
      candidates: [
        {
          candidateId: 'cand-1',
          nodeId: 'phase-1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        }
      ],
      fence: fence1
    });

    const step1 = await executor1.stepCandidateBlock({
      rootRunId: 'root-restart',
      frameKey: 'frame:restart',
      fence: fence1
    });
    const attemptId = step1.attempt!.attemptId;
    await admission1.recordSpawnIntent({
      ledgerRunId: 'root-restart',
      attemptId,
      fence: fence1
    });
    await admission1.recordAttemptStarted({
      ledgerRunId: 'root-restart',
      attemptId,
      fence: fence1,
      pid: 4242
    });

    // Simulate host restart while child process is still running -> reattaches without new dispatch
    const fence2 = makeFence(2);
    const ledgerStore2 = new ControlLedgerStore(memento);
    const admission2 = new ControlAttemptAdmissionService({
      ledgerStore: ledgerStore2,
      processEvidencePort: {
        inspectAttempt: async () => ({
          processState: runningProcess ? 'running' : 'exited-clean',
          ...(runningProcess ? {} : { durableTerminalStatus: 'completed' })
        })
      }
    });
    const executor2 = new CandidateBlockExecutor({
      ledgerStore: ledgerStore2,
      admissionService: admission2
    });

    const recRunning = await admission2.reconcileControlRoot({
      ledgerRunId: 'root-restart',
      connectedRun: {
        connectedRunId: 'run-restart',
        workflowId: 'wf-restart',
        graph: {
          version: 1,
          workflowId: 'wf-restart',
          name: 'Restart WF',
          description: '',
          inputs: [],
          outputs: [],
          nodes: [],
          connections: [],
          startNodeIds: []
        },
        pipelines: {},
        nodes: {},
        decisions: [],
        revision: 1,
        startedAt: 1000,
        queueId: 'default',
        invocations: {},
        controlState: { version: 1, ledgerRunId: 'root-restart' }
      },
      newFence: fence2
    });
    expect(recRunning.disposition).toBe('reattached-running-attempt');
    expect(ledgerStore2.getRoot('root-restart')?.dispatchedAttempts).toBe(1);

    // Stepping while reattached attempt is still in-flight does not dispatch a duplicate attempt
    const stepWhileRunning = await executor2.stepCandidateBlock({
      rootRunId: 'root-restart',
      frameKey: 'frame:restart',
      fence: fence2
    });
    expect(stepWhileRunning.action.kind).toBe('noop-active');
    expect(ledgerStore2.getRoot('root-restart')?.dispatchedAttempts).toBe(1);

    // Settle attempt and verify returnCommitId is committed once
    runningProcess = false;
    const settled = await executor2.settleCandidateAttempt({
      rootRunId: 'root-restart',
      frameKey: 'frame:restart',
      attemptId,
      candidateId: 'cand-1',
      fence: fence2,
      outcome: 'succeeded',
      validatedOutputs: { out: 'ok' }
    });
    expect(settled.returnCommitted).toBe(true);
  });
});
