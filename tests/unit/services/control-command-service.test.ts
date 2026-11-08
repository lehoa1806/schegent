import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_LEDGER_VERSION,
  MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT,
  type CandidateRuntimeSlot,
  type ControlFrame,
  type ControlFrameStatus,
  type ControlLedger,
  type RootControlState
} from '../../../src/contracts/control-ledger';
import type {
  ControlAction,
  ControlCommandEnvelope
} from '../../../src/contracts/sidebar-ipc/workflow-run';
import { KEYS, type Memento } from '../../../src/state/workspace-state';
import { selectNextCandidateAction } from '../../../src/services/workflow-execution/candidate-block-executor';
import {
  ControlCommandService,
  evaluateControlActionLegality
} from '../../../src/services/workflow-execution/control-command-service';
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import { WorkflowControlService } from '../../../src/services/workflow-execution/workflow-control-service';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';

const ROOT_RUN_ID = 'root-run-f31';
const QUEUE_ID = 'default';
const INVOCATION_ID = '11111111-1111-4111-8111-111111111111';

function createMemoryMemento(initialLedger?: ControlLedger): {
  readonly memento: Memento;
  readonly writeLedger: (ledger: ControlLedger) => void;
} {
  const data = new Map<string, unknown>();
  if (initialLedger !== undefined) {
    data.set(KEYS.controlLedger, initialLedger);
  }
  const memento: Memento = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    }
  };
  return {
    memento,
    writeLedger: (ledger: ControlLedger) => {
      data.set(KEYS.controlLedger, ledger);
    }
  };
}

function makeUuid(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function makeCandidateSlots(overrides?: {
  cand1?: Partial<CandidateRuntimeSlot>;
  cand2?: Partial<CandidateRuntimeSlot>;
}): readonly CandidateRuntimeSlot[] {
  const cand1: CandidateRuntimeSlot = Object.freeze({
    candidateId: 'cand-1',
    nodeId: 'phase-cand-1',
    backend: 'claude',
    priority: 1,
    authoredOrder: 0,
    dispatchedAttempts: 0,
    maxAttempts: 3,
    status: 'eligible',
    allowUnverifiedTrial: true,
    ...overrides?.cand1
  });
  const cand2: CandidateRuntimeSlot = Object.freeze({
    candidateId: 'cand-2',
    nodeId: 'phase-cand-2',
    backend: 'codex',
    priority: 2,
    authoredOrder: 1,
    dispatchedAttempts: 0,
    maxAttempts: 3,
    status: 'eligible',
    allowUnverifiedTrial: false,
    ...overrides?.cand2
  });
  return Object.freeze([cand1, cand2]);
}

function makeFrame(
  status: ControlFrameStatus = 'waiting-availability',
  overrides: Partial<ControlFrame> = {}
): ControlFrame {
  return Object.freeze({
    frameKey: INVOCATION_ID,
    parentFrameKey: null,
    invocationId: INVOCATION_ID,
    workflowId: 'wf-f31',
    nodeId: 'cand-block-1',
    kind: 'candidate-block',
    status,
    frameGeneration: 1,
    selectionPolicy: 'first-ready',
    candidateSlots: makeCandidateSlots(),
    selectedCandidateId: 'cand-1',
    dispatchedCount: 0,
    maxDispatches: 6,
    monitoringStartedAt: 1_000,
    monitoringExpiresAt: 600_000,
    monitoringRenewals: 0,
    waitStateReleasedSlot: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  });
}

function makeRoot(
  frame: ControlFrame = makeFrame(),
  overrides: Partial<RootControlState> = {}
): RootControlState {
  return Object.freeze({
    version: CONTROL_LEDGER_VERSION,
    ledgerRunId: ROOT_RUN_ID,
    connectedRunId: ROOT_RUN_ID,
    rootWorkflowId: 'wf-f31',
    queueId: QUEUE_ID,
    linkState:
      frame.status === 'completed' || frame.status === 'failed' || frame.status === 'canceled'
        ? 'terminal'
        : 'active',
    status:
      frame.status === 'paused' ||
      frame.status === 'intervention-required' ||
      frame.status === 'monitoring-expired'
        ? 'paused'
        : frame.status === 'completed'
          ? 'completed'
          : frame.status === 'failed'
            ? 'failed'
            : frame.status === 'canceled'
              ? 'canceled'
              : 'in-flight',
    fence: Object.freeze({
      primacyClaim: 'win-primary',
      queueClaim: 'lease-1',
      rootGeneration: frame.frameGeneration ?? 1
    }),
    rootBudget: Object.freeze({
      version: 1,
      maxPhaseAttempts: 16,
      maxCandidateCheckProbes: 64,
      maxWallClockMs: 3_600_000,
      budgetMode: 'strict-usd',
      maxMicrousd: 10_000_000
    }),
    dispatchedAttempts: 0,
    settledMicrousd: 0,
    reservedMicrousd: 0,
    framesByKey: Object.freeze({
      [frame.frameKey]: frame
    }),
    attemptsById: Object.freeze({}),
    commandReceipts: Object.freeze([]),
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  });
}

function makeCommand(
  action: ControlAction,
  overrides: Partial<ControlCommandEnvelope> = {}
): ControlCommandEnvelope {
  return Object.freeze({
    version: 1,
    commandId: makeUuid(1),
    rootRunId: ROOT_RUN_ID,
    queueId: QUEUE_ID,
    invocationId: INVOCATION_ID,
    expectedGeneration: 1,
    action,
    ...overrides
  });
}

describe('ControlCommandService & D8 Action/State Matrix (FR-R5-F31)', () => {
  let store: ControlLedgerStore;
  let writeLedger: (ledger: ControlLedger) => void;
  let nowWallMs: number;
  let nowMonoMs: number;

  beforeEach(() => {
    nowWallMs = 10_000;
    nowMonoMs = 5_000;
    const mem = createMemoryMemento();
    writeLedger = mem.writeLedger;
    store = new ControlLedgerStore(mem.memento);
  });

  function seedLedger(
    frame: ControlFrame = makeFrame(),
    rootOverrides: Partial<RootControlState> = {},
    checks: ControlLedger['checks'] = {}
  ): RootControlState {
    const root = makeRoot(frame, rootOverrides);
    const ledger: ControlLedger = {
      version: CONTROL_LEDGER_VERSION,
      revision: 1,
      nextWaitSequence: 1,
      roots: { [ROOT_RUN_ID]: root },
      quotaObservations: {},
      checks,
      waiters: [],
      permits: {}
    };
    writeLedger(ledger);
    return root;
  }

  function createService(
    overrides: Partial<ConstructorParameters<typeof ControlCommandService>[0]> = {}
  ): ControlCommandService {
    return new ControlCommandService({
      ledgerStore: store,
      clock: {
        nowWallMs: () => nowWallMs,
        nowMonotonicMs: () => nowMonoMs,
        hostEpoch: 'epoch-1'
      },
      isTrusted: () => true,
      ...overrides
    });
  }

  it('evaluates the complete 9-action x 11-state legality matrix deterministically', () => {
    const allStates: readonly ControlFrameStatus[] = [
      'selecting',
      'dispatch-pending',
      'executing',
      'retry-delayed',
      'waiting-availability',
      'intervention-required',
      'monitoring-expired',
      'paused',
      'completed',
      'failed',
      'canceled'
    ];

    const sampleActions: readonly ControlAction[] = [
      { kind: 'check-now', candidateId: 'cand-1' },
      { kind: 'try-now', candidateId: 'cand-1' },
      { kind: 'select-candidate', candidateId: 'cand-2' },
      { kind: 'set-policy', availabilityPolicy: 'wait-for-selected' },
      { kind: 'set-allowed-candidates', candidateIds: ['cand-1'] },
      { kind: 'renew-monitoring', durationMs: 120_000 },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'cancel' }
    ];

    const expectedAllowedByState: Record<ControlFrameStatus, ReadonlySet<ControlAction['kind']>> = {
      'in-flight': new Set(),
      'waiting-permit': new Set(),
      'waiting-handoff': new Set(),
      selecting: new Set([
        'check-now',
        'try-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'pause',
        'cancel'
      ]),
      'dispatch-pending': new Set(['pause', 'cancel']),
      executing: new Set(['pause', 'cancel']),
      'retry-delayed': new Set([
        'check-now',
        'try-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'pause',
        'cancel'
      ]),
      'waiting-availability': new Set([
        'check-now',
        'try-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'pause',
        'cancel'
      ]),
      'intervention-required': new Set([
        'check-now',
        'try-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'resume',
        'cancel'
      ]),
      'monitoring-expired': new Set([
        'check-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'resume',
        'cancel'
      ]),
      paused: new Set([
        'check-now',
        'select-candidate',
        'set-policy',
        'set-allowed-candidates',
        'renew-monitoring',
        'resume',
        'cancel'
      ]),
      completed: new Set([]),
      failed: new Set([]),
      canceled: new Set([])
    };

    for (const status of allStates) {
      const frame = makeFrame(status, {
        monitoringExpiresAt: 600_000
      });
      const root = makeRoot(frame);
      const ledger: ControlLedger = {
        version: CONTROL_LEDGER_VERSION,
        revision: 1,
        nextWaitSequence: 1,
        roots: { [ROOT_RUN_ID]: root },
        quotaObservations: {},
        checks: {},
        waiters: [],
        permits: {}
      };

      for (const action of sampleActions) {
        const decision = evaluateControlActionLegality({
          root,
          frame,
          ledger,
          action,
          nowWallMs,
          isTrusted: true
        });
        const shouldAllow = expectedAllowedByState[status].has(action.kind);
        expect(
          decision.allowed,
          `state=${status}, action=${action.kind} expected allowed=${shouldAllow}`
        ).toBe(shouldAllow);
      }
    }
  });

  it('deduplicates identical commandId + payload and refuses modified payload with the same commandId', async () => {
    seedLedger(makeFrame('waiting-availability'));
    const service = createService();

    const cmd = makeCommand({
      kind: 'set-policy',
      availabilityPolicy: 'wait-for-selected'
    });

    const first = await service.executeControlCommand(cmd);
    expect(first.outcome).toBe('accepted');
    expect(first.generation).toBe(2);
    expect(first.projection?.availabilityPolicy).toBe('wait-for-selected');

    // Duplicate command with identical payload returns the persisted accepted outcome
    // even though current generation is now 2 and cmd.expectedGeneration is 1.
    const replay = await service.executeControlCommand(cmd);
    expect(replay.outcome).toBe('accepted');
    expect(replay.generation).toBe(2);
    expect(store.getRoot(ROOT_RUN_ID)?.fence.rootGeneration).toBe(2);

    // Same commandId with a modified payload is refused with `invalid-command`
    const mutatedPayload = makeCommand({
      kind: 'set-policy',
      availabilityPolicy: 'stop-on-unavailability'
    });
    const refused = await service.executeControlCommand(mutatedPayload);
    expect(refused.outcome).toBe('refused');
    expect(refused.reason).toBe('invalid-command');
    expect(store.getRoot(ROOT_RUN_ID)?.fence.rootGeneration).toBe(2);
  });

  it('enforces the 256-receipt ring cap and receiptHighWaterGeneration against evicted command replay', async () => {
    seedLedger(makeFrame('waiting-availability'));
    const service = createService();

    const totalCommands = MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT + 5;
    for (let i = 1; i <= totalCommands; i++) {
      const ack = await service.executeControlCommand(
        makeCommand(
          {
            kind: 'set-policy',
            availabilityPolicy: i % 2 === 0 ? 'first-ready' : 'wait-for-selected'
          },
          {
            commandId: makeUuid(i),
            expectedGeneration: i
          }
        )
      );
      expect(ack.outcome).toBe('accepted');
      expect(ack.generation).toBe(i + 1);
    }

    const rootAfter = store.getRoot(ROOT_RUN_ID)!;
    expect(rootAfter.commandReceipts).toHaveLength(MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT);
    expect(rootAfter.receiptHighWaterGeneration).toBe(6);

    // Replaying evicted command #1 (expectedGeneration: 1 <= receiptHighWaterGeneration: 6)
    // is rejected as `stale-generation` and cannot re-apply.
    const evictedReplay = await service.executeControlCommand(
      makeCommand(
        {
          kind: 'set-policy',
          availabilityPolicy: 'wait-for-selected'
        },
        {
          commandId: makeUuid(1),
          expectedGeneration: 1
        }
      )
    );
    expect(evictedReplay.outcome).toBe('refused');
    expect(evictedReplay.reason).toBe('stale-generation');
  });

  it('executes check-now without consuming attempt budgets or resuming a pause, and enforces check-rate-limited', async () => {
    const onCheckNow = vi.fn();
    seedLedger(
      makeFrame('paused', {
        candidateSlots: makeCandidateSlots({
          cand1: { observationIds: ['obs:cand-1'] }
        })
      }),
      { pauseCause: 'operator-pause' }
    );
    const service = createService({ onCheckNow });

    const ack = await service.executeControlCommand(
      makeCommand({ kind: 'check-now', candidateId: 'cand-1' })
    );
    expect(ack.outcome).toBe('accepted');
    expect(ack.generation).toBe(2);
    expect(onCheckNow).toHaveBeenCalledWith({
      rootRunId: ROOT_RUN_ID,
      invocationId: INVOCATION_ID,
      candidateIds: ['cand-1']
    });

    const rootAfter = store.getRoot(ROOT_RUN_ID)!;
    const frameAfter = rootAfter.framesByKey[INVOCATION_ID]!;
    expect(frameAfter.status).toBe('paused');
    expect(frameAfter.dispatchedCount).toBe(0);
    expect(rootAfter.dispatchedAttempts).toBe(0);

    // Immediate second check-now within MIN_CHECK_START_INTERVAL_MS is rate-limited
    const secondAck = await service.executeControlCommand(
      makeCommand(
        { kind: 'check-now', candidateId: 'cand-1' },
        { commandId: makeUuid(2), expectedGeneration: 2 }
      )
    );
    expect(secondAck.outcome).toBe('refused');
    expect(secondAck.reason).toBe('check-rate-limited');
  });

  it('enforces try-now configuration, not-before deadline, and counted attempt admission', async () => {
    const frame = makeFrame('waiting-availability', {
      candidateSlots: makeCandidateSlots({
        cand1: { allowUnverifiedTrial: true, nextEligibleAt: 20_000 },
        cand2: { allowUnverifiedTrial: false }
      })
    });
    seedLedger(frame);
    const service = createService();

    // 1. Candidate without allowUnverifiedTrial refuses as `candidate-ineligible`
    const unconfigured = await service.executeControlCommand(
      makeCommand({ kind: 'try-now', candidateId: 'cand-2' }, { commandId: makeUuid(10) })
    );
    expect(unconfigured.outcome).toBe('refused');
    expect(unconfigured.reason).toBe('candidate-ineligible');

    // 2. Candidate before nextEligibleAt refuses as `not-before`
    const beforeDeadline = await service.executeControlCommand(
      makeCommand({ kind: 'try-now', candidateId: 'cand-1' }, { commandId: makeUuid(11) })
    );
    expect(beforeDeadline.outcome).toBe('refused');
    expect(beforeDeadline.reason).toBe('not-before');

    // 3. Advance clock past nextEligibleAt -> try-now is accepted and counts as a Phase attempt
    nowWallMs = 25_000;
    const accepted = await service.executeControlCommand(
      makeCommand({ kind: 'try-now', candidateId: 'cand-1' }, { commandId: makeUuid(12) })
    );
    expect(accepted.outcome).toBe('accepted');
    const rootAfter = store.getRoot(ROOT_RUN_ID)!;
    const frameAfter = rootAfter.framesByKey[INVOCATION_ID]!;
    const slotAfter = (frameAfter.candidateSlots ?? []).find((s) => s.candidateId === 'cand-1')!;
    expect(slotAfter.dispatchedAttempts).toBe(1);
    expect(frameAfter.dispatchedCount).toBe(1);
    expect(rootAfter.dispatchedAttempts).toBe(1);
    expect(frameAfter.status).toBe('dispatch-pending');
  });

  it('persists manualSelectionCandidateId for lower-priority candidate under first-ready so first-ready does not override it', async () => {
    seedLedger(makeFrame('waiting-availability'));
    const service = createService();

    // Select lower-priority cand-2 while selectionPolicy is 'first-ready'
    const ack = await service.executeControlCommand(
      makeCommand({ kind: 'select-candidate', candidateId: 'cand-2' })
    );
    expect(ack.outcome).toBe('accepted');
    expect(ack.projection?.manualSelectionCandidateId).toBe('cand-2');

    // Even when cand-1 is ready and cand-2 is NOT yet ready, selectNextCandidateAction
    // waits on cand-2 rather than falling back to cand-1!
    const rootWithManual = store.getRoot(ROOT_RUN_ID)!;
    const frameWithManual = rootWithManual.framesByKey[INVOCATION_ID]!;
    const waitDecision = selectNextCandidateAction({
      root: rootWithManual,
      frame: frameWithManual,
      nowWallMs,
      nowMonotonicMs: nowMonoMs,
      hostEpoch: 'epoch-1',
      isSlotReady: (slot) => ({
        ready: slot.candidateId === 'cand-1',
        topUpRequired: false
      })
    });
    expect(waitDecision.kind).toBe('wait-availability');
    if (waitDecision.kind === 'wait-availability') {
      expect(waitDecision.candidateIds).toEqual(['cand-2']);
    }

    // Once cand-2 is ready, selectNextCandidateAction dispatches cand-2 (switched from cand-1)
    const dispatchDecision = selectNextCandidateAction({
      root: rootWithManual,
      frame: frameWithManual,
      nowWallMs,
      nowMonotonicMs: nowMonoMs,
      hostEpoch: 'epoch-1',
      isSlotReady: () => ({
        ready: true,
        topUpRequired: false
      })
    });
    expect(dispatchDecision.kind).toBe('dispatch-candidate');
    if (dispatchDecision.kind === 'dispatch-candidate') {
      expect(dispatchDecision.candidate.candidateId).toBe('cand-2');
    }
  });

  it('validates renew-monitoring duration bounds (60,000..172,800,000 ms) and does not resume a paused frame', async () => {
    seedLedger(
      makeFrame('paused', {
        monitoringExpiresAt: 5_000,
        dispatchedCount: 2
      }),
      { pauseCause: 'operator-pause' }
    );
    const service = createService();

    // Below 60,000 ms -> refused as `invalid-command`
    const tooShort = await service.executeControlCommand({
      ...makeCommand({ kind: 'renew-monitoring', durationMs: 59_999 }),
      commandId: makeUuid(20)
    });
    expect(tooShort.outcome).toBe('refused');
    expect(tooShort.reason).toBe('invalid-command');

    // Above 172,800,000 ms -> refused as `invalid-command`
    const tooLong = await service.executeControlCommand({
      ...makeCommand({ kind: 'renew-monitoring', durationMs: 172_800_001 }),
      commandId: makeUuid(21)
    });
    expect(tooLong.outcome).toBe('refused');
    expect(tooLong.reason).toBe('invalid-command');

    // Exact lower bound 60,000 ms -> accepted, updates monitoringExpiresAt & renewals,
    // keeps status === 'paused' and preserves attempt counters
    const validRenew = await service.executeControlCommand(
      makeCommand(
        { kind: 'renew-monitoring', durationMs: 60_000 },
        { commandId: makeUuid(22) }
      )
    );
    expect(validRenew.outcome).toBe('accepted');
    const frameAfter = store.getRoot(ROOT_RUN_ID)!.framesByKey[INVOCATION_ID]!;
    expect(frameAfter.status).toBe('paused');
    expect(frameAfter.monitoringExpiresAt).toBe(nowWallMs + 60_000);
    expect(frameAfter.monitoringRenewals).toBe(1);
    expect(frameAfter.dispatchedCount).toBe(2);
  });

  it('redirects generic retry-phase on a candidate-block-owned invocation through ControlCommandService', async () => {
    // Seed a candidate frame whose candidates are all exhausted
    const exhaustedFrame = makeFrame('waiting-availability', {
      candidateSlots: makeCandidateSlots({
        cand1: {
          status: 'exhausted',
          dispatchedAttempts: 3,
          maxAttempts: 3,
          retirementReason: 'attempts-exhausted'
        },
        cand2: {
          status: 'exhausted',
          dispatchedAttempts: 3,
          maxAttempts: 3,
          retirementReason: 'attempts-exhausted'
        }
      })
    });
    seedLedger(exhaustedFrame);
    const controlCommandService = createService();

    const connectedRun: ConnectedWorkflowRun = {
      connectedRunId: ROOT_RUN_ID,
      workflowId: 'wf-f31',
      revision: 1,
      startedAt: 1_000,
      queueId: QUEUE_ID,
      graph: { workflowId: 'wf-f31', name: 'WF F31', version: 1, nodes: [], connections: [], startNodeIds: [] },
      pipelines: {},
      nodes: {},
      decisions: [],
      invocations: {
        [INVOCATION_ID]: {
          invocationId: INVOCATION_ID,
          rootRunId: ROOT_RUN_ID,
          parentInvocationId: null,
          parentCallNodeId: null,
          parentAttemptId: null,
          workflowId: 'wf-f31',
          depth: 0,
          nodePath: '/cand-block-1',
          entryNodeId: 'cand-1',
          activeNodeId: 'cand-1',
          status: 'failed',
          startedAt: 1_000,
          boundInputs: {},
          decisions: [],
          resolvedOutputs: {},
          attemptsByNodeId: {
            'cand-1': [
              {
                attemptId: 'att-1',
                attemptIndex: 1,
                rootRunId: ROOT_RUN_ID,
                invocationId: INVOCATION_ID,
                parentInvocationId: null,
                nodeId: 'cand-1',
                nodeKind: 'phase',
                targetDefinitionId: 'phase-cand-1',
                nodePath: '/cand-block-1/cand-1',
                status: 'failed',
                startedAt: 1_000,
                completedAt: 2_000,
                inputEnvelope: {
                  envelopeId: 'env-1',
                  invocationId: INVOCATION_ID,
                  targetNodeId: 'cand-1',
                  source: 'launch',
                  inputsByPort: {},
                  localInputs: [],
                  outputTargetOverrides: [],
                  acceptedAt: 1_000
                },
                declaredOutputs: {}
              }
            ]
          }
        }
      }
    };

    const dispatchPhase = vi.fn();
    const wfControl = new WorkflowControlService({
      connectedRuns: {
        get: () => connectedRun,
        compareAndSetConnectedRun: async (next) => ({ outcome: 'written', run: next })
      },
      dispatchPhase,
      controlCommandService
    });

    const outcome = await wfControl.executeCommand({
      runId: ROOT_RUN_ID,
      commandId: makeUuid(99),
      expectedRevision: 1,
      operation: 'retry-phase',
      targetInvocationId: INVOCATION_ID,
      targetNodeId: 'cand-1',
      now: nowWallMs
    });

    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(outcome.refusalCode).toBe('retry-bound-exceeded');
    }
    expect(dispatchPhase).not.toHaveBeenCalled();
  });
});
