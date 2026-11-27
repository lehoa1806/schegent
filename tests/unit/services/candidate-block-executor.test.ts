import { describe, expect, it } from 'vitest';
import type { Memento } from '../../../src/state/workspace-state';
import {
  type FrozenPhaseQuotaTarget
} from '../../../src/contracts/backend-availability';
import type { ExecutionFence } from '../../../src/contracts/control-ledger';
import { BackendAvailabilityService } from '../../../src/services/backend-availability-service';
import { ControlAttemptAdmissionService } from '../../../src/services/workflow-execution/control-attempt-admission';
import {
  CandidateBlockExecutor,
  MONITORING_WINDOW_DURATION_MS,
  selectNextCandidateAction
} from '../../../src/services/workflow-execution/candidate-block-executor';
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import { transition } from '../../../src/controller/phase';
import { PhaseSequencer } from '../../../src/controller/phase-sequencer';

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

function makeHarness(startWallMs = 1_000_000) {
  let wallMs = startWallMs;
  let monoMs = 10_000;
  let hostEpoch = 'epoch-1';
  const releasedSlots: Array<{
    readonly queueId: string;
    readonly rootRunId: string;
    readonly invocationId: string;
  }> = [];

  const clock = {
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => monoMs,
    get hostEpoch() {
      return hostEpoch;
    },
    advance(ms: number) {
      wallMs += ms;
      monoMs += ms;
    },
    setHostEpoch(next: string) {
      hostEpoch = next;
    }
  };

  const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
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

  const executor = new CandidateBlockExecutor({
    ledgerStore,
    admissionService,
    availabilityService,
    clock,
    onReleaseProcessCapacitySlot: (queueId, rootRunId, invocationId) => {
      releasedSlots.push({ queueId, rootRunId, invocationId });
    }
  });

  return {
    clock,
    ledgerStore,
    admissionService,
    availabilityService,
    executor,
    releasedSlots
  };
}

describe('CandidateBlockExecutor unit tests (FR-R5-F30 / SPEC-08 / D5)', () => {
  it('mints unique candidateOccurrenceId UUIDs and selects candidates in (priority, authoredOrder) order', async () => {
    const h = makeHarness();
    const fence = makeFence(1);

    await h.admissionService.prepareRootLink({
      ledgerRunId: 'root-1',
      connectedRunId: 'run-1',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence
    });
    await h.admissionService.activateRootLink({
      ledgerRunId: 'root-1',
      connectedRunId: 'run-1',
      fence
    });

    const initRes = await h.executor.initializeCandidateBlock({
      rootRunId: 'root-1',
      workflowId: 'wf-1',
      frameKey: 'frame:cand-1',
      invocationId: 'inv-1',
      nodeId: 'node-cand-1',
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-b',
          nodeId: 'phase-b',
          backend: 'codex',
          priority: 2,
          authoredOrder: 0,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-a2',
          nodeId: 'phase-a2',
          backend: 'agy',
          priority: 1,
          authoredOrder: 1,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-a1',
          nodeId: 'phase-a1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        }
      ],
      fence
    });

    expect(initRes.ok).toBe(true);
    const slots = initRes.frame?.candidateSlots ?? [];
    expect(slots.map((s) => s.candidateId)).toEqual([
      'cand-a1',
      'cand-a2',
      'cand-b'
    ]);
    const occurrenceIds = new Set(slots.map((s) => s.candidateOccurrenceId));
    expect(occurrenceIds.size).toBe(3);

    const step1 = await h.executor.stepCandidateBlock({
      rootRunId: 'root-1',
      frameKey: 'frame:cand-1',
      fence
    });
    expect(step1.ok).toBe(true);
    expect(step1.action.kind).toBe('dispatch-candidate');
    if (step1.action.kind === 'dispatch-candidate') {
      expect(step1.action.candidate.candidateId).toBe('cand-a1');
      expect(step1.action.attemptOrdinal).toBe(1);
    }
  });

  it('never preempts an executing or retry-delayed candidate slot', async () => {
    const h = makeHarness();
    const fence = makeFence(1);

    await h.admissionService.prepareRootLink({
      ledgerRunId: 'root-1',
      connectedRunId: 'run-1',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence
    });
    await h.admissionService.activateRootLink({
      ledgerRunId: 'root-1',
      connectedRunId: 'run-1',
      fence
    });

    await h.executor.initializeCandidateBlock({
      rootRunId: 'root-1',
      workflowId: 'wf-1',
      frameKey: 'frame:cand-1',
      invocationId: 'inv-1',
      nodeId: 'node-cand-1',
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-1',
          nodeId: 'phase-1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-2',
          nodeId: 'phase-2',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2
        }
      ],
      fence
    });

    const dispatched = await h.executor.stepCandidateBlock({
      rootRunId: 'root-1',
      frameKey: 'frame:cand-1',
      fence
    });
    expect(dispatched.action.kind).toBe('dispatch-candidate');
    const attemptId = dispatched.attempt?.attemptId ?? '';

    // Stepping whilecand-1 is in-flight must return noop-active (no preemption)
    const whileInFlight = await h.executor.stepCandidateBlock({
      rootRunId: 'root-1',
      frameKey: 'frame:cand-1',
      fence
    });
    expect(whileInFlight.action.kind).toBe('noop-active');

    // Settle cand-1 with retryable-transient (5_000 ms local backoff)
    await h.executor.settleCandidateAttempt({
      rootRunId: 'root-1',
      frameKey: 'frame:cand-1',
      attemptId,
      candidateId: 'cand-1',
      fence,
      outcome: 'retryable-transient',
      retryDelayMs: 5_000
    });

    // Stepping during retry-delayed local backoff must wait-backoff (not preempt with cand-2)
    const duringBackoff = await h.executor.stepCandidateBlock({
      rootRunId: 'root-1',
      frameKey: 'frame:cand-1',
      fence
    });
    expect(duringBackoff.action.kind).toBe('wait-backoff');
    expect(h.releasedSlots.length).toBeGreaterThanOrEqual(1);
  });

  async function activateRoot(
    h: ReturnType<typeof makeHarness>,
    rootRunId: string,
    connectedRunId: string,
    fence: ExecutionFence,
    rootBudget?: { readonly version: 1; readonly maxPhaseAttempts: number }
  ): Promise<void> {
    await h.admissionService.prepareRootLink({
      ledgerRunId: rootRunId,
      connectedRunId,
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence,
      ...(rootBudget !== undefined ? { rootBudget } : {})
    });
    await h.admissionService.activateRootLink({
      ledgerRunId: rootRunId,
      connectedRunId,
      fence
    });
  }

  async function initTwoCandidatePolicyFrame(
    h: ReturnType<typeof makeHarness>,
    fence: ExecutionFence,
    selectionPolicy: 'first-ready' | 'wait-for-selected' | 'stop-on-unavailability'
  ) {
    await activateRoot(h, 'root-policies', 'run-policies', fence);
    const init = await h.executor.initializeCandidateBlock({
      rootRunId: 'root-policies',
      workflowId: 'wf-1',
      frameKey: 'frame:pol',
      invocationId: 'inv-pol',
      nodeId: 'node-pol',
      selectionPolicy,
      candidates: [
        {
          candidateId: 'primary',
          nodeId: 'phase-p',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2,
          quotaIds: ['quota:claude']
        },
        {
          candidateId: 'fallback',
          nodeId: 'phase-f',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2,
          quotaIds: ['quota:codex']
        }
      ],
      fence
    });
    return { root: init.root!, frame: init.frame! };
  }

  async function dispatchSingleAttemptBlock(
    h: ReturnType<typeof makeHarness>,
    fence: ExecutionFence,
    params: {
      readonly frameKey: string;
      readonly invocationId: string;
      readonly nodeId: string;
      readonly candidateId: string;
      readonly phaseNodeId: string;
    }
  ): Promise<string> {
    await activateRoot(h, 'root-final', 'run-final', fence);
    await h.executor.initializeCandidateBlock({
      rootRunId: 'root-final',
      workflowId: 'wf-1',
      frameKey: params.frameKey,
      invocationId: params.invocationId,
      nodeId: params.nodeId,
      candidates: [
        {
          candidateId: params.candidateId,
          nodeId: params.phaseNodeId,
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 1
        }
      ],
      fence
    });
    const step = await h.executor.stepCandidateBlock({
      rootRunId: 'root-final',
      frameKey: params.frameKey,
      fence
    });
    return step.attempt!.attemptId;
  }

  it('waits for primary under wait-for-selected policy when primary is unavailable and fallback is ready', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const { root, frame } = await initTwoCandidatePolicyFrame(
      h,
      fence,
      'wait-for-selected'
    );

    const waitAction = selectNextCandidateAction({
      root,
      frame,
      nowWallMs: h.clock.nowWallMs(),
      nowMonotonicMs: h.clock.nowMonotonicMs(),
      hostEpoch: h.clock.hostEpoch,
      isSlotReady: (slot) => ({
        ready: slot.candidateId === 'fallback',
        topUpRequired: false,
        nextCheckAt: h.clock.nowWallMs() + 60_000
      })
    });
    expect(waitAction.kind).toBe('wait-availability');
    if (waitAction.kind === 'wait-availability') {
      expect(waitAction.candidateIds).toEqual(['primary']);
    }
  });

  it('pauses for intervention under stop-on-unavailability policy when primary is unavailable', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const { root, frame } = await initTwoCandidatePolicyFrame(
      h,
      fence,
      'stop-on-unavailability'
    );

    const stopAction = selectNextCandidateAction({
      root,
      frame,
      nowWallMs: h.clock.nowWallMs(),
      nowMonotonicMs: h.clock.nowMonotonicMs(),
      hostEpoch: h.clock.hostEpoch,
      isSlotReady: (slot) => ({
        ready: slot.candidateId === 'fallback',
        topUpRequired: false
      })
    });
    expect(stopAction.kind).toBe('pause-intervention');
    if (stopAction.kind === 'pause-intervention') {
      expect(stopAction.pauseCause).toBe('candidate-unavailable-stop-policy');
    }
  });

  it('switches to ready fallback under first-ready policy when selected primary is unavailable', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const { root, frame } = await initTwoCandidatePolicyFrame(
      h,
      fence,
      'first-ready'
    );

    const firstReadyAction = selectNextCandidateAction({
      root,
      frame: {
        ...frame,
        selectedCandidateId: 'primary'
      },
      nowWallMs: h.clock.nowWallMs(),
      nowMonotonicMs: h.clock.nowMonotonicMs(),
      hostEpoch: h.clock.hostEpoch,
      isSlotReady: (slot) => ({
        ready: slot.candidateId === 'fallback',
        topUpRequired: false
      })
    });
    expect(firstReadyAction.kind).toBe('dispatch-candidate');
    if (firstReadyAction.kind === 'dispatch-candidate') {
      expect(firstReadyAction.candidate.candidateId).toBe('fallback');
      expect(firstReadyAction.switchedFromCandidateId).toBe('primary');
    }
  });

  it('commits returnCommitId once with winning outputs and decisionResults on final-attempt success', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const attemptId = await dispatchSingleAttemptBlock(h, fence, {
      frameKey: 'frame:win',
      invocationId: 'inv-win',
      nodeId: 'node-win',
      candidateId: 'cand-only',
      phaseNodeId: 'phase-only'
    });

    const settled1 = await h.executor.settleCandidateAttempt({
      rootRunId: 'root-final',
      frameKey: 'frame:win',
      attemptId,
      candidateId: 'cand-only',
      fence,
      outcome: 'succeeded',
      validatedOutputs: { artifact: 'spec.md' },
      decisionResults: { approved: true }
    });
    expect(settled1.ok).toBe(true);
    expect(settled1.returnCommitted).toBe(true);
    expect(settled1.returnCommitId).toBe(`return:inv-win:${attemptId}`);
    expect(settled1.frame?.status).toBe('completed');
    expect(settled1.frame?.winningOutputs).toEqual({ artifact: 'spec.md' });
    expect(settled1.frame?.decisionResults).toEqual({ approved: true });
  });

  it('ignores duplicate settlement for an already-returned candidate block without overwriting winning outputs', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const attemptId = await dispatchSingleAttemptBlock(h, fence, {
      frameKey: 'frame:win',
      invocationId: 'inv-win',
      nodeId: 'node-win',
      candidateId: 'cand-only',
      phaseNodeId: 'phase-only'
    });

    const settled1 = await h.executor.settleCandidateAttempt({
      rootRunId: 'root-final',
      frameKey: 'frame:win',
      attemptId,
      candidateId: 'cand-only',
      fence,
      outcome: 'succeeded',
      validatedOutputs: { artifact: 'spec.md' },
      decisionResults: { approved: true }
    });
    expect(settled1.returnCommitted).toBe(true);

    const duplicateSettle = await h.executor.settleCandidateAttempt({
      rootRunId: 'root-final',
      frameKey: 'frame:win',
      attemptId,
      candidateId: 'cand-only',
      fence,
      outcome: 'succeeded',
      validatedOutputs: { artifact: 'overwritten.md' }
    });
    expect(duplicateSettle.returnCommitted).toBe(false);
    expect(duplicateSettle.frame?.winningOutputs).toEqual({
      artifact: 'spec.md'
    });
  });

  it('gives intervention-required precedence over exhaustion on invalid final-attempt output', async () => {
    const h = makeHarness();
    const fence = makeFence(1);
    const attemptId = await dispatchSingleAttemptBlock(h, fence, {
      frameKey: 'frame:invalid',
      invocationId: 'inv-invalid',
      nodeId: 'node-invalid',
      candidateId: 'cand-inv',
      phaseNodeId: 'phase-inv'
    });

    const settledInv = await h.executor.settleCandidateAttempt({
      rootRunId: 'root-final',
      frameKey: 'frame:invalid',
      attemptId,
      candidateId: 'cand-inv',
      fence,
      outcome: 'invalid-output'
    });
    expect(settledInv.ok).toBe(true);
    expect(settledInv.frame?.status).toBe('intervention-required');
    expect(settledInv.frame?.pauseCause).toBe('invalid-candidate-output');
  });

  it('counts ordinary sibling leaf dispatches toward root maxPhaseAttempts and rejects overflow', async () => {
    const h = makeHarness();
    const fence = makeFence(1);

    await activateRoot(h, 'root-cap', 'run-cap', fence, {
      version: 1,
      maxPhaseAttempts: 2
    });

    const leaf1 = await h.executor.recordOrdinaryLeafDispatch({
      rootRunId: 'root-cap',
      nodeId: 'ordinary-leaf-1',
      backend: 'claude',
      fence
    });
    expect(leaf1.ok).toBe(true);
    expect(leaf1.dispatchedAttempts).toBe(1);

    const leaf2 = await h.executor.recordOrdinaryLeafDispatch({
      rootRunId: 'root-cap',
      nodeId: 'ordinary-leaf-2',
      backend: 'claude',
      fence
    });
    expect(leaf2.ok).toBe(true);
    expect(leaf2.dispatchedAttempts).toBe(2);

    const leaf3 = await h.executor.recordOrdinaryLeafDispatch({
      rootRunId: 'root-cap',
      nodeId: 'ordinary-leaf-3',
      backend: 'claude',
      fence
    });
    expect(leaf3.ok).toBe(false);
    expect(leaf3.code).toBe('root-attempt-budget-exhausted');
  });

  it('expires waiting-availability candidate block into monitoring-expired after the 8-hour monitoring window', async () => {
    const h = makeHarness();
    const fence = makeFence(1);

    await activateRoot(h, 'root-mon', 'run-mon', fence);
    await h.executor.initializeCandidateBlock({
      rootRunId: 'root-mon',
      workflowId: 'wf-1',
      frameKey: 'frame:mon',
      invocationId: 'inv-mon',
      nodeId: 'node-mon',
      candidates: [
        {
          candidateId: 'cand-wait',
          nodeId: 'phase-wait',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          quotaIds: ['quota:claude']
        }
      ],
      fence
    });

    const waitStep = await h.executor.stepCandidateBlock({
      rootRunId: 'root-mon',
      frameKey: 'frame:mon',
      fence
    });
    expect(waitStep.action.kind).toBe('wait-availability');
    expect(waitStep.frame?.status).toBe('waiting-availability');

    h.clock.advance(MONITORING_WINDOW_DURATION_MS + 1_000);
    const expiredStep = await h.executor.stepCandidateBlock({
      rootRunId: 'root-mon',
      frameKey: 'frame:mon',
      fence
    });
    expect(expiredStep.action.kind).toBe('pause-monitoring-expired');
    expect(expiredStep.frame?.status).toBe('monitoring-expired');
  });

  it('keeps standalone Phase rate_limited transition pausing when blockOwnedRetry is omitted', () => {
    const standaloneRateLimit = transition({
      phase: 'speckit-implement',
      outcome: 'rate_limited',
      iteration: 1,
      iterationCap: 3
    });
    expect(standaloneRateLimit).toEqual({
      kind: 'halt',
      status: 'paused',
      warnings: [],
      cause: 'rate_limit'
    });
  });

  it('converts rate_limited transition to failed when blockOwnedRetry is true', () => {
    const blockOwnedRateLimit = transition({
      phase: 'speckit-implement',
      outcome: 'rate_limited',
      iteration: 1,
      iterationCap: 3,
      blockOwnedRetry: true
    });
    expect(blockOwnedRateLimit).toEqual({
      kind: 'halt',
      status: 'failed',
      warnings: [],
      cause: 'rate_limit'
    });
  });

  it('fails directly in PhaseSequencer.decideAfterPhase on transient_error when blockOwnedRetry is true', () => {
    const sequencer = new PhaseSequencer();
    const seqDecision = sequencer.decideAfterPhase({
      run: {
        id: 'run-1',
        featureId: 'feat-1',
        featureDir: '',
        status: 'running',
        currentPhase: 'speckit-implement',
        currentIteration: 1,
        startedAt: 1000,
        lastTransitionAt: 1000,
        phasesCompleted: [],
        lastError: null,
        pendingRetryAt: null,
        pendingRetryCause: null,
        delayedRetryCount: 0,
        creditPause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        phaseOverrides: [],
        phaseBreakpoints: []
      },
      output: {
        outcome: 'transient_error',
        terminationReason: 'error',
        exitCode: 1,
        stdoutSummary: '',
        stderrSummary: 'temp glitch',
        warnings: [],
        auditEntryId: null,
        result: { kind: 'malformed', warnings: [], auditEntry: null }
      },
      iteration: 1,
      iterationCap: 3,
      activePhaseDef: undefined,
      latestManualPauseAt: null,
      now: 2000,
      blockOwnedRetry: true
    });
    expect(seqDecision.kind).toBe('fail');
    if (seqDecision.kind === 'fail') {
      expect(seqDecision.decisionCause).toBe('transient_error');
    }
  });
});
