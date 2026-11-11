/**
 * FR-R5-F26 (SPEC-04, D4, WF-04, WF-05, WF-06, WF-11..14, WF-17, AC-08..10, AC-19) —
 * Durable control attempt admission and crash-window reconciliation service.
 *
 * Invariants:
 * - `prepareAttempt` has zero durable side effects and mutates no counters, permits,
 *   or waiters.
 * - `commitAttempt` atomically writes the attempt (`pending-dispatch`), increments
 *   root/frame counters, updates candidate selection, creates any execution permit,
 *   and removes any satisfied waiter in a single serialized `ControlLedger` write.
 * - `recordSpawnIntent` re-verifies the `ExecutionFence` immediately before child
 *   process spawn.
 * - Missing queue item / process evidence after crash is never treated as proof for
 *   blind automatic replay; uncertain side-effecting attempts pause with
 *   `recovery-uncertain-effect` and hold their permit in `held-uncertain` regardless
 *   of wall-clock or monotonic time passage.
 * - Zero `vscode` imports.
 */

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  UNKNOWN_LOCAL_QUOTA_ID,
  isQuotaObservationFreshReady
} from '../../contracts/backend-availability';
import {
  CONTROL_LEDGER_VERSION,
  MAX_FRAMES_PER_ROOT,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES,
  executionFencesEqual,
  isValidExecutionFence,
  type ConnectedRunControlLink,
  type ControlAdmissionPort,
  type ControlAttemptRecord,
  type ControlAttemptTerminalStatus,
  type ControlClockPort,
  type ControlFrame,
  type ControlLedger,
  type ControlLedgerErrorCode,
  type ControlPolicySnapshotPort,
  type CommitControlAttemptOutcome,
  type ExecutionFence,
  type ExecutionPermitRecord,
  type PrepareControlAttemptInput,
  type PrepareControlAttemptOutcome,
  type PreparedControlAttemptToken,
  type ProcessEvidencePort,
  type RootControlState
} from '../../contracts/control-ledger';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import {
  DEFAULT_ROOT_MAX_PHASE_ATTEMPTS,
  WORKFLOW_CONTROL_SCHEMA_VERSION,
  type RootControlBudget
} from '../../contracts/workflow-controls';
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';
import { fromObservationRecord } from '../backend-availability-service';
import {
  ControlLedgerStore,
  lookupRecord,
  measureRootLedgerBytes
} from './control-ledger-store';
import { quotaIdSetsEqual, sortQuotaIds } from './quota-permit-arbiter';

export interface ControlAttemptAdmissionDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock?: ControlClockPort | undefined;
  readonly policyPort?: ControlPolicySnapshotPort | undefined;
  readonly processEvidencePort?: ProcessEvidencePort | undefined;
  readonly hasProcessCapacity?: (() => boolean) | undefined;
  readonly verifyLiveFence?: (
    fence: ExecutionFence,
    context: { readonly ledgerRunId: string; readonly queueId: string }
  ) => Promise<boolean> | boolean;
}

export interface PrepareRootLinkInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly rootWorkflowId: string;
  readonly queueId: string;
  readonly fence: ExecutionFence;
  readonly rootBudget?: RootControlBudget;
  readonly rootFrameKey?: string;
  readonly rootInvocationId?: string;
}

export type PrepareRootLinkOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly root: RootControlState;
      readonly controlState: ConnectedRunControlLink;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export interface ActivateRootLinkInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly fence: ExecutionFence;
}

export type ActivateRootLinkOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly root: RootControlState;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export interface RecordSpawnIntentInput {
  readonly ledgerRunId: string;
  readonly attemptId: string;
  readonly fence: ExecutionFence;
  readonly queueItemId?: string;
  readonly hasSideEffects?: boolean;
}

export interface RecordAttemptStartedInput {
  readonly ledgerRunId: string;
  readonly attemptId: string;
  readonly fence: ExecutionFence;
  readonly queueItemId?: string;
  readonly pid?: number;
}

export interface RecordAttemptStartupFailureInput {
  readonly ledgerRunId: string;
  readonly attemptId: string;
  readonly fence: ExecutionFence;
  readonly failureCode: string;
  readonly failureMessage?: string;
}

export interface SettleControlAttemptInput {
  readonly ledgerRunId: string;
  readonly attemptId: string;
  readonly fence: ExecutionFence;
  readonly terminalStatus: ControlAttemptTerminalStatus;
  readonly settledMicrousd?: number | undefined;
  readonly failureCode?: string | undefined;
  readonly failureMessage?: string | undefined;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly holdPermitUncertain?: boolean | undefined;
  readonly uncertainReason?: string | undefined;
  readonly allowCurrentOwnerTeardownAfterGenerationAdvance?: boolean | undefined;
}

export type AttemptTransitionOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly root: RootControlState;
      readonly attempt: ControlAttemptRecord;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export type ReconcileControlRootDisposition =
  | 'noop'
  | 'cleaned-prepared-root'
  | 'activated-prepared-root'
  | 'missing-ledger-root'
  | 'reattached-running-attempt'
  | 'settled-from-evidence'
  | 'failed-pre-spawn-attempt'
  | 'paused-uncertain-effect';

export interface ReconcileControlRootInput {
  readonly ledgerRunId: string;
  readonly connectedRun: ConnectedWorkflowRun | null;
  readonly newFence: ExecutionFence;
}

export interface ReconcileControlRootResult {
  readonly ok: boolean;
  readonly disposition: ReconcileControlRootDisposition;
  readonly ledger?: ControlLedger;
  readonly root?: RootControlState;
  readonly affectedAttemptIds: readonly string[];
  readonly pauseCause?: string;
  readonly errorCode?: ControlLedgerErrorCode;
  readonly message?: string;
}

const DEFAULT_CLOCK: ControlClockPort = {
  nowWallMs: () => Date.now(),
  nowMonotonicMs: () => Date.now()
};

function defaultRootBudget(): RootControlBudget {
  return Object.freeze({
    version: WORKFLOW_CONTROL_SCHEMA_VERSION,
    maxPhaseAttempts: DEFAULT_ROOT_MAX_PHASE_ATTEMPTS
  });
}

export const ADMISSION_CONSUMED_TOKENS_MAX = 4_096;

export class ControlAttemptAdmissionService implements ControlAdmissionPort {
  private readonly store: ControlLedgerStore;
  private readonly clock: ControlClockPort;
  private readonly policyPort: ControlPolicySnapshotPort | undefined;
  private readonly processEvidencePort: ProcessEvidencePort | undefined;
  private readonly hasProcessCapacity: (() => boolean) | undefined;
  private readonly verifyLiveFence:
    | ((
        fence: ExecutionFence,
        context: { readonly ledgerRunId: string; readonly queueId: string }
      ) => Promise<boolean> | boolean)
    | undefined;
  private readonly unconsumedTokens = new Map<string, PreparedControlAttemptToken>();
  private readonly consumedTokenIds = new Set<string>();
  private tokenCounter = 0;

  public constructor(deps: ControlAttemptAdmissionDeps) {
    this.store = deps.ledgerStore;
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.policyPort = deps.policyPort;
    this.processEvidencePort = deps.processEvidencePort;
    this.hasProcessCapacity = deps.hasProcessCapacity;
    this.verifyLiveFence = deps.verifyLiveFence;
  }

  private async checkFence(
    fence: ExecutionFence,
    ledgerRunId: string,
    queueId: string
  ): Promise<boolean> {
    if (!isValidExecutionFence(fence) || queueId.trim().length === 0) {
      return false;
    }
    if (this.verifyLiveFence !== undefined) {
      return await this.verifyLiveFence(fence, { ledgerRunId, queueId });
    }
    return true;
  }

  public async prepareRootLink(
    input: PrepareRootLinkInput
  ): Promise<PrepareRootLinkOutcome> {
    if (
      input.ledgerRunId.trim().length === 0 ||
      input.connectedRunId.trim().length === 0 ||
      input.queueId.trim().length === 0
    ) {
      return {
        ok: false,
        code: 'control-ledger-corrupt',
        message: 'ledgerRunId, connectedRunId, and queueId must be non-empty strings.'
      };
    }
    const fenceOk = await this.checkFence(
      input.fence,
      input.ledgerRunId,
      input.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: 'Cannot prepare control root link with an invalid or stale execution fence.'
      };
    }

    const now = this.clock.nowWallMs();
    const rootFrameKey = input.rootFrameKey ?? 'root';
    const rootInvocationId = input.rootInvocationId ?? `${input.connectedRunId}:root`;
    const rootFrame: ControlFrame = Object.freeze({
      frameKey: rootFrameKey,
      parentFrameKey: null,
      invocationId: rootInvocationId,
      workflowId: input.rootWorkflowId,
      kind: 'root-workflow',
      status: 'in-flight',
      createdAt: now,
      updatedAt: now,
      dispatchedCount: 0
    });

    const newRoot: RootControlState = Object.freeze({
      version: CONTROL_LEDGER_VERSION,
      ledgerRunId: input.ledgerRunId,
      connectedRunId: input.connectedRunId,
      rootWorkflowId: input.rootWorkflowId,
      queueId: input.queueId,
      linkState: 'prepared',
      status: 'in-flight',
      fence: Object.freeze({ ...input.fence }),
      rootBudget: input.rootBudget ?? defaultRootBudget(),
      dispatchedAttempts: 0,
      settledMicrousd: 0,
      reservedMicrousd: 0,
      framesByKey: Object.freeze({ [rootFrameKey]: rootFrame }),
      attemptsById: Object.freeze({}),
      createdAt: now,
      updatedAt: now
    });

    const mutated = await this.store.mutate<RootControlState>(
      {
        targetRootId: input.ledgerRunId,
        allowSettlementReserve: false
      },
      ({ ledger }) => {
        const existing = lookupRecord(ledger.roots, input.ledgerRunId);
        if (existing !== undefined) {
          if (!executionFencesEqual(existing.fence, input.fence)) {
            return {
              commit: false,
              code: 'stale-execution-fence',
              message: `Control root '${input.ledgerRunId}' already exists under a different fence.`
            };
          }
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.ledgerRunId,
              expectedFence: input.fence,
              result: existing
            }
          };
        }
        const nextLedger: ControlLedger = {
          ...ledger,
          roots: {
            ...ledger.roots,
            [input.ledgerRunId]: newRoot
          }
        };
        return {
          commit: true,
          plan: {
            nextLedger,
            targetRootId: input.ledgerRunId,
            result: newRoot
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }

    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result,
      controlState: Object.freeze({
        version: CONTROL_LEDGER_VERSION,
        ledgerRunId: input.ledgerRunId
      })
    };
  }

  public async activateRootLink(
    input: ActivateRootLinkInput
  ): Promise<ActivateRootLinkOutcome> {
    const mutated = await this.store.mutate<RootControlState>(
      {
        targetRootId: input.ledgerRunId,
        expectedFence: input.fence,
        allowSettlementReserve: false
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.ledgerRunId);
        if (root === undefined || root.connectedRunId !== input.connectedRunId) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.ledgerRunId}' not found for connected run '${input.connectedRunId}'.`
          };
        }
        const now = this.clock.nowWallMs();
        const activeRoot: RootControlState = {
          ...root,
          linkState: 'active',
          updatedAt: now
        };
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: activeRoot
              }
            },
            targetRootId: input.ledgerRunId,
            expectedFence: input.fence,
            result: activeRoot
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }
    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result
    };
  }

  public async prepareAttempt(
    input: PrepareControlAttemptInput
  ): Promise<PrepareControlAttemptOutcome> {
    const readResult = this.store.read();
    if (!readResult.ok) {
      return {
        ok: false,
        code: readResult.code,
        message: readResult.message
      };
    }
    const { ledger } = readResult;
    const root = lookupRecord(ledger.roots, input.ledgerRunId);
    if (root === undefined || root.connectedRunId !== input.connectedRunId) {
      return {
        ok: false,
        code: 'control-root-not-found',
        message: `Control root '${input.ledgerRunId}' does not exist.`
      };
    }
    if (root.queueId !== input.queueId || input.queueId.trim().length === 0) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Queue mismatch on control root '${input.ledgerRunId}'.`
      };
    }
    const fenceOk = await this.checkFence(
      input.fence,
      input.ledgerRunId,
      input.queueId
    );
    if (!fenceOk || !executionFencesEqual(root.fence, input.fence)) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Execution fence mismatch on control root '${input.ledgerRunId}'.`
      };
    }
    if (root.linkState !== 'active' || root.status !== 'in-flight') {
      return {
        ok: false,
        code: 'control-root-not-active',
        message: `Control root '${input.ledgerRunId}' is not active (linkState=${root.linkState}, status=${root.status}).`
      };
    }

    if (root.dispatchedAttempts >= root.rootBudget.maxPhaseAttempts) {
      return {
        ok: false,
        code: 'root-attempt-budget-exhausted',
        message: `Root phase attempt budget (${root.rootBudget.maxPhaseAttempts}) is exhausted.`
      };
    }

    const existingFrame = lookupRecord(root.framesByKey, input.frameKey);
    const isNewFrame = existingFrame === undefined;
    if (isNewFrame && Object.keys(root.framesByKey).length + 1 > MAX_FRAMES_PER_ROOT) {
      return {
        ok: false,
        code: 'control-frame-limit-exceeded',
        message: `Root '${input.ledgerRunId}' exceeds MAX_FRAMES_PER_ROOT (${MAX_FRAMES_PER_ROOT}).`
      };
    }

    const effectiveMaxDispatches = input.maxDispatches ?? existingFrame?.maxDispatches;
    if (
      effectiveMaxDispatches !== undefined &&
      (existingFrame?.dispatchedCount ?? 0) >= effectiveMaxDispatches
    ) {
      return {
        ok: false,
        code: 'candidate-dispatch-budget-exhausted',
        message: `Frame '${input.frameKey}' dispatch budget (${effectiveMaxDispatches}) is exhausted.`
      };
    }

    if (input.candidateId !== undefined && input.candidateMaxAttempts !== undefined) {
      const candidateAttemptsSoFar = Object.values(root.attemptsById).filter(
        (a) => a.frameKey === input.frameKey && a.candidateId === input.candidateId
      ).length;
      if (candidateAttemptsSoFar >= input.candidateMaxAttempts) {
        return {
          ok: false,
          code: 'candidate-attempt-budget-exhausted',
          message: `Candidate '${input.candidateId}' attempt budget (${input.candidateMaxAttempts}) is exhausted.`
        };
      }
    }

    let reservedMicrousd = input.reservedMicrousd ?? 0;
    if (this.policyPort !== undefined) {
      const preflight = await this.policyPort.evaluatePreflight({
        ledgerRunId: input.ledgerRunId,
        connectedRunId: input.connectedRunId,
        queueId: input.queueId,
        invocationId: input.invocationId,
        nodeId: input.nodeId,
        ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
        backend: input.backend,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.reservedMicrousd !== undefined
          ? { estimatedMicrousd: input.reservedMicrousd }
          : {})
      });
      if (!preflight.allowed) {
        return {
          ok: false,
          code: 'policy-preflight-refused',
          message: preflight.detail ?? `Policy preflight refused with '${preflight.refusalCode}'.`
        };
      }
      if (preflight.reservedMicrousd !== undefined) {
        reservedMicrousd = preflight.reservedMicrousd;
      }
    }

    if (root.rootBudget.strictUsdBudget !== undefined) {
      const projectedSpend =
        root.settledMicrousd + root.reservedMicrousd + reservedMicrousd;
      if (projectedSpend > root.rootBudget.strictUsdBudget.limitMicrousd) {
        return {
          ok: false,
          code: 'strict-usd-budget-exceeded',
          message: `Projected spend (${projectedSpend} microusd) exceeds strict USD limit (${root.rootBudget.strictUsdBudget.limitMicrousd} microusd).`
        };
      }
    }

    const nodeAttemptsInRoot = Object.values(root.attemptsById).filter(
      (a) => a.invocationId === input.invocationId && a.nodeId === input.nodeId
    );
    const attemptIndex = input.attemptIndex ?? nodeAttemptsInRoot.length + 1;
    const attemptId =
      input.attemptId ?? `${input.invocationId}:${input.nodeId}:attempt-${attemptIndex}`;

    const now = this.clock.nowWallMs();
    const simulatedAttempt: ControlAttemptRecord = {
      attemptId,
      ledgerRunId: input.ledgerRunId,
      connectedRunId: input.connectedRunId,
      queueId: input.queueId,
      frameKey: input.frameKey,
      invocationId: input.invocationId,
      nodeId: input.nodeId,
      attemptIndex,
      ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
      backend: input.backend,
      ...(input.model !== undefined ? { model: input.model } : {}),
      stage: 'pending-dispatch',
      reservedMicrousd,
      committedAt: now,
      fence: input.fence
    };
    const simulatedRoot: RootControlState = {
      ...root,
      dispatchedAttempts: root.dispatchedAttempts + 1,
      reservedMicrousd: root.reservedMicrousd + reservedMicrousd,
      attemptsById: {
        ...root.attemptsById,
        [attemptId]: simulatedAttempt
      }
    };
    const simulatedBytes = measureRootLedgerBytes(simulatedRoot);
    if (simulatedBytes > MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES) {
      return {
        ok: false,
        code: 'control-ledger-size-exceeded',
        message: `Projected root ledger size (${simulatedBytes} bytes) exceeds admission ceiling (${MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES} bytes).`
      };
    }

    this.tokenCounter += 1;
    const tokenId = `prep:${input.ledgerRunId}:${attemptId}:${this.tokenCounter}`;
    const sortedQuotaKeys = sortQuotaIds(input.quotaKeys ?? []);
    const token: PreparedControlAttemptToken = Object.freeze({
      tokenId,
      preparedAt: now,
      expectedLedgerRevision: ledger.revision,
      ledgerRunId: input.ledgerRunId,
      connectedRunId: input.connectedRunId,
      queueId: input.queueId,
      frameKey: input.frameKey,
      frameKind: input.frameKind ?? existingFrame?.kind ?? 'root-workflow',
      workflowId: input.workflowId,
      invocationId: input.invocationId,
      nodeId: input.nodeId,
      attemptId,
      attemptIndex,
      ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
      backend: input.backend,
      ...(input.model !== undefined ? { model: input.model } : {}),
      reservedMicrousd,
      hasSideEffects: input.hasSideEffects ?? true,
      fence: Object.freeze({ ...input.fence }),
      quotaKeys: sortedQuotaKeys,
      ...(input.observationIds !== undefined
        ? { observationIds: Object.freeze([...input.observationIds]) }
        : {}),
      ...(input.requireFreshReady !== undefined
        ? { requireFreshReady: input.requireFreshReady }
        : {}),
      ...(input.hostEpoch !== undefined ? { hostEpoch: input.hostEpoch } : {}),
      ...(input.capacitiesByQuotaId !== undefined
        ? { capacitiesByQuotaId: Object.freeze({ ...input.capacitiesByQuotaId }) }
        : {}),
      ...(input.satisfiedWaiterId !== undefined
        ? { satisfiedWaiterId: input.satisfiedWaiterId }
        : {}),
      ...(input.expectedWaiterSequence !== undefined
        ? { expectedWaiterSequence: input.expectedWaiterSequence }
        : {}),
      ...(input.expectedWaiterGeneration !== undefined
        ? { expectedWaiterGeneration: input.expectedWaiterGeneration }
        : {}),
      ...(effectiveMaxDispatches !== undefined
        ? { maxDispatches: effectiveMaxDispatches }
        : {}),
      ...(input.candidateMaxAttempts !== undefined
        ? { candidateMaxAttempts: input.candidateMaxAttempts }
        : {})
    });

    if (this.unconsumedTokens.size >= ADMISSION_CONSUMED_TOKENS_MAX) {
      const oldest = this.unconsumedTokens.keys().next().value;
      if (oldest !== undefined) this.unconsumedTokens.delete(oldest);
    }
    this.unconsumedTokens.set(tokenId, token);
    return {
      ok: true,
      token,
      ledgerRevision: ledger.revision
    };
  }

  public async commitAttempt(
    token: PreparedControlAttemptToken
  ): Promise<CommitControlAttemptOutcome> {
    if (this.consumedTokenIds.has(token.tokenId)) {
      return {
        ok: false,
        code: 'prepare-token-consumed',
        message: `Prepare token '${token.tokenId}' has already been consumed.`
      };
    }
    if (!this.unconsumedTokens.has(token.tokenId)) {
      return {
        ok: false,
        code: 'prepare-token-stale',
        message: `Prepare token '${token.tokenId}' is unknown or expired.`
      };
    }

    const fenceOk = await this.checkFence(
      token.fence,
      token.ledgerRunId,
      token.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Live execution fence check failed before commitAttempt for '${token.attemptId}'.`
      };
    }

    if (this.hasProcessCapacity !== undefined && !this.hasProcessCapacity()) {
      return {
        ok: false,
        code: 'quota-capacity-unavailable',
        message: `Host process capacity is unavailable during commitAttempt for '${token.attemptId}'.`
      };
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly frame: ControlFrame;
      readonly attempt: ControlAttemptRecord;
      readonly permit?: ExecutionPermitRecord;
    }>(
      {
        expectedRevision: token.expectedLedgerRevision,
        targetRootId: token.ledgerRunId,
        expectedFence: token.fence,
        allowSettlementReserve: false
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, token.ledgerRunId);
        if (root === undefined || root.connectedRunId !== token.connectedRunId) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${token.ledgerRunId}' not found during commitAttempt.`
          };
        }
        if (root.linkState !== 'active' || root.status !== 'in-flight') {
          return {
            commit: false,
            code: 'control-root-not-active',
            message: `Control root '${token.ledgerRunId}' is no longer active.`
          };
        }
        if (root.dispatchedAttempts >= root.rootBudget.maxPhaseAttempts) {
          return {
            commit: false,
            code: 'root-attempt-budget-exhausted',
            message: `Root phase attempt budget (${root.rootBudget.maxPhaseAttempts}) is exhausted.`
          };
        }
        if (root.rootBudget.strictUsdBudget !== undefined) {
          const projected =
            root.settledMicrousd + root.reservedMicrousd + token.reservedMicrousd;
          if (projected > root.rootBudget.strictUsdBudget.limitMicrousd) {
            return {
              commit: false,
              code: 'strict-usd-budget-exceeded',
              message: `Projected spend (${projected} microusd) exceeds strict USD limit.`
            };
          }
        }

        const now = this.clock.nowWallMs();
        const existingFrame = lookupRecord(root.framesByKey, token.frameKey);
        if (
          existingFrame?.status === 'paused' ||
          existingFrame?.status === 'intervention-required' ||
          existingFrame?.status === 'monitoring-expired' ||
          existingFrame?.status === 'canceled' ||
          existingFrame?.status === 'failed' ||
          existingFrame?.status === 'completed'
        ) {
          return {
            commit: false,
            code: 'control-root-not-active',
            message: `Frame '${token.frameKey}' is in state '${existingFrame.status}' and cannot admit an attempt.`
          };
        }

        const nextDispatchedCount = (existingFrame?.dispatchedCount ?? 0) + 1;
        if (
          token.maxDispatches !== undefined &&
          nextDispatchedCount > token.maxDispatches
        ) {
          return {
            commit: false,
            code: 'candidate-dispatch-budget-exhausted',
            message: `Frame '${token.frameKey}' dispatch budget (${token.maxDispatches}) is exhausted.`
          };
        }

        // Revalidate waiter identity, sequence, generation, and quota set if a waiter was satisfied
        if (token.satisfiedWaiterId !== undefined) {
          const waiterRec = ledger.waiters.find(
            (w) => w.waiterId === token.satisfiedWaiterId
          );
          if (
            waiterRec === undefined ||
            waiterRec.status !== 'waiting' ||
            (token.expectedWaiterSequence !== undefined &&
              (waiterRec.sequence ?? waiterRec.waitSequence) !==
                token.expectedWaiterSequence) ||
            (token.expectedWaiterGeneration !== undefined &&
              (waiterRec.generation ?? 1) !== token.expectedWaiterGeneration) ||
            !quotaIdSetsEqual(
              waiterRec.quotaIds ?? waiterRec.quotaKeys,
              token.quotaKeys
            )
          ) {
            return {
              commit: false,
              code: 'stale-execution-fence',
              message: `Satisfied waiter '${token.satisfiedWaiterId}' is missing, paused, or mutated before commit.`
            };
          }
        }

        // Revalidate fresh readiness inside commit boundary when required
        if (token.requireFreshReady === true) {
          const obsIds = token.observationIds ?? token.quotaKeys;
          const epoch = token.hostEpoch ?? 'default-epoch';
          for (const obsId of obsIds) {
            const obsRec = lookupRecord(ledger.quotaObservations, obsId);
            const obs =
              obsRec !== undefined ? fromObservationRecord(obsRec) : undefined;
            if (!isQuotaObservationFreshReady(obs, now, epoch)) {
              return {
                commit: false,
                code: 'quota-capacity-unavailable',
                message: `Observation '${obsId}' is no longer fresh-ready at commit time.`
              };
            }
          }
        }

        // Revalidate no duplicate active permit for this attemptId and all-or-none quota capacity
        for (const existingPermit of Object.values(ledger.permits)) {
          if (
            existingPermit.attemptId === token.attemptId &&
            existingPermit.status !== 'released' &&
            existingPermit.state !== 'released'
          ) {
            return {
              commit: false,
              code: 'quota-capacity-unavailable',
              message: `Attempt '${token.attemptId}' already has an active permit '${existingPermit.permitId}'.`
            };
          }
        }

        const sortedQuotas = sortQuotaIds(token.quotaKeys);
        for (const qId of sortedQuotas) {
          let activeHoldingsForQuota = 0;
          for (const existingPermit of Object.values(ledger.permits)) {
            if (
              existingPermit.status === 'released' ||
              existingPermit.state === 'released'
            ) {
              continue;
            }
            const pQuotas = existingPermit.quotaIds ?? existingPermit.quotaKeys;
            if (pQuotas.includes(qId)) {
              activeHoldingsForQuota += 1;
            }
          }
          const obsRec = lookupRecord(ledger.quotaObservations, qId);
          const rawCapacity =
            token.capacitiesByQuotaId?.[qId] ??
            (qId === UNKNOWN_LOCAL_QUOTA_ID ? 1 : obsRec?.capacity);
          const effectiveCapacity =
            qId === UNKNOWN_LOCAL_QUOTA_ID
              ? 1
              : rawCapacity !== undefined &&
                  Number.isSafeInteger(rawCapacity) &&
                  rawCapacity >= 1
                ? Math.min(20, rawCapacity)
                : 1;
          if (activeHoldingsForQuota >= effectiveCapacity) {
            return {
              commit: false,
              code: 'quota-capacity-unavailable',
              message: `Quota '${qId}' capacity (${effectiveCapacity}) is full (${activeHoldingsForQuota} held).`
            };
          }
        }

        const permitId =
          sortedQuotas.length > 0 ? `permit:${token.attemptId}` : undefined;
        const permit: ExecutionPermitRecord | undefined =
          permitId !== undefined
            ? Object.freeze({
                permitId,
                attemptId: token.attemptId,
                ledgerRunId: token.ledgerRunId,
                rootRunId: token.ledgerRunId,
                connectedRunId: token.connectedRunId,
                queueId: token.queueId,
                quotaKeys: sortedQuotas,
                quotaIds: sortedQuotas,
                executionFence: token.fence,
                status: 'active',
                state: 'held',
                grantedAt: now
              })
            : undefined;

        const attempt: ControlAttemptRecord = Object.freeze({
          attemptId: token.attemptId,
          ledgerRunId: token.ledgerRunId,
          connectedRunId: token.connectedRunId,
          queueId: token.queueId,
          frameKey: token.frameKey,
          invocationId: token.invocationId,
          nodeId: token.nodeId,
          attemptIndex: token.attemptIndex,
          ...(token.candidateId !== undefined ? { candidateId: token.candidateId } : {}),
          backend: token.backend,
          ...(token.model !== undefined ? { model: token.model } : {}),
          stage: 'pending-dispatch',
          reservedMicrousd: token.reservedMicrousd,
          ...(permitId !== undefined ? { permitId } : {}),
          ...(token.satisfiedWaiterId !== undefined
            ? { waiterId: token.satisfiedWaiterId }
            : {}),
          hasSideEffects: token.hasSideEffects,
          committedAt: now,
          fence: token.fence
        });

        const updatedSlots = existingFrame?.candidateSlots?.map((slot) =>
          slot.candidateId === token.candidateId
            ? Object.freeze({
                ...slot,
                dispatchedAttempts: slot.dispatchedAttempts + 1,
                status: 'in-flight' as const,
                lastAttemptId: token.attemptId
              })
            : slot
        );

        const nextFrame: ControlFrame = Object.freeze({
          frameKey: token.frameKey,
          parentFrameKey: existingFrame?.parentFrameKey ?? (token.frameKey === 'root' ? null : 'root'),
          invocationId: token.invocationId,
          workflowId: token.workflowId,
          ...(existingFrame?.nodeId !== undefined
            ? { nodeId: existingFrame.nodeId }
            : token.nodeId.length > 0
              ? { nodeId: token.nodeId }
              : {}),
          kind: existingFrame?.kind ?? token.frameKind,
          status: 'in-flight',
          createdAt: existingFrame?.createdAt ?? now,
          updatedAt: now,
          activeAttemptId: token.attemptId,
          ...(token.candidateId !== undefined
            ? { selectedCandidateId: token.candidateId }
            : existingFrame?.selectedCandidateId !== undefined
              ? { selectedCandidateId: existingFrame.selectedCandidateId }
              : {}),
          dispatchedCount: nextDispatchedCount,
          ...(token.maxDispatches !== undefined
            ? { maxDispatches: token.maxDispatches }
            : existingFrame?.maxDispatches !== undefined
              ? { maxDispatches: existingFrame.maxDispatches }
              : {}),
          ...(updatedSlots !== undefined ? { candidateSlots: Object.freeze(updatedSlots) } : {}),
          ...(existingFrame?.repeatState !== undefined
            ? { repeatState: existingFrame.repeatState }
            : {}),
          ...(existingFrame?.forEachState !== undefined
            ? { forEachState: existingFrame.forEachState }
            : {})
        });

        const nextRoot: RootControlState = Object.freeze({
          ...root,
          dispatchedAttempts: root.dispatchedAttempts + 1,
          reservedMicrousd: root.reservedMicrousd + token.reservedMicrousd,
          framesByKey: {
            ...root.framesByKey,
            [token.frameKey]: nextFrame
          },
          attemptsById: {
            ...root.attemptsById,
            [token.attemptId]: attempt
          },
          updatedAt: now
        });

        const nextWaiters =
          token.satisfiedWaiterId !== undefined
            ? ledger.waiters.filter((w) => w.waiterId !== token.satisfiedWaiterId)
            : ledger.waiters;

        const nextPermits =
          permit !== undefined
            ? { ...ledger.permits, [permit.permitId]: permit }
            : ledger.permits;

        const nextLedger: ControlLedger = {
          ...ledger,
          roots: {
            ...ledger.roots,
            [token.ledgerRunId]: nextRoot
          },
          waiters: nextWaiters,
          permits: nextPermits
        };

        return {
          commit: true,
          plan: {
            nextLedger,
            targetRootId: token.ledgerRunId,
            expectedFence: token.fence,
            allowSettlementReserve: false,
            result: {
              root: nextRoot,
              frame: nextFrame,
              attempt,
              ...(permit !== undefined ? { permit } : {})
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }

    this.unconsumedTokens.delete(token.tokenId);
    if (this.consumedTokenIds.size >= ADMISSION_CONSUMED_TOKENS_MAX) {
      const oldest = this.consumedTokenIds.values().next().value;
      if (oldest !== undefined) this.consumedTokenIds.delete(oldest);
    }
    this.consumedTokenIds.add(token.tokenId);

    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result.root,
      frame: mutated.result.frame,
      attempt: mutated.result.attempt,
      ...(mutated.result.permit !== undefined ? { permit: mutated.result.permit } : {})
    };
  }

  public async recordSpawnIntent(
    input: RecordSpawnIntentInput
  ): Promise<AttemptTransitionOutcome> {
    const currentRoot = this.store.getRoot(input.ledgerRunId);
    if (currentRoot === null) {
      return {
        ok: false,
        code: 'control-root-not-found',
        message: `Control root '${input.ledgerRunId}' not found.`
      };
    }
    const fenceOk = await this.checkFence(
      input.fence,
      input.ledgerRunId,
      currentRoot.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Live fence verification failed before recordSpawnIntent for '${input.attemptId}'.`
      };
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly attempt: ControlAttemptRecord;
    }>(
      {
        targetRootId: input.ledgerRunId,
        expectedFence: input.fence,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.ledgerRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.ledgerRunId}' not found.`
          };
        }
        const existingAttempt = lookupRecord(root.attemptsById, input.attemptId);
        if (existingAttempt === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Attempt '${input.attemptId}' not found in root '${input.ledgerRunId}'.`
          };
        }
        if (existingAttempt.stage !== 'pending-dispatch') {
          return {
            commit: false,
            code: 'invalid-attempt-stage',
            message: `Attempt '${input.attemptId}' cannot transition to 'spawn-intent' from '${existingAttempt.stage}'.`
          };
        }
        const now = this.clock.nowWallMs();
        const updatedAttempt: ControlAttemptRecord = Object.freeze({
          ...existingAttempt,
          stage: 'spawn-intent',
          spawnIntentAt: now,
          ...(input.queueItemId !== undefined ? { queueItemId: input.queueItemId } : {}),
          ...(input.hasSideEffects !== undefined
            ? { hasSideEffects: input.hasSideEffects }
            : {})
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          attemptsById: {
            ...root.attemptsById,
            [input.attemptId]: updatedAttempt
          },
          updatedAt: now
        });
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: nextRoot
              }
            },
            targetRootId: input.ledgerRunId,
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: { root: nextRoot, attempt: updatedAttempt }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }
    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result.root,
      attempt: mutated.result.attempt
    };
  }

  public async recordAttemptStarted(
    input: RecordAttemptStartedInput
  ): Promise<AttemptTransitionOutcome> {
    const currentRoot = this.store.getRoot(input.ledgerRunId);
    if (currentRoot === null) {
      return {
        ok: false,
        code: 'control-root-not-found',
        message: `Control root '${input.ledgerRunId}' not found.`
      };
    }
    const fenceOk = await this.checkFence(
      input.fence,
      input.ledgerRunId,
      currentRoot.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Live fence verification failed before recordAttemptStarted for '${input.attemptId}'.`
      };
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly attempt: ControlAttemptRecord;
    }>(
      {
        targetRootId: input.ledgerRunId,
        expectedFence: input.fence,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.ledgerRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.ledgerRunId}' not found.`
          };
        }
        const existingAttempt = lookupRecord(root.attemptsById, input.attemptId);
        if (existingAttempt === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Attempt '${input.attemptId}' not found in root '${input.ledgerRunId}'.`
          };
        }
        if (
          existingAttempt.stage !== 'pending-dispatch' &&
          existingAttempt.stage !== 'spawn-intent' &&
          existingAttempt.stage !== 'started'
        ) {
          return {
            commit: false,
            code: 'invalid-attempt-stage',
            message: `Attempt '${input.attemptId}' cannot transition to 'started' from '${existingAttempt.stage}'.`
          };
        }
        const now = this.clock.nowWallMs();
        const updatedAttempt: ControlAttemptRecord = Object.freeze({
          ...existingAttempt,
          stage: 'started',
          startedAt: existingAttempt.startedAt ?? now,
          ...(input.queueItemId !== undefined ? { queueItemId: input.queueItemId } : {}),
          ...(input.pid !== undefined ? { pid: input.pid } : {})
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          attemptsById: {
            ...root.attemptsById,
            [input.attemptId]: updatedAttempt
          },
          updatedAt: now
        });
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: nextRoot
              }
            },
            targetRootId: input.ledgerRunId,
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: { root: nextRoot, attempt: updatedAttempt }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }
    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result.root,
      attempt: mutated.result.attempt
    };
  }

  public async recordAttemptStartupFailure(
    input: RecordAttemptStartupFailureInput
  ): Promise<AttemptTransitionOutcome> {
    return this.settleAttempt({
      ledgerRunId: input.ledgerRunId,
      attemptId: input.attemptId,
      fence: input.fence,
      terminalStatus: 'failed',
      settledMicrousd: 0,
      failureCode: input.failureCode,
      ...(input.failureMessage !== undefined
        ? { failureMessage: input.failureMessage }
        : {})
    });
  }

  public async settleAttempt(
    input: SettleControlAttemptInput
  ): Promise<AttemptTransitionOutcome> {
    const currentRoot = this.store.getRoot(input.ledgerRunId);
    if (currentRoot === null) {
      return {
        ok: false,
        code: 'control-root-not-found',
        message: `Control root '${input.ledgerRunId}' not found.`
      };
    }
    const fenceOk = await this.checkFence(
      input.fence,
      input.ledgerRunId,
      currentRoot.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        code: 'stale-execution-fence',
        message: `Live fence verification failed before settleAttempt for '${input.attemptId}'.`
      };
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly attempt: ControlAttemptRecord;
    }>(
      {
        targetRootId: input.ledgerRunId,
        ...(input.allowCurrentOwnerTeardownAfterGenerationAdvance === true
          ? {}
          : { expectedFence: input.fence }),
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.ledgerRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.ledgerRunId}' not found.`
          };
        }
        const existingAttempt = lookupRecord(root.attemptsById, input.attemptId);
        if (existingAttempt === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Attempt '${input.attemptId}' not found in root '${input.ledgerRunId}'.`
          };
        }
        if (input.allowCurrentOwnerTeardownAfterGenerationAdvance === true) {
          if (
            root.fence.primacyClaim !== input.fence.primacyClaim ||
            root.fence.queueClaim !== input.fence.queueClaim ||
            existingAttempt.fence.primacyClaim !== input.fence.primacyClaim ||
            existingAttempt.fence.queueClaim !== input.fence.queueClaim
          ) {
            return {
              commit: false,
              code: 'stale-execution-fence',
              message: `Stale ownership claim on settleAttempt for '${input.attemptId}'.`
            };
          }
        }
        if (existingAttempt.stage === 'settled') {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.ledgerRunId,
              ...(input.allowCurrentOwnerTeardownAfterGenerationAdvance === true
                ? {}
                : { expectedFence: input.fence }),
              allowSettlementReserve: true,
              result: { root, attempt: existingAttempt }
            }
          };
        }

        const now = this.clock.nowWallMs();
        const settledMicrousd = input.settledMicrousd ?? 0;
        const updatedAttempt: ControlAttemptRecord = Object.freeze({
          ...existingAttempt,
          stage: 'settled',
          terminalStatus: input.terminalStatus,
          settledMicrousd,
          settledAt: now,
          ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
          ...(input.failureMessage !== undefined
            ? { failureMessage: input.failureMessage }
            : {}),
          ...(input.decisionResults !== undefined
            ? { decisionResults: Object.freeze({ ...input.decisionResults }) }
            : {})
        });

        const existingFrame = lookupRecord(root.framesByKey, existingAttempt.frameKey);
        let nextFrame: ControlFrame | undefined;
        if (existingFrame !== undefined) {
          const { activeAttemptId: prevActive, ...restFrame } = existingFrame;
          nextFrame = Object.freeze({
            ...restFrame,
            ...(prevActive !== undefined && prevActive !== input.attemptId
              ? { activeAttemptId: prevActive }
              : {}),
            updatedAt: now
          });
        }

        const nextReserved = Math.max(
          0,
          root.reservedMicrousd - existingAttempt.reservedMicrousd
        );
        const nextSettled = root.settledMicrousd + settledMicrousd;

        const nextRoot: RootControlState = Object.freeze({
          ...root,
          reservedMicrousd: nextReserved,
          settledMicrousd: nextSettled,
          framesByKey:
            nextFrame !== undefined
              ? { ...root.framesByKey, [existingAttempt.frameKey]: nextFrame }
              : root.framesByKey,
          attemptsById: {
            ...root.attemptsById,
            [input.attemptId]: updatedAttempt
          },
          updatedAt: now
        });

        let nextPermits = ledger.permits;
        if (existingAttempt.permitId !== undefined) {
          const existingPermit = lookupRecord(ledger.permits, existingAttempt.permitId);
          if (existingPermit !== undefined) {
            const updatedPermit: ExecutionPermitRecord = Object.freeze({
              ...existingPermit,
              status: input.holdPermitUncertain ? 'held-uncertain' : 'released',
              state: input.holdPermitUncertain ? 'uncertain' : 'released',
              ...(input.holdPermitUncertain
                ? {
                    uncertainReason:
                      input.uncertainReason ?? 'recovery-uncertain-effect'
                  }
                : { releasedAt: now })
            });
            nextPermits = {
              ...ledger.permits,
              [existingPermit.permitId]: updatedPermit
            };
          }
        }

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: nextRoot
              },
              permits: nextPermits
            },
            targetRootId: input.ledgerRunId,
            ...(input.allowCurrentOwnerTeardownAfterGenerationAdvance === true
              ? {}
              : { expectedFence: input.fence }),
            allowSettlementReserve: true,
            result: { root: nextRoot, attempt: updatedAttempt }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }
    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result.root,
      attempt: mutated.result.attempt
    };
  }

  /**
   * Reconcile a control root across all five D4 crash windows during recovery.
   */
  public async reconcileControlRoot(
    input: ReconcileControlRootInput
  ): Promise<ReconcileControlRootResult> {
    const readResult = this.store.read();
    if (!readResult.ok) {
      return {
        ok: false,
        disposition: 'noop',
        affectedAttemptIds: [],
        errorCode: readResult.code,
        message: readResult.message
      };
    }

    const existingRoot = lookupRecord(readResult.ledger.roots, input.ledgerRunId);
    const runHasMatchingLink =
      input.connectedRun?.controlState?.ledgerRunId === input.ledgerRunId;

    // Crash point 1: root prepared in ledger, but ConnectedWorkflowRun never linked it.
    if (existingRoot !== undefined && !runHasMatchingLink) {
      if (existingRoot.linkState === 'prepared') {
        const cleaned = await this.store.mutate<void>(
          { allowSettlementReserve: true },
          ({ ledger }) => {
            const roots = { ...ledger.roots };
            delete roots[input.ledgerRunId];
            return {
              commit: true,
              plan: {
                nextLedger: { ...ledger, roots },
                allowSettlementReserve: true,
                result: undefined
              }
            };
          }
        );
        if (!cleaned.ok) {
          return {
            ok: false,
            disposition: 'noop',
            affectedAttemptIds: [],
            errorCode: cleaned.code,
            message: cleaned.message
          };
        }
        return {
          ok: true,
          disposition: 'cleaned-prepared-root',
          ledger: cleaned.ledger,
          affectedAttemptIds: []
        };
      }
    }

    // Missing root when ConnectedWorkflowRun claims a link.
    if (existingRoot === undefined) {
      if (runHasMatchingLink) {
        return {
          ok: false,
          disposition: 'missing-ledger-root',
          affectedAttemptIds: [],
          pauseCause: 'recovery-uncertain-effect',
          errorCode: 'control-root-not-found',
          message: `ConnectedWorkflowRun references missing control ledger root '${input.ledgerRunId}'.`
        };
      }
      return {
        ok: true,
        disposition: 'noop',
        ledger: readResult.ledger,
        affectedAttemptIds: []
      };
    }

    const fenceOk = await this.checkFence(
      input.newFence,
      input.ledgerRunId,
      existingRoot.queueId
    );
    if (!fenceOk) {
      return {
        ok: false,
        disposition: 'noop',
        affectedAttemptIds: [],
        errorCode: 'stale-execution-fence',
        message: `Cannot reconcile control root '${input.ledgerRunId}' with a stale or invalid fence.`
      };
    }

    const nonSettledAttempts = Object.values(existingRoot.attemptsById).filter(
      (a) => a.stage !== 'settled'
    );
    const evidenceByAttemptId = new Map<
      string,
      Awaited<ReturnType<ProcessEvidencePort['inspectAttempt']>>
    >();
    if (this.processEvidencePort !== undefined) {
      for (const attempt of nonSettledAttempts) {
        const snap = await this.processEvidencePort.inspectAttempt({
          ledgerRunId: attempt.ledgerRunId,
          connectedRunId: attempt.connectedRunId,
          invocationId: attempt.invocationId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          ...(attempt.queueItemId !== undefined
            ? { queueItemId: attempt.queueItemId }
            : {}),
          ...(attempt.pid !== undefined ? { pid: attempt.pid } : {})
        });
        evidenceByAttemptId.set(attempt.attemptId, snap);
      }
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly disposition: ReconcileControlRootDisposition;
      readonly affectedAttemptIds: readonly string[];
      readonly pauseCause?: string;
    }>(
      {
        targetRootId: input.ledgerRunId,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.ledgerRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.ledgerRunId}' disappeared during reconciliation.`
          };
        }
        if (input.newFence.rootGeneration < root.fence.rootGeneration) {
          return {
            commit: false,
            code: 'stale-execution-fence',
            message: `Reconciliation fence generation (${input.newFence.rootGeneration}) is older than root generation (${root.fence.rootGeneration}).`
          };
        }

        const now = this.clock.nowWallMs();
        let disposition: ReconcileControlRootDisposition =
          root.linkState === 'prepared' && runHasMatchingLink
            ? 'activated-prepared-root'
            : 'noop';
        const affectedAttemptIds: string[] = [];
        let pauseCause: string | undefined;

        const attemptsById: Record<string, ControlAttemptRecord> = {
          ...root.attemptsById
        };
        const framesByKey: Record<string, ControlFrame> = { ...root.framesByKey };
        const permits: Record<string, ExecutionPermitRecord> = {
          ...ledger.permits
        };
        let reservedMicrousd = root.reservedMicrousd;
        let settledMicrousd = root.settledMicrousd;
        let rootStatus = root.status;

        for (const attempt of Object.values(root.attemptsById)) {
          if (attempt.stage === 'settled') continue;
          affectedAttemptIds.push(attempt.attemptId);
          const evidence = evidenceByAttemptId.get(attempt.attemptId) ?? {
            processState: 'not-found' as const
          };

          if (evidence.processState === 'running') {
            attemptsById[attempt.attemptId] = Object.freeze({
              ...attempt,
              stage: 'started',
              startedAt: attempt.startedAt ?? now,
              fence: input.newFence
            });
            disposition = 'reattached-running-attempt';
            continue;
          }

          if (evidence.durableTerminalStatus !== undefined) {
            const attemptSettledUsd = evidence.settledMicrousd ?? 0;
            attemptsById[attempt.attemptId] = Object.freeze({
              ...attempt,
              stage: 'settled',
              terminalStatus: evidence.durableTerminalStatus,
              settledMicrousd: attemptSettledUsd,
              settledAt: now,
              ...(evidence.durableFailureCode !== undefined
                ? { failureCode: evidence.durableFailureCode }
                : {}),
              ...(evidence.decisionResults !== undefined
                ? { decisionResults: evidence.decisionResults }
                : {})
            });
            reservedMicrousd = Math.max(0, reservedMicrousd - attempt.reservedMicrousd);
            settledMicrousd += attemptSettledUsd;
            if (attempt.permitId !== undefined) {
              const p = lookupRecord(permits, attempt.permitId);
              if (p !== undefined) {
                permits[attempt.permitId] = Object.freeze({
                  ...p,
                  status: 'released',
                  state: 'released',
                  releasedAt: now
                });
              }
            }
            disposition = 'settled-from-evidence';
            continue;
          }

          // Crash point 3: committed in `pending-dispatch` (before `recordSpawnIntent`).
          if (attempt.stage === 'pending-dispatch' && !evidence.queueItemPresent) {
            attemptsById[attempt.attemptId] = Object.freeze({
              ...attempt,
              stage: 'settled',
              terminalStatus: 'failed',
              settledMicrousd: 0,
              settledAt: now,
              failureCode: 'crash-before-spawn-intent'
            });
            reservedMicrousd = Math.max(0, reservedMicrousd - attempt.reservedMicrousd);
            if (attempt.permitId !== undefined) {
              const p = lookupRecord(permits, attempt.permitId);
              if (p !== undefined) {
                permits[attempt.permitId] = Object.freeze({
                  ...p,
                  status: 'released',
                  state: 'released',
                  releasedAt: now
                });
              }
            }
            const frame = lookupRecord(framesByKey, attempt.frameKey);
            if (frame !== undefined) {
              const { activeAttemptId: _cleared, ...restFrame } = frame;
              framesByKey[attempt.frameKey] = Object.freeze({
                ...restFrame,
                status: 'paused',
                pauseCause: 'crash-before-spawn-intent',
                updatedAt: now
              });
            }
            rootStatus = 'paused';
            pauseCause = 'crash-before-spawn-intent';
            disposition = 'failed-pre-spawn-attempt';
            continue;
          }

          // Crash points 4 & 5: `spawn-intent` or `started` with no running process and no durable terminal evidence.
          pauseCause = 'recovery-uncertain-effect';
          rootStatus = 'paused';
          disposition = 'paused-uncertain-effect';
          if (attempt.permitId !== undefined) {
            const p = lookupRecord(permits, attempt.permitId);
            if (p !== undefined) {
              permits[attempt.permitId] = Object.freeze({
                ...p,
                status: 'held-uncertain',
                state: 'uncertain',
                uncertainReason: 'recovery-uncertain-effect'
              });
            }
          }
          const frame = lookupRecord(framesByKey, attempt.frameKey);
          if (frame !== undefined) {
            framesByKey[attempt.frameKey] = Object.freeze({
              ...frame,
              status: 'paused',
              pauseCause: 'recovery-uncertain-effect',
              updatedAt: now
            });
          }
        }

        const nextRoot: RootControlState = Object.freeze({
          ...root,
          linkState:
            root.linkState === 'prepared' && runHasMatchingLink
              ? 'active'
              : root.linkState,
          status: rootStatus,
          fence: Object.freeze({ ...input.newFence }),
          reservedMicrousd,
          settledMicrousd,
          framesByKey,
          attemptsById,
          ...(pauseCause !== undefined ? { pauseCause } : {}),
          updatedAt: now
        });

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: nextRoot
              },
              permits
            },
            targetRootId: input.ledgerRunId,
            allowSettlementReserve: true,
            result: {
              root: nextRoot,
              disposition,
              affectedAttemptIds: Object.freeze(affectedAttemptIds),
              ...(pauseCause !== undefined ? { pauseCause } : {})
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        disposition: 'noop',
        affectedAttemptIds: [],
        errorCode: mutated.code,
        message: mutated.message
      };
    }

    return {
      ok: true,
      disposition: mutated.result.disposition,
      ledger: mutated.ledger,
      root: mutated.result.root,
      affectedAttemptIds: mutated.result.affectedAttemptIds,
      ...(mutated.result.pauseCause !== undefined
        ? { pauseCause: mutated.result.pauseCause }
        : {})
    };
  }

  public pruneRootTokens(ledgerRunId: string): void {
    for (const [tokenId, token] of this.unconsumedTokens.entries()) {
      if (token.ledgerRunId === ledgerRunId) {
        this.unconsumedTokens.delete(tokenId);
      }
    }
  }
}

export function resolvePhaseAttemptBackend(
  phaseRunner: BackendRunnerKind | undefined,
  defaultRunner: BackendRunnerKind = 'claude'
): BackendRunnerKind {
  return phaseRunner ?? defaultRunner;
}
