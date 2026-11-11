// FR-R5-F03 (T002, T003, T004, T005, T007) — Authoritative nested Workflow
// control service.
//
// Centralizes pause, resume, root/child cancel, retry-phase, retry-invocation,
// and continue-handoff inside a per-queue serialized mutation boundary with:
//   - monotonic `expectedRevision` compare-and-set,
//   - bounded `commandId` idempotency receipts (`MAX_COMMAND_RECEIPTS = 64`),
//   - paired pause/retry marker enforcement (Rule 28),
//   - single-queue lease tenure and fence-loss isolation (Rule 4).
//
// Zero `vscode` imports: shared by both host and headless runtime entry points.

import type { RunRequest } from '../../contracts/run-request';
import type { ControlAdmissionPort, ExecutionFence } from '../../contracts/control-ledger';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import {
  appendCommandReceipt,
  assertConnectedRunInvariants,
  attemptsForNode,
  clearInvocationControlMarkers,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  resolveBoundQueueId,
  resolveRootInvocationId,
  setPendingHandoff,
  upsertInvocationFrame,
  type CommittedCommandReceipt,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type WorkflowControlOperation,
  type WorkflowInvocationFrame,
  type WorkflowPauseCause
} from '../../state/connected-workflow-run';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type ComposableWorkflowCoordinatorDeps,
  type ComposableWorkflowStepResult,
  type PhaseAttemptDispatchInput,
  type PhaseAttemptDispatchResult
} from './connected-run-coordinator';
import { continueWaitingHandoff } from './continuation-composer';
import type { ForEachExecutor } from './foreach-executor';
import type { RepeatExecutor } from './repeat-executor';
import {
  buildWorkflowRunControlProjection,
  type WorkflowRunControlProjection
} from './workflow-control-projector';
import {
  collectSubtreeInvocationIds,
  evaluateControlTransition,
  findLatestLeafPhaseAttempt,
  isTerminalInvocationStatus,
  type WorkflowControlRefusalCode
} from './workflow-control-transition-table';
import type { DurableAttemptEvidence } from './workflow-recovery-service';
import type { ConnectedRunWriter } from './workflow-launcher';
import type { ControlCommandAcknowledgement } from '../../contracts/sidebar-ipc/workflow-run';
import type { PhaseHandoffCoordinator } from '../phase-context/phase-handoff-coordinator';
import { approvePendingPhaseHandoffForContinue } from './phase-handoff-execution-bridge';
import type { ControlCommandService } from './control-command-service';

export interface ActiveLeafAbortInput {
  readonly runId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly queueItemId?: string;
}

export interface WorkflowControlStore extends ConnectedRunWriter {
  get(connectedRunId: string): ConnectedWorkflowRun | null;
}

export interface WorkflowControlServiceDeps {
  readonly connectedRuns: WorkflowControlStore;
  readonly dispatchPhase: (
    input: PhaseAttemptDispatchInput
  ) => Promise<PhaseAttemptDispatchResult>;
  readonly abortActiveLeaf?: (input: ActiveLeafAbortInput) => Promise<void> | void;
  readonly cancelRetryTimer?: (
    queueId: string,
    runId: string,
    invocationId: string
  ) => void;
  readonly releaseQueueLease?: (
    queueId: string,
    runId: string
  ) => Promise<void> | void;
  readonly verifyLeaseFence?: (queueId: string, runId: string) => boolean;
  readonly isQueuePresent?: (queueId: string) => boolean;
  /**
   * FR-R5-F08 — optional evidence probe used during `resume` on a paused leaf Phase
   * attempt (including `recovery-uncertain-effect`) so an attempt that already
   * settled on disk is recorded as completed rather than re-dispatched.
   */
  readonly checkDurableAttemptEvidence?: (
    runId: string,
    invocationId: string,
    attempt: NodeAttemptRecord
  ) => DurableAttemptEvidence | null;
  /**
   * FR-R5-F08 — optional queue/task presence check used during `resume` so a paused
   * leaf Phase attempt whose original queue item is still live on the bound queue
   * is reactivated in place rather than duplicated.
   */
  readonly isQueueOrTaskPresent?: (queueId: string, queueItemId?: string) => boolean;
  readonly cancelOrphanedQueueItem?: (
    queueItemId: string,
    queueId: string
  ) => Promise<void> | void;
  /**
   * FR-R5-F31 — optional candidate-block control command service used to redirect
   * generic `retry-phase` commands on block-owned leaves through the shared
   * candidate control authority so they cannot spawn separately or restore
   * exhausted candidate/block attempt counters.
   */
  readonly controlCommandService?: ControlCommandService;
  readonly controlAdmission?: ControlAdmissionPort | undefined;
  readonly repeatExecutor?: RepeatExecutor | undefined;
  readonly forEachExecutor?: ForEachExecutor | undefined;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly resolveExecutionFence?: (run: ConnectedWorkflowRun, queueId: string) => ExecutionFence;
}

export interface WorkflowControlCommandRequest {
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly operation: WorkflowControlOperation;
  readonly targetInvocationId?: string;
  readonly targetNodeId?: string;
  readonly pauseCause?: WorkflowPauseCause;
  readonly reason?: string;
  readonly continuationRequest?: RunRequest;
  readonly now: number;
}

export type WorkflowControlCommandOutcome =
  | {
      readonly accepted: true;
      readonly idempotentReplay: boolean;
      readonly run: ConnectedWorkflowRun;
      readonly receipt: CommittedCommandReceipt;
      readonly projection: WorkflowRunControlProjection;
    }
  | {
      readonly accepted: false;
      readonly refusalCode: WorkflowControlRefusalCode;
      readonly reason: string;
      readonly currentRevision: number | null;
      readonly run: ConnectedWorkflowRun | null;
      readonly projection: WorkflowRunControlProjection | null;
    };

interface StagingBuffer {
  readonly writer: ConnectedRunWriter;
  readonly current: () => ConnectedWorkflowRun;
  readonly set: (run: ConnectedWorkflowRun) => void;
}

/**
 * What a dispatching control step reports back to `executeCommandLocked`.
 *
 * `undispatched` is set when the step needed a Phase attempt to start and the
 * coordinator answered with anything other than `phase-dispatched` (the queue
 * refused the item, a binding no longer resolves, the closure is invalid). The
 * command is then refused instead of committed: no attempt is spent against
 * `maxPhaseAttempts`, and no frame is left claiming an attempt that never started.
 */
interface DispatchStepOutcome {
  readonly spawnedInvocationId?: string;
  readonly spawnedAttemptId?: string;
  readonly undispatched?: ComposableWorkflowStepResult;
}

/**
 * Name why a control step could not start a Phase attempt.
 *
 * A failed dispatch cascades up the call chain, so the step result carries the
 * outermost frame's `unhandled-node-failure`. The cause lives on the deepest
 * frame the step failed: it is the one frame the staged run changed that is now
 * `failed`, so frames that were already failed before the command are skipped.
 */
function describeUndispatchedStep(
  before: ConnectedWorkflowRun,
  staged: ConnectedWorkflowRun,
  step: ComposableWorkflowStepResult
): string {
  const beforeFrames = new Map(Object.entries(before.invocations ?? {}));
  let deepest: WorkflowInvocationFrame | undefined;
  for (const frame of Object.values(staged.invocations ?? {})) {
    if (frame.status !== 'failed' || frame.failureCode === undefined) continue;
    if (beforeFrames.get(frame.invocationId) === frame) continue;
    if (deepest === undefined || frame.depth > deepest.depth) deepest = frame;
  }
  if (deepest?.failureCode !== undefined) return deepest.failureCode;
  return step.outcome === 'workflow-failed' ? step.failureCode : step.outcome;
}

function createStagingWriter(initial: ConnectedWorkflowRun): StagingBuffer {
  let staged = initial;
  const writer: ConnectedRunWriter = {
    async compareAndSetConnectedRun(next: ConnectedWorkflowRun, _expectedRevision: number) {
      staged = next;
      return { outcome: 'written' as const, run: staged };
    }
  };
  return {
    writer,
    current: () => staged,
    set: (run: ConnectedWorkflowRun) => {
      staged = run;
    }
  };
}

function collectAncestorInvocationIds(
  run: ConnectedWorkflowRun,
  invocationId: string
): readonly string[] {
  const invocations = run.invocations ?? {};
  const ancestors: string[] = [];
  let cursor = invocations[invocationId]?.parentInvocationId ?? null;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.push(cursor);
    cursor = invocations[cursor]?.parentInvocationId ?? null;
  }
  return ancestors;
}

function findInFlightLeafAttempts(
  run: ConnectedWorkflowRun,
  invocationIds: readonly string[]
): readonly { frame: WorkflowInvocationFrame; attempt: NodeAttemptRecord }[] {
  const results: { frame: WorkflowInvocationFrame; attempt: NodeAttemptRecord }[] = [];
  const invocations = run.invocations ?? {};
  for (const id of invocationIds) {
    const frame = invocations[id];
    if (frame === undefined) continue;
    for (const attempts of Object.values(frame.attemptsByNodeId)) {
      for (const attempt of attempts) {
        if (attempt.status === 'in-flight' && attempt.nodeKind === 'phase') {
          results.push({ frame, attempt });
        }
      }
    }
  }
  return results;
}

function findNewChildInvocationId(
  before: ConnectedWorkflowRun,
  after: ConnectedWorkflowRun
): string | undefined {
  const beforeIds = new Set(Object.keys(before.invocations ?? {}));
  for (const id of Object.keys(after.invocations ?? {})) {
    if (!beforeIds.has(id)) return id;
  }
  return undefined;
}

function reactivateFrame(
  frame: WorkflowInvocationFrame,
  resetOutputs: boolean
): WorkflowInvocationFrame {
  const {
    completedAt: _completedAt,
    failureCode: _failureCode,
    failureMessage: _failureMessage,
    ...rest
  } = frame;
  return {
    ...rest,
    status: 'in-flight',
    ...(resetOutputs ? { resolvedOutputs: Object.freeze({}) } : {}),
    controlMarkers: clearInvocationControlMarkers(frame.controlMarkers)
  };
}

const sharedQueueTailByQueueId = new Map<string, Promise<unknown>>();

/**
 * Serialized control & completion coordinator for nested `ConnectedWorkflowRun`s.
 */
export class WorkflowControlService {
  private readonly queueTailByQueueId = sharedQueueTailByQueueId;

  constructor(private readonly deps: WorkflowControlServiceDeps) {}

  private coordinatorDeps(writer: ConnectedRunWriter): ComposableWorkflowCoordinatorDeps {
    const { controlAdmission, repeatExecutor, forEachExecutor, phaseHandoffCoordinator, workspaceRoot, resolveExecutionFence, cancelOrphanedQueueItem } = this.deps;
    return {
      connectedRuns: writer,
      dispatchPhase: this.deps.dispatchPhase,
      ...(controlAdmission !== undefined ? { controlAdmission } : {}),
      ...(repeatExecutor !== undefined ? { repeatExecutor } : {}),
      ...(forEachExecutor !== undefined ? { forEachExecutor } : {}),
      ...(phaseHandoffCoordinator !== undefined ? { phaseHandoffCoordinator } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(resolveExecutionFence !== undefined ? { resolveExecutionFence } : {}),
      ...(cancelOrphanedQueueItem !== undefined ? { cancelOrphanedQueueItem } : {})
    };
  }

  /**
   * Serialize an async operation on `queueId` in strict FIFO order.
   */
  public serializeOnQueue<T>(queueId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queueTailByQueueId.get(queueId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    this.queueTailByQueueId.set(queueId, tracked);
    return next;
  }

  /**
   * Execute a candidate-block `ControlCommandEnvelope` (`version: 1`) directly
   * through the configured `ControlCommandService`.
   */
  public async executeCandidateControlCommand(
    rawCommand: unknown
  ): Promise<ControlCommandAcknowledgement> {
    if (this.deps.controlCommandService === undefined) {
      return Object.freeze({
        version: 1,
        commandId: '00000000-0000-0000-0000-000000000000',
        outcome: 'refused',
        generation: 0,
        reason: 'unknown-target'
      });
    }
    return this.deps.controlCommandService.executeControlCommand(rawCommand);
  }

  /**
   * Execute a control command (`pause`, `resume`, `cancel`, `retry-phase`,
   * `retry-invocation`, `continue-handoff`) inside the per-queue serialized
   * mutation boundary.
   */
  public async executeCommand(
    request: WorkflowControlCommandRequest
  ): Promise<WorkflowControlCommandOutcome> {
    const initialLookup = this.deps.connectedRuns.get(request.runId);
    const lockKey =
      initialLookup !== null ? resolveBoundQueueId(initialLookup) : `run:${request.runId}`;
    return this.serializeOnQueue(lockKey, () => this.executeCommandLocked(request));
  }

  /**
   * Complete an in-flight node attempt inside the same per-queue serialization
   * boundary so completion/control races settle deterministically.
   */
  public async completeNodeAttemptSerialized(input: {
    readonly runId: string;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly attemptIndex?: number;
    readonly status: WorkflowNodeTerminalStatus;
    readonly completedAt: number;
    readonly declaredOutputs?: NodeAttemptRecord['declaredOutputs'];
    readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
    readonly verdict?: 'pass' | 'fail' | null;
    readonly failureCode?: string;
  }): Promise<
    | ComposableWorkflowStepResult
    | { readonly outcome: 'ignored-not-in-flight'; readonly run: ConnectedWorkflowRun }
  > {
    const initialLookup = this.deps.connectedRuns.get(input.runId);
    const lockKey =
      initialLookup !== null ? resolveBoundQueueId(initialLookup) : `run:${input.runId}`;

    return this.serializeOnQueue(lockKey, async () => {
      const currentRun = this.deps.connectedRuns.get(input.runId);
      if (currentRun === null) {
        return { outcome: 'rejected-stale', current: null };
      }
      const frame = currentRun.invocations?.[input.invocationId];
      if (frame === undefined || frame.status !== 'in-flight') {
        return { outcome: 'ignored-not-in-flight', run: currentRun };
      }
      const attempts = attemptsForNode(frame, input.nodeId);
      const targetAttempt =
        input.attemptIndex === undefined
          ? attempts[attempts.length - 1]
          : attempts.find((a) => a.attemptIndex === input.attemptIndex);
      if (targetAttempt === undefined || targetAttempt.status !== 'in-flight') {
        return { outcome: 'ignored-not-in-flight', run: currentRun };
      }

      const result = await completeComposableNodeAttempt(
        this.coordinatorDeps(this.deps.connectedRuns),
        {
          run: currentRun,
          invocationId: input.invocationId,
          nodeId: input.nodeId,
          ...(input.attemptIndex !== undefined ? { attemptIndex: input.attemptIndex } : {}),
          status: input.status,
          completedAt: input.completedAt,
          ...(input.declaredOutputs !== undefined
            ? { declaredOutputs: input.declaredOutputs }
            : {}),
          ...(input.decisionResults !== undefined
            ? { decisionResults: input.decisionResults }
            : {}),
          ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
          ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {})
        }
      );

      if (
        (result.outcome === 'workflow-completed' ||
          result.outcome === 'workflow-failed' ||
          result.outcome === 'workflow-canceled') &&
        this.deps.releaseQueueLease !== undefined
      ) {
        const rootId = resolveRootInvocationId(result.run);
        const rootFrame = result.run.invocations?.[rootId];
        if (rootFrame !== undefined && isTerminalInvocationStatus(rootFrame.status)) {
          await this.deps.releaseQueueLease(
            resolveBoundQueueId(result.run),
            result.run.connectedRunId
          );
        }
      }
      return result;
    });
  }

  private async executeCommandLocked(
    request: WorkflowControlCommandRequest
  ): Promise<WorkflowControlCommandOutcome> {
    const run = this.deps.connectedRuns.get(request.runId);
    if (run === null) {
      return {
        accepted: false,
        refusalCode: 'run-not-found',
        reason: `Run '${request.runId}' was not found.`,
        currentRevision: null,
        run: null,
        projection: null
      };
    }

    const queueId = resolveBoundQueueId(run);

    // 1. Check idempotency ledger first (survives post-commit pre-ack retries).
    const existingReceipt = (run.commandReceipts ?? []).find(
      (entry) => entry.commandId === request.commandId
    );
    if (existingReceipt !== undefined) {
      return {
        accepted: true,
        idempotentReplay: true,
        run,
        receipt: existingReceipt,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    // 2. Check window primacy / lease fence before mutating or touching runner.
    if (
      this.deps.verifyLeaseFence !== undefined &&
      !this.deps.verifyLeaseFence(queueId, run.connectedRunId)
    ) {
      const rootId = resolveRootInvocationId(run);
      const allIds = collectSubtreeInvocationIds(run, rootId);
      for (const { frame, attempt } of findInFlightLeafAttempts(run, allIds)) {
        await this.deps.abortActiveLeaf?.({
          runId: run.connectedRunId,
          queueId,
          invocationId: frame.invocationId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          ...(attempt.queueItemId !== undefined ? { queueItemId: attempt.queueItemId } : {})
        });
      }
      return {
        accepted: false,
        refusalCode: 'fence-lost',
        reason: `Window lost lease primacy for queue '${queueId}'.`,
        currentRevision: run.revision,
        run,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    // 3. Check bound queue presence.
    if (this.deps.isQueuePresent !== undefined && !this.deps.isQueuePresent(queueId)) {
      return {
        accepted: false,
        refusalCode: 'queue-deleted',
        reason: `Bound queue '${queueId}' no longer exists.`,
        currentRevision: run.revision,
        run,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    // 4. Verify expectedRevision compare-and-set token.
    if (run.revision !== request.expectedRevision) {
      return {
        accepted: false,
        refusalCode: 'stale-revision',
        reason: `Expected revision ${request.expectedRevision}, but run is at revision ${run.revision}.`,
        currentRevision: run.revision,
        run,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    // 5. Redirect generic `retry-phase` targeting a candidate-block-owned invocation
    //    through `ControlCommandService` (FR-R5-F31-T05) so it cannot spawn separately
    //    or bypass exhausted candidate/block counters.
    const candidateTargetFrameId =
      request.targetInvocationId ?? resolveRootInvocationId(run);
    if (
      request.operation === 'retry-phase' &&
      this.deps.controlCommandService !== undefined &&
      this.deps.controlCommandService.hasCandidateFrame(
        run.connectedRunId,
        candidateTargetFrameId
      )
    ) {
      const redirected = await this.deps.controlCommandService.redirectLegacyRetryPhase({
        commandId: request.commandId,
        rootRunId: run.connectedRunId,
        queueId,
        invocationId: candidateTargetFrameId,
        ...(request.targetNodeId !== undefined
          ? { candidateId: request.targetNodeId }
          : {})
      });
      if (redirected.outcome === 'refused') {
        const mappedRefusal: WorkflowControlRefusalCode =
          redirected.reason === 'spend-limit-reached' ||
          redirected.reason === 'spend-unverifiable'
            ? 'spend-bound-exceeded'
            : redirected.reason === 'candidate-ineligible'
              ? 'retry-bound-exceeded'
              : redirected.reason === 'stale-generation'
                ? 'stale-revision'
                : 'invalid-state-for-operation';
        return {
          accepted: false,
          refusalCode: mappedRefusal,
          reason: `Candidate-block retry refused (${redirected.reason ?? 'illegal-state'}).`,
          currentRevision: run.revision,
          run,
          projection: buildWorkflowRunControlProjection(run)
        };
      }
      const rootId = resolveRootInvocationId(run);
      const rootStatus = run.invocations?.[rootId]?.status ?? 'in-flight';
      const targetStatus =
        run.invocations?.[candidateTargetFrameId]?.status ?? rootStatus;
      const receipt: CommittedCommandReceipt = Object.freeze({
        commandId: request.commandId,
        operation: request.operation,
        targetInvocationId: candidateTargetFrameId,
        ...(request.targetNodeId !== undefined ? { targetNodeId: request.targetNodeId } : {}),
        committedRevision: run.revision + 1,
        committedAt: request.now,
        resultingRunStatus: rootStatus,
        resultingInvocationStatus: targetStatus
      });
      const withReceipt = appendCommandReceipt({ ...run, revision: run.revision }, receipt);
      const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
        withReceipt,
        run.revision
      );
      if (written.outcome === 'stale') {
        return {
          accepted: false,
          refusalCode: 'stale-revision',
          reason: 'Concurrent modification detected during command commit.',
          currentRevision: written.current?.revision ?? null,
          run: written.current,
          projection:
            written.current !== null
              ? buildWorkflowRunControlProjection(written.current)
              : null
        };
      }
      return {
        accepted: true,
        idempotentReplay: false,
        run: written.run,
        receipt,
        projection: buildWorkflowRunControlProjection(written.run)
      };
    }

    // 6. Evaluate control transition table.
    const decision = evaluateControlTransition({
      run,
      operation: request.operation,
      ...(request.targetInvocationId !== undefined
        ? { targetInvocationId: request.targetInvocationId }
        : {}),
      ...(request.targetNodeId !== undefined ? { targetNodeId: request.targetNodeId } : {})
    });
    if (!decision.allowed) {
      return {
        accepted: false,
        refusalCode: decision.refusalCode,
        reason: decision.reason,
        currentRevision: run.revision,
        run,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    const staging = createStagingWriter(run);
    let spawnedInvocationId: string | undefined;
    let spawnedAttemptId: string | undefined;
    let undispatched: ComposableWorkflowStepResult | undefined;

    switch (request.operation) {
      case 'pause': {
        await this.applyPause(
          staging,
          run,
          queueId,
          decision.targetInvocationId,
          decision.affectedInvocationIds,
          request.pauseCause ?? 'operator-pause',
          request.now
        );
        break;
      }
      case 'resume': {
        const out = await this.applyResume(
          staging,
          run,
          decision.targetInvocationId,
          decision.affectedInvocationIds,
          request.now
        );
        spawnedAttemptId = out.spawnedAttemptId;
        undispatched = out.undispatched;
        break;
      }
      case 'cancel': {
        await this.applyCancel(
          staging,
          run,
          queueId,
          decision.targetInvocationId,
          decision.affectedInvocationIds,
          decision.isRootTarget,
          request.now
        );
        break;
      }
      case 'retry-phase': {
        const out = await this.applyRetryPhase(
          staging,
          run,
          decision.targetInvocationId,
          decision.targetNodeId ?? '',
          request.now
        );
        spawnedAttemptId = out.spawnedAttemptId;
        undispatched = out.undispatched;
        break;
      }
      case 'retry-invocation': {
        const out = await this.applyRetryInvocation(
          staging,
          run,
          decision.targetInvocationId,
          request.now
        );
        spawnedInvocationId = out.spawnedInvocationId;
        spawnedAttemptId = out.spawnedAttemptId;
        undispatched = out.undispatched;
        break;
      }
      case 'continue-handoff': {
        const out = await this.applyContinueHandoff(
          staging,
          run,
          decision.targetInvocationId,
          decision.targetNodeId ?? '',
          request.continuationRequest,
          request.commandId,
          request.now
        );
        if (!out.accepted) {
          return {
            accepted: false,
            refusalCode: 'handoff-not-pending',
            reason: 'Pending handoff could not be accepted for the target node.',
            currentRevision: run.revision,
            run,
            projection: buildWorkflowRunControlProjection(run)
          };
        }
        spawnedAttemptId = out.spawnedAttemptId;
        undispatched = out.undispatched;
        break;
      }
    }

    // A control that exists to start a Phase attempt and could not start one is a
    // refusal, not an accepted command: the staged frames are dropped, so the run,
    // its attempt counts and its pending handoff stay exactly as the operator saw them.
    if (undispatched !== undefined) {
      return {
        accepted: false,
        refusalCode: 'invalid-state-for-operation',
        reason: `Operation '${request.operation}' did not start a Phase attempt (${describeUndispatchedStep(run, staging.current(), undispatched)}); the run is unchanged.`,
        currentRevision: run.revision,
        run,
        projection: buildWorkflowRunControlProjection(run)
      };
    }

    const afterMutation = staging.current();
    const rootId = resolveRootInvocationId(afterMutation);
    const rootStatus = afterMutation.invocations?.[rootId]?.status ?? 'in-flight';
    const targetStatus =
      afterMutation.invocations?.[decision.targetInvocationId]?.status ?? rootStatus;

    const receipt: CommittedCommandReceipt = Object.freeze({
      commandId: request.commandId,
      operation: request.operation,
      targetInvocationId: decision.targetInvocationId,
      ...(decision.targetNodeId !== null ? { targetNodeId: decision.targetNodeId } : {}),
      committedRevision: run.revision + 1,
      committedAt: request.now,
      resultingRunStatus: rootStatus,
      resultingInvocationStatus: targetStatus,
      ...(spawnedInvocationId !== undefined ? { spawnedInvocationId } : {}),
      ...(spawnedAttemptId !== undefined ? { spawnedAttemptId } : {})
    });

    const withReceipt = appendCommandReceipt(
      { ...afterMutation, revision: run.revision },
      receipt
    );
    assertConnectedRunInvariants(withReceipt);

    const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
      withReceipt,
      run.revision
    );
    if (written.outcome === 'stale') {
      return {
        accepted: false,
        refusalCode: 'stale-revision',
        reason: 'Concurrent modification detected during command commit.',
        currentRevision: written.current?.revision ?? null,
        run: written.current,
        projection:
          written.current !== null
            ? buildWorkflowRunControlProjection(written.current)
            : null
      };
    }

    const finalRootFrame = written.run.invocations?.[rootId];
    if (
      finalRootFrame !== undefined &&
      isTerminalInvocationStatus(finalRootFrame.status) &&
      this.deps.releaseQueueLease !== undefined
    ) {
      await this.deps.releaseQueueLease(queueId, written.run.connectedRunId);
    }

    return {
      accepted: true,
      idempotentReplay: false,
      run: written.run,
      receipt,
      projection: buildWorkflowRunControlProjection(written.run)
    };
  }

  private async applyPause(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    queueId: string,
    targetInvocationId: string,
    affectedInvocationIds: readonly string[],
    pauseCause: WorkflowPauseCause,
    now: number
  ): Promise<void> {
    const ancestorIds = collectAncestorInvocationIds(run, targetInvocationId);
    const allPausedIds = Array.from(new Set([...affectedInvocationIds, ...ancestorIds]));

    for (const { frame, attempt } of findInFlightLeafAttempts(run, affectedInvocationIds)) {
      await this.deps.abortActiveLeaf?.({
        runId: run.connectedRunId,
        queueId,
        invocationId: frame.invocationId,
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        ...(attempt.queueItemId !== undefined ? { queueItemId: attempt.queueItemId } : {})
      });
    }

    let nextRun = staging.current();
    for (const invId of allPausedIds) {
      const frame = nextRun.invocations?.[invId];
      if (frame === undefined || isTerminalInvocationStatus(frame.status)) continue;

      this.deps.cancelRetryTimer?.(queueId, run.connectedRunId, invId);

      let updatedFrame: WorkflowInvocationFrame = {
        ...frame,
        status: 'paused',
        controlMarkers: pauseInvocationControlMarkers(frame.controlMarkers, now, pauseCause)
      };

      for (const attempts of Object.values(updatedFrame.attemptsByNodeId)) {
        const last = attempts[attempts.length - 1];
        if (
          last !== undefined &&
          (last.status === 'in-flight' || last.status === 'pending-dispatch') &&
          last.nodeKind === 'phase'
        ) {
          updatedFrame = recordNodeAttempt(updatedFrame, {
            ...last,
            status: 'paused',
            completedAt: now
          });
        }
      }

      nextRun = upsertInvocationFrame(nextRun, updatedFrame);
    }

    staging.set(nextRun);
  }

  private async applyResume(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    targetInvocationId: string,
    affectedInvocationIds: readonly string[],
    now: number
  ): Promise<DispatchStepOutcome> {
    const ancestorIds = collectAncestorInvocationIds(run, targetInvocationId);
    const allToUnpause = Array.from(new Set([...affectedInvocationIds, ...ancestorIds]));

    let nextRun = staging.current();
    let deepestLeafFrame: WorkflowInvocationFrame | undefined;

    for (const invId of allToUnpause) {
      const frame = nextRun.invocations?.[invId];
      if (frame === undefined || frame.status !== 'paused') continue;

      const restoredStatus =
        frame.pendingHandoff !== undefined &&
        frame.pendingHandoff !== null &&
        frame.pendingHandoff.acceptedEnvelope === undefined
          ? 'waiting-for-handoff'
          : 'in-flight';

      const unpausedFrame: WorkflowInvocationFrame = {
        ...frame,
        status: restoredStatus,
        controlMarkers: clearInvocationControlMarkers(frame.controlMarkers)
      };
      nextRun = upsertInvocationFrame(nextRun, unpausedFrame);

      if (
        affectedInvocationIds.includes(invId) &&
        (deepestLeafFrame === undefined || unpausedFrame.depth >= deepestLeafFrame.depth)
      ) {
        deepestLeafFrame = unpausedFrame;
      }
    }

    staging.set(nextRun);

    if (deepestLeafFrame !== undefined && deepestLeafFrame.status === 'in-flight') {
      const leafAttempt = findLatestLeafPhaseAttempt(deepestLeafFrame);
      const nodeToDispatch =
        leafAttempt?.nodeId ?? deepestLeafFrame.activeNodeId ?? deepestLeafFrame.entryNodeId;
      if (leafAttempt !== undefined && leafAttempt.status === 'paused') {
        const evidence =
          this.deps.checkDurableAttemptEvidence?.(
            run.connectedRunId,
            deepestLeafFrame.invocationId,
            leafAttempt
          ) ?? null;
        // A canceled child is the pause's own effect, not an outcome: Resume starts a new attempt.
        if (
          evidence !== null &&
          (evidence.settled === true || evidence.completed === true) &&
          evidence.status !== undefined &&
          evidence.status !== 'canceled'
        ) {
          const settled = await completeComposableNodeAttempt(
            this.coordinatorDeps(staging.writer),
            {
              run: staging.current(),
              invocationId: deepestLeafFrame.invocationId,
              nodeId: leafAttempt.nodeId,
              attemptIndex: leafAttempt.attemptIndex,
              status: evidence.status,
              completedAt: evidence.completedAt ?? now,
              ...(evidence.declaredOutputs !== undefined
                ? { declaredOutputs: evidence.declaredOutputs }
                : {}),
              ...(evidence.decisionResults !== undefined
                ? { decisionResults: evidence.decisionResults }
                : {}),
              ...(evidence.verdict !== undefined ? { verdict: evidence.verdict } : {}),
              ...(evidence.failureCode !== undefined ? { failureCode: evidence.failureCode } : {})
            }
          );
          if (settled.outcome === 'phase-dispatched') {
            return { spawnedAttemptId: settled.attemptId };
          }
          if (
            settled.outcome === 'workflow-completed' ||
            settled.outcome === 'waiting-for-handoff' ||
            settled.outcome === 'workflow-failed' ||
            settled.outcome === 'workflow-canceled'
          ) {
            return {};
          }
          return { undispatched: settled };
        }

        const boundQueueId = resolveBoundQueueId(run);
        if (
          leafAttempt.queueItemId !== undefined &&
          this.deps.isQueueOrTaskPresent?.(boundQueueId, leafAttempt.queueItemId) === true
        ) {
          const { completedAt: _completedAt, ...activeAttemptRest } = leafAttempt;
          const reactivatedAttempt: NodeAttemptRecord = Object.freeze({
            ...activeAttemptRest,
            status: 'in-flight'
          });
          const frameWithReactivated = recordNodeAttempt(deepestLeafFrame, reactivatedAttempt);
          staging.set(upsertInvocationFrame(staging.current(), frameWithReactivated));
          return {};
        }
      }
      if (leafAttempt === undefined || leafAttempt.status === 'paused') {
        const dispatched = await dispatchComposableNode(
          this.coordinatorDeps(staging.writer),
          {
            run: staging.current(),
            invocationId: deepestLeafFrame.invocationId,
            nodeId: nodeToDispatch,
            startedAt: now
          }
        );
        return dispatched.outcome === 'phase-dispatched'
          ? { spawnedAttemptId: dispatched.attemptId }
          : { undispatched: dispatched };
      }
    }

    return {};
  }

  private async applyCancel(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    queueId: string,
    targetInvocationId: string,
    affectedInvocationIds: readonly string[],
    isRootTarget: boolean,
    now: number
  ): Promise<void> {
    for (const { frame, attempt } of findInFlightLeafAttempts(run, affectedInvocationIds)) {
      await this.deps.abortActiveLeaf?.({
        runId: run.connectedRunId,
        queueId,
        invocationId: frame.invocationId,
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        ...(attempt.queueItemId !== undefined ? { queueItemId: attempt.queueItemId } : {})
      });
    }

    let nextRun = staging.current();
    for (const invId of affectedInvocationIds) {
      const frame = nextRun.invocations?.[invId];
      if (frame === undefined || isTerminalInvocationStatus(frame.status)) continue;

      this.deps.cancelRetryTimer?.(queueId, run.connectedRunId, invId);

      let updatedFrame: WorkflowInvocationFrame = {
        ...frame,
        activeNodeId: null,
        status: 'canceled',
        completedAt: now,
        pendingHandoff: null,
        controlMarkers: clearInvocationControlMarkers(frame.controlMarkers)
      };

      for (const attempts of Object.values(updatedFrame.attemptsByNodeId)) {
        const last = attempts[attempts.length - 1];
        if (
          last !== undefined &&
          (last.status === 'in-flight' ||
            last.status === 'paused' ||
            last.status === 'pending-dispatch')
        ) {
          updatedFrame = recordNodeAttempt(updatedFrame, {
            ...last,
            status: 'canceled',
            completedAt: now
          });
        }
      }

      nextRun = upsertInvocationFrame(nextRun, updatedFrame);
    }

    if (isRootTarget) {
      if (nextRun.pendingHandoff !== undefined && nextRun.pendingHandoff !== null) {
        nextRun = setPendingHandoff(nextRun, null);
      }
      staging.set(nextRun);
      return;
    }

    const targetFrame = nextRun.invocations?.[targetInvocationId];
    if (
      targetFrame !== undefined &&
      targetFrame.parentInvocationId !== null &&
      targetFrame.parentCallNodeId !== null
    ) {
      let parentFrame = nextRun.invocations?.[targetFrame.parentInvocationId];
      if (parentFrame !== undefined) {
        if (parentFrame.status === 'paused') {
          parentFrame = {
            ...parentFrame,
            status: 'in-flight',
            controlMarkers: clearInvocationControlMarkers(parentFrame.controlMarkers)
          };
          nextRun = upsertInvocationFrame(nextRun, parentFrame);
        }
        const parentAttempts = attemptsForNode(parentFrame, targetFrame.parentCallNodeId);
        const parentAttempt = parentAttempts.find(
          (a) => a.childInvocationId === targetInvocationId
        );
        staging.set(nextRun);
        if (parentAttempt !== undefined) {
          await completeComposableNodeAttempt(
            this.coordinatorDeps(staging.writer),
            {
              run: staging.current(),
              invocationId: parentFrame.invocationId,
              nodeId: parentAttempt.nodeId,
              attemptIndex: parentAttempt.attemptIndex,
              status: 'canceled',
              completedAt: now
            }
          );
          return;
        }
      }
    }

    staging.set(nextRun);
  }

  private async applyRetryPhase(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    targetInvocationId: string,
    targetNodeId: string,
    now: number
  ): Promise<DispatchStepOutcome> {
    const ancestorIds = collectAncestorInvocationIds(run, targetInvocationId);
    const chainIds = [targetInvocationId, ...ancestorIds];
    let nextRun = staging.current();

    for (const invId of chainIds) {
      const frame = nextRun.invocations?.[invId];
      if (frame === undefined) continue;
      nextRun = upsertInvocationFrame(nextRun, reactivateFrame(frame, false));
    }

    staging.set(nextRun);

    const dispatched = await dispatchComposableNode(
      this.coordinatorDeps(staging.writer),
      {
        run: staging.current(),
        invocationId: targetInvocationId,
        nodeId: targetNodeId,
        startedAt: now
      }
    );

    return dispatched.outcome === 'phase-dispatched'
      ? { spawnedAttemptId: dispatched.attemptId }
      : { undispatched: dispatched };
  }

  private async applyRetryInvocation(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    targetInvocationId: string,
    now: number
  ): Promise<DispatchStepOutcome> {
    const targetFrame = run.invocations?.[targetInvocationId];
    if (targetFrame === undefined) {
      return {};
    }

    let nextRun = staging.current();

    if (targetFrame.parentInvocationId !== null && targetFrame.parentCallNodeId !== null) {
      if (targetFrame.status === 'paused') {
        nextRun = upsertInvocationFrame(nextRun, {
          ...targetFrame,
          activeNodeId: null,
          status: 'canceled',
          completedAt: now,
          controlMarkers: clearInvocationControlMarkers(targetFrame.controlMarkers)
        });
      }

      const ancestorIds = collectAncestorInvocationIds(nextRun, targetInvocationId);
      for (const ancId of ancestorIds) {
        const ancFrame = nextRun.invocations?.[ancId];
        if (ancFrame === undefined) continue;
        nextRun = upsertInvocationFrame(nextRun, reactivateFrame(ancFrame, true));
      }

      staging.set(nextRun);

      const beforeDispatch = staging.current();
      const dispatched = await dispatchComposableNode(
        this.coordinatorDeps(staging.writer),
        {
          run: beforeDispatch,
          invocationId: targetFrame.parentInvocationId,
          nodeId: targetFrame.parentCallNodeId,
          startedAt: now
        }
      );

      if (dispatched.outcome !== 'phase-dispatched') {
        return { undispatched: dispatched };
      }

      const spawnedInvocationId = findNewChildInvocationId(beforeDispatch, staging.current());
      return {
        spawnedAttemptId: dispatched.attemptId,
        ...(spawnedInvocationId !== undefined ? { spawnedInvocationId } : {})
      };
    }

    nextRun = upsertInvocationFrame(nextRun, reactivateFrame(targetFrame, true));
    staging.set(nextRun);

    const dispatched = await dispatchComposableNode(
      this.coordinatorDeps(staging.writer),
      {
        run: staging.current(),
        invocationId: targetInvocationId,
        nodeId: targetFrame.entryNodeId,
        startedAt: now
      }
    );

    return dispatched.outcome === 'phase-dispatched'
      ? { spawnedAttemptId: dispatched.attemptId }
      : { undispatched: dispatched };
  }

  private async applyContinueHandoff(
    staging: StagingBuffer,
    run: ConnectedWorkflowRun,
    targetInvocationId: string,
    targetNodeId: string,
    continuationRequest: RunRequest | undefined,
    commandId: string,
    now: number
  ): Promise<DispatchStepOutcome & { readonly accepted: boolean }> {
    if (!approvePendingPhaseHandoffForContinue(this.deps.phaseHandoffCoordinator, run, targetInvocationId, commandId)) {
      return { accepted: false };
    }

    const requestPayload: RunRequest = continuationRequest ?? {
      pipelineId: targetNodeId,
      workflowId: run.workflowId,
      inputs: [],
      supplemental: [],
      outputs: []
    };

    const accepted = await continueWaitingHandoff(
      { connectedRuns: staging.writer },
      {
        run: staging.current(),
        expectedRevision: staging.current().revision,
        invocationId: targetInvocationId,
        targetNodeId,
        request: requestPayload,
        acceptedAt: now
      }
    );

    if (accepted.outcome !== 'accepted') {
      return { accepted: false };
    }

    const dispatched = await dispatchComposableNode(
      this.coordinatorDeps(staging.writer),
      {
        run: staging.current(),
        invocationId: targetInvocationId,
        nodeId: targetNodeId,
        startedAt: now
      }
    );
    return dispatched.outcome === 'phase-dispatched'
      ? { accepted: true, spawnedAttemptId: dispatched.attemptId }
      : { accepted: true, undispatched: dispatched };
  }
}
