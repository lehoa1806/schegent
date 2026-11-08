import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROL_LEDGER_VERSION,
  type CandidateRuntimeSlot,
  type ControlFrame,
  type ControlFrameStatus,
  type ControlLedger,
  type RootControlState
} from '../../src/contracts/control-ledger';
import type {
  ControlAction,
  ControlCommandAcknowledgement,
  ControlCommandEnvelope
} from '../../src/contracts/sidebar-ipc/workflow-run';
import {
  continueWorkflowRun,
  executeWorkflowControlCommand
} from '../../src/headless/workflow-run-api';
import { ControlCommandService } from '../../src/services/workflow-execution/control-command-service';
import {
  continueConnectedRun,
  type ContinuationDeps
} from '../../src/services/workflow-execution/continuation-service';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import { KEYS, type Memento } from '../../src/state/workspace-state';

const ROOT_RUN_ID = 'root-parity-f31';
const QUEUE_ID = 'default';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';

function createMemoryStore(initialLedger: ControlLedger): ControlLedgerStore {
  const data = new Map<string, unknown>([[KEYS.controlLedger, initialLedger]]);
  const memento: Memento = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    }
  };
  return new ControlLedgerStore(memento);
}

function makeUuid(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}

function makeSlots(): readonly CandidateRuntimeSlot[] {
  return Object.freeze([
    Object.freeze({
      candidateId: 'cand-1',
      nodeId: 'phase-cand-1',
      backend: 'claude',
      priority: 1,
      authoredOrder: 0,
      dispatchedAttempts: 0,
      maxAttempts: 3,
      status: 'eligible',
      allowUnverifiedTrial: true,
      observationIds: ['obs:cand-1']
    }),
    Object.freeze({
      candidateId: 'cand-2',
      nodeId: 'phase-cand-2',
      backend: 'codex',
      priority: 2,
      authoredOrder: 1,
      dispatchedAttempts: 0,
      maxAttempts: 3,
      status: 'eligible',
      allowUnverifiedTrial: false,
      observationIds: ['obs:cand-2']
    })
  ]);
}

function makeFrame(
  status: ControlFrameStatus = 'waiting-availability',
  overrides: Partial<ControlFrame> = {}
): ControlFrame {
  return Object.freeze({
    frameKey: INVOCATION_ID,
    parentFrameKey: null,
    invocationId: INVOCATION_ID,
    workflowId: 'wf-parity-f31',
    nodeId: 'cand-block-parity',
    kind: 'candidate-block',
    status,
    frameGeneration: 1,
    selectionPolicy: 'first-ready',
    candidateSlots: makeSlots(),
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
    rootWorkflowId: 'wf-parity-f31',
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
      primacyClaim: 'win-1',
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
    framesByKey: Object.freeze({ [frame.frameKey]: frame }),
    attemptsById: Object.freeze({}),
    commandReceipts: Object.freeze([]),
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  });
}

describe('Editor vs Headless Candidate Control Parity (FR-R5-F31)', () => {
  let nowWallMs: number;
  let nowMonoMs: number;

  beforeEach(() => {
    nowWallMs = 20_000;
    nowMonoMs = 8_000;
  });

  async function runEditorAndHeadless(input: {
    readonly frame: ControlFrame;
    readonly rootOverrides?: Partial<RootControlState>;
    readonly command: ControlCommandEnvelope;
    readonly isTrusted?: boolean;
  }): Promise<{
    readonly editorAck: ControlCommandAcknowledgement;
    readonly headlessAck: ControlCommandAcknowledgement;
  }> {
    const trusted = input.isTrusted ?? true;
    const initialRoot = makeRoot(input.frame, input.rootOverrides);
    const initialLedger: ControlLedger = {
      version: CONTROL_LEDGER_VERSION,
      revision: 1,
      nextWaitSequence: 1,
      roots: { [ROOT_RUN_ID]: initialRoot },
      quotaObservations: {},
      checks: {},
      waiters: [],
      permits: {}
    };

    const editorStore = createMemoryStore(initialLedger);
    const headlessStore = createMemoryStore(initialLedger);

    const clock = {
      nowWallMs: () => nowWallMs,
      nowMonotonicMs: () => nowMonoMs,
      hostEpoch: 'epoch-parity'
    };

    const editorService = new ControlCommandService({
      ledgerStore: editorStore,
      clock,
      isTrusted: () => trusted
    });

    const continuationDeps: ContinuationDeps = {
      controlCommandService: editorService,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        sanitize: (s: string) => s
      } as unknown as ContinuationDeps['logger'],
      projectRun: () =>
        ({
          connectedRunId: ROOT_RUN_ID,
          workflowId: 'wf-parity-f31',
          revision: 1,
          nodes: []
        }) as unknown as ReturnType<ContinuationDeps['projectRun']>,
      isNodeStartable: () => true
    } as unknown as ContinuationDeps;

    const editorResult = await continueConnectedRun(continuationDeps, {
      payload: {
        connectedRunId: input.command.rootRunId,
        expectedRevision: input.command.expectedGeneration,
        nodeId: input.command.invocationId,
        invocationId: input.command.invocationId,
        commandId: input.command.commandId,
        controlCommand: input.command,
        request: {
          pipelineId: input.command.invocationId,
          inputs: [],
          supplemental: [],
          outputs: []
        }
      },
      workspaceRoot: '/workspace',
      startedAt: nowWallMs
    });

    expect(editorResult.outcome).toBe('control-acknowledged');
    if (editorResult.outcome !== 'control-acknowledged') {
      throw new Error(`Unexpected editor outcome: ${editorResult.outcome}`);
    }

    const headlessAck = await executeWorkflowControlCommand(
      {
        ledgerStore: headlessStore,
        clock,
        isTrusted: () => trusted
      },
      input.command
    );

    // Also verify continueWorkflowRun headless entrypoint yields identical control-acknowledged result
    const headlessStore2 = createMemoryStore(initialLedger);
    const viaContinueRun = await continueWorkflowRun(
      {
        ...continuationDeps,
        controlCommandService: new ControlCommandService({
          ledgerStore: headlessStore2,
          clock,
          isTrusted: () => trusted
        })
      },
      {
        payload: {
          connectedRunId: input.command.rootRunId,
          expectedRevision: input.command.expectedGeneration,
          nodeId: input.command.invocationId,
          invocationId: input.command.invocationId,
          commandId: input.command.commandId,
          controlCommand: input.command,
          request: {
            pipelineId: input.command.invocationId,
            inputs: [],
            supplemental: [],
            outputs: []
          }
        },
        workspaceRoot: '/workspace',
        startedAt: nowWallMs
      }
    );
    expect(viaContinueRun).toEqual({
      outcome: 'control-acknowledged',
      acknowledgement: headlessAck
    });

    return {
      editorAck: editorResult.acknowledgement,
      headlessAck
    };
  }

  it('produces identical accepted/refused acknowledgements and projections across all 9 actions in waiting-availability, paused, executing, and completed states', async () => {
    const actions: readonly ControlAction[] = [
      { kind: 'check-now', candidateId: 'cand-1' },
      { kind: 'try-now', candidateId: 'cand-1' },
      { kind: 'try-now', candidateId: 'cand-2' },
      { kind: 'select-candidate', candidateId: 'cand-2' },
      { kind: 'set-policy', availabilityPolicy: 'wait-for-selected' },
      { kind: 'set-allowed-candidates', candidateIds: ['cand-1'] },
      { kind: 'renew-monitoring', durationMs: 180_000 },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'cancel' }
    ];

    for (const status of ['waiting-availability', 'paused', 'executing', 'completed'] as const) {
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        const command: ControlCommandEnvelope = {
          version: 1,
          commandId: makeUuid(i + 1),
          rootRunId: ROOT_RUN_ID,
          queueId: QUEUE_ID,
          invocationId: INVOCATION_ID,
          expectedGeneration: 1,
          action
        };
        const { editorAck, headlessAck } = await runEditorAndHeadless({
          frame: makeFrame(status),
          command
        });
        expect(editorAck).toEqual(headlessAck);
      }
    }
  });

  it('produces identical trust-denied refusals and legalActions when workspace trust is false (AC-10)', async () => {
    const command: ControlCommandEnvelope = {
      version: 1,
      commandId: makeUuid(50),
      rootRunId: ROOT_RUN_ID,
      queueId: QUEUE_ID,
      invocationId: INVOCATION_ID,
      expectedGeneration: 1,
      action: { kind: 'try-now', candidateId: 'cand-1' }
    };

    const { editorAck, headlessAck } = await runEditorAndHeadless({
      frame: makeFrame('waiting-availability'),
      command,
      isTrusted: false
    });

    expect(editorAck).toEqual(headlessAck);
    expect(editorAck.outcome).toBe('refused');
    expect(editorAck.reason).toBe('trust-denied');
    expect(
      editorAck.projection?.legalActions.every(
        (entry) => !entry.allowed && entry.reason === 'trust-denied'
      )
    ).toBe(true);
  });
});
