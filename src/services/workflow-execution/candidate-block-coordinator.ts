/**
 * FR-R8-01 (01-05) — Coordinator integration for `CandidateBlockControl`
 * workflows (`workflow.control.kind === 'candidate-block'`).
 *
 * Bridges `ConnectedWorkflowRun` dispatch, settlement, and crash recovery to
 * `CandidateBlockExecutor` without duplicating attempt admission or exceeding
 * `connected-run-coordinator.ts`'s LOC budget. Zero `vscode` imports.
 */

import type { FrozenPhaseQuotaTarget } from '../../contracts/backend-availability';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type {
  ControlFrame,
  ControlUsageRecord,
  ExecutionFence
} from '../../contracts/control-ledger';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { FrozenPhaseHandoffDelivery, ResolvedPortValue } from '../../contracts/run-request';
import type { WorkflowLeafTarget } from '../../contracts/workflow-leaf-target';
import type { ConnectedRunWriteResult } from '../../state/workspace-state';
import type { PhaseHandoffCoordinator } from '../phase-context/phase-handoff-coordinator';
import { buildAttemptHandoffDelivery } from './phase-handoff-execution-bridge';
import {
  DEFAULT_CANDIDATE_INITIAL_DELAY_MS,
  DEFAULT_CANDIDATE_MAX_DELAY_MS,
  DEFAULT_CANDIDATE_RETRY_MULTIPLIER,
  resolveCandidateBlockDefaults,
  type CandidateBlockControl,
  type ResolvedCandidateSpec
} from '../../contracts/workflow-controls';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeTerminalStatus
} from '../../contracts/workflow-definitions';
import {
  attemptsForNode,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  resolveBoundQueueId,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame,
  type WorkflowPauseCause
} from '../../state/connected-workflow-run';
import {
  CandidateBlockExecutor,
  type CandidateMemberSpec,
  type SettleCandidateAttemptInput
} from './candidate-block-executor';
import {
  resolveNodeInputBindings,
  resolveWorkflowPublicOutputs
} from './binding-resolver';
import { createNodeAttemptRecord } from './connected-run-factory';

const DEFAULT_BACKEND: BackendRunnerKind = 'claude';

export interface CandidateBudgetPolicyEntry {
  readonly upperBoundMicrousd?: number | undefined;
  readonly upperBoundQuality?: 'verified' | 'estimated' | 'unavailable' | undefined;
  readonly quotaTarget?: FrozenPhaseQuotaTarget | undefined;
  readonly quotaIds?: readonly string[] | undefined;
}

export type CandidateSpecResolver = (input: {
  readonly run: ConnectedWorkflowRun;
  readonly workflow: WorkflowDefinition;
  readonly candidateId: string;
  readonly nodeId: string;
  readonly phase: PhaseDefinition;
}) => CandidateBudgetPolicyEntry | undefined;

export interface CandidateSettlementExtras {
  readonly outcomeOverride?: SettleCandidateAttemptInput['outcome'] | undefined;
  readonly resetsAtMs?: number | null | undefined;
  readonly topUpRequired?: boolean | undefined;
  readonly usageRecord?: ControlUsageRecord | undefined;
}

export type CandidateDispatchDecision =
  | {
      readonly kind: 'dispatch-phase';
      readonly node: WorkflowNode;
      readonly phase: PhaseDefinition;
      readonly candidateId: string;
      readonly pendingAttempt: NodeAttemptRecord;
      readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
      readonly inputEnvelope: InvocationInputEnvelope;
      readonly fence: ExecutionFence;
      readonly updatedRun: ConnectedWorkflowRun;
      readonly updatedFrame: WorkflowInvocationFrame;
    }
  | {
      readonly kind: 'paused';
      readonly run: ConnectedWorkflowRun;
      readonly pauseCause: string;
    }
  | {
      readonly kind: 'failed';
      readonly frame: WorkflowInvocationFrame;
      readonly failureCode: string;
      readonly detail?: string | undefined;
    }
  | {
      readonly kind: 'stale-fence';
      readonly detail: string;
    }
  | {
      readonly kind: 'noop-active';
      readonly run: ConnectedWorkflowRun;
      readonly status: 'executing' | 'retry-delayed' | 'completed';
    };

export function buildCandidateMemberSpecs(input: {
  readonly run: ConnectedWorkflowRun;
  readonly workflow: WorkflowDefinition;
  readonly control: CandidateBlockControl;
  readonly resolveCandidateSpec?: CandidateSpecResolver | undefined;
}): {
  readonly specs: readonly CandidateMemberSpec[];
  readonly byId: Readonly<Record<string, CandidateMemberSpec>>;
  readonly resolvedById: Readonly<Record<string, ResolvedCandidateSpec>>;
} {
  const closure = input.run.frozenClosure;
  const resolved = resolveCandidateBlockDefaults(input.control);
  const specs: CandidateMemberSpec[] = [];
  const byId: Record<string, CandidateMemberSpec> = {};
  const resolvedById: Record<string, ResolvedCandidateSpec> = {};

  resolved.candidates.forEach((cand, authoredOrder) => {
    resolvedById[cand.candidateId] = cand;
    const node = input.workflow.nodes.find((n) => n.nodeId === cand.nodeId);
    const phase =
      node?.phaseId !== undefined && closure !== undefined
        ? closure.phasesById[node.phaseId]
        : undefined;
    const backend: BackendRunnerKind = phase?.runner ?? DEFAULT_BACKEND;
    const extra =
      phase !== undefined
        ? input.resolveCandidateSpec?.({
            run: input.run,
            workflow: input.workflow,
            candidateId: cand.candidateId,
            nodeId: cand.nodeId,
            phase
          })
        : undefined;
    const spec: CandidateMemberSpec = Object.freeze({
      candidateId: cand.candidateId,
      nodeId: cand.nodeId,
      backend,
      ...(phase?.model !== undefined ? { modelId: phase.model } : {}),
      priority: cand.priority,
      authoredOrder,
      maxAttempts: cand.maxAttempts,
      allowUnverifiedTrial: cand.allowUnverifiedTrial,
      hasSideEffects: phase !== undefined ? phase.sideEffects !== 'none' : true,
      ...(extra?.quotaTarget !== undefined ? { quotaTarget: extra.quotaTarget } : {}),
      ...(extra?.quotaIds !== undefined ? { quotaIds: extra.quotaIds } : {}),
      ...(extra?.upperBoundMicrousd !== undefined
        ? { upperBoundMicrousd: extra.upperBoundMicrousd }
        : {}),
      ...(extra?.upperBoundQuality !== undefined
        ? { upperBoundQuality: extra.upperBoundQuality }
        : {})
    });
    specs.push(spec);
    byId[cand.candidateId] = spec;
  });

  return {
    specs: Object.freeze(specs),
    byId: Object.freeze(byId),
    resolvedById: Object.freeze(resolvedById)
  };
}

export function computeCandidateRetryDelayMs(
  spec: ResolvedCandidateSpec | undefined,
  attemptOrdinal: number
): number {
  const initial = spec?.retry.initialDelayMs ?? DEFAULT_CANDIDATE_INITIAL_DELAY_MS;
  const multiplier = spec?.retry.multiplier ?? DEFAULT_CANDIDATE_RETRY_MULTIPLIER;
  const maxDelay = spec?.retry.maxDelayMs ?? DEFAULT_CANDIDATE_MAX_DELAY_MS;
  const raw = Math.round(initial * Math.pow(multiplier, Math.max(0, attemptOrdinal - 1)));
  return Math.min(maxDelay, Math.max(0, raw));
}

export function classifyCandidateSettlementOutcome(input: {
  readonly status: WorkflowNodeTerminalStatus;
  readonly failureCode?: string | undefined;
  readonly verdict?: 'pass' | 'fail' | null | undefined;
  readonly extras?: CandidateSettlementExtras | undefined;
}): SettleCandidateAttemptInput['outcome'] {
  if (input.extras?.outcomeOverride !== undefined) {
    return input.extras.outcomeOverride;
  }
  if (input.status === 'completed' && input.verdict !== 'fail') {
    return 'succeeded';
  }
  if (input.status === 'canceled') {
    return 'canceled';
  }
  const code = (input.failureCode ?? '').toLowerCase();
  if (code.includes('uncertain') || code.includes('recovery-uncertain-effect')) {
    return 'uncertain-effect';
  }
  if (
    code.startsWith('typed-result-') ||
    code.includes('invalid-output') ||
    code.includes('missing-required-output')
  ) {
    return 'invalid-output';
  }
  if (
    code.includes('rate-limit') ||
    code.includes('availability') ||
    code.includes('credit') ||
    code.includes('quota') ||
    code.includes('cooldown') ||
    code.includes('unavailable') ||
    input.extras?.topUpRequired === true ||
    input.extras?.resetsAtMs !== undefined
  ) {
    return 'retryable-availability';
  }
  if (
    code.includes('permanent') ||
    code.includes('auth') ||
    code.includes('denied') ||
    code.includes('uncontained') ||
    code.includes('fatal') ||
    code.includes('ineligible')
  ) {
    return 'permanent-failure';
  }
  return 'retryable-transient';
}

function mapPauseCauseForFrame(raw: string): WorkflowPauseCause {
  if (raw === 'credit-top-up-required' || raw === 'rate-limit' || raw === 'out-of-credits') {
    return 'credit-exhausted';
  }
  if (raw === 'spend-limit-reached' || raw === 'spend-unverifiable' || raw === 'spend-bound-exceeded') {
    return 'spend-bound-exceeded';
  }
  if (raw === 'recovery-uncertain-effect' || raw === 'uncertain-effect') {
    return 'recovery-uncertain-effect';
  }
  return 'operator-pause';
}

function pauseRunForCandidateBlock(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  pauseCause: string,
  pausedAt: number
): ConnectedWorkflowRun {
  const mappedCause = mapPauseCauseForFrame(pauseCause);
  const pausedFrame: WorkflowInvocationFrame = {
    ...frame,
    status: 'paused',
    controlMarkers: pauseInvocationControlMarkers(frame.controlMarkers, pausedAt, mappedCause)
  };
  let nextRun = upsertInvocationFrame(run, pausedFrame);
  // Propagate pause to ancestors so root projection visibly reflects waiting/intervention
  let cursor = pausedFrame;
  while (cursor.parentInvocationId !== null) {
    const parent = nextRun.invocations?.[cursor.parentInvocationId];
    if (parent === undefined) break;
    const pausedParent: WorkflowInvocationFrame = {
      ...parent,
      status: 'paused',
      controlMarkers: pauseInvocationControlMarkers(parent.controlMarkers, pausedAt, mappedCause)
    };
    nextRun = upsertInvocationFrame(nextRun, pausedParent);
    cursor = pausedParent;
  }
  return nextRun;
}

export async function prepareCandidateBlockDispatch(input: {
  readonly executor: CandidateBlockExecutor;
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly workflow: WorkflowDefinition;
  readonly control: CandidateBlockControl;
  readonly fence: ExecutionFence;
  readonly startedAt: number;
  readonly handoffEnvelope?: InvocationInputEnvelope | undefined;
  readonly resolveCandidateSpec?: CandidateSpecResolver | undefined;
}): Promise<CandidateDispatchDecision> {
  const { executor, run, frame, workflow, control, fence, startedAt } = input;
  const closure = run.frozenClosure;
  const rootRunId = run.controlState?.ledgerRunId ?? run.connectedRunId;
  const frameKey = frame.invocationId;
  const resolvedControl = resolveCandidateBlockDefaults(control);
  const { specs, byId } = buildCandidateMemberSpecs({
    run,
    workflow,
    control,
    resolveCandidateSpec: input.resolveCandidateSpec
  });

  const existingRoot = executor.getLedgerStore().getRoot(rootRunId);
  const existingFrame: ControlFrame | undefined = existingRoot?.framesByKey[frameKey];
  if (existingFrame === undefined || existingFrame.kind !== 'candidate-block') {
    const initRes = await executor.initializeCandidateBlock({
      rootRunId,
      workflowId: workflow.workflowId,
      frameKey,
      parentFrameKey: frame.parentInvocationId ?? null,
      invocationId: frame.invocationId,
      nodeId: frame.parentCallNodeId ?? workflow.workflowId,
      selectionPolicy: resolvedControl.availabilityPolicy,
      maxBlockAttempts: resolvedControl.maxDispatches,
      candidates: specs,
      fence
    });
    if (!initRes.ok) {
      if (
        initRes.code === 'stale-execution-fence' ||
        initRes.message?.toLowerCase().includes('fence') === true
      ) {
        return { kind: 'stale-fence', detail: initRes.message ?? 'Stale execution fence.' };
      }
      return {
        kind: 'failed',
        frame,
        failureCode: 'candidate-block-init-failed',
        detail: initRes.message
      };
    }
  }

  const stepped = await executor.stepCandidateBlock({
    rootRunId,
    frameKey,
    fence,
    candidateSpecsById: byId
  });

  if (!stepped.ok) {
    if (
      stepped.code === 'stale-execution-fence' ||
      stepped.message?.toLowerCase().includes('fence') === true ||
      stepped.message?.includes('stale-execution-fence') === true
    ) {
      return { kind: 'stale-fence', detail: stepped.message ?? 'Stale execution fence.' };
    }
    if (
      stepped.action.kind === 'pause-intervention' &&
      (stepped.action.pauseCause === 'spend-limit-reached' ||
        stepped.action.pauseCause === 'spend-unverifiable')
    ) {
      return {
        kind: 'paused',
        run: pauseRunForCandidateBlock(run, frame, stepped.action.pauseCause, startedAt),
        pauseCause: stepped.action.pauseCause
      };
    }
    return {
      kind: 'failed',
      frame,
      failureCode: 'candidate-block-step-failed',
      detail: stepped.message
    };
  }

  const { action } = stepped;
  if (action.kind === 'noop-active') {
    return { kind: 'noop-active', run, status: action.status };
  }
  if (action.kind === 'fail-exhausted') {
    return {
      kind: 'failed',
      frame,
      failureCode: action.failureCode,
      detail: `Candidate block '${workflow.workflowId}' exhausted (${action.failureCode}).`
    };
  }
  if (
    action.kind === 'wait-backoff' ||
    action.kind === 'wait-availability' ||
    action.kind === 'pause-intervention' ||
    action.kind === 'pause-monitoring-expired'
  ) {
    const pauseCause =
      action.kind === 'pause-intervention' || action.kind === 'pause-monitoring-expired'
        ? action.pauseCause
        : action.kind === 'wait-availability'
          ? 'waiting-availability'
          : 'retry-backoff';
    return {
      kind: 'paused',
      run: pauseRunForCandidateBlock(run, frame, pauseCause, startedAt),
      pauseCause
    };
  }

  // `action.kind === 'dispatch-candidate'`
  const selectedSlot = action.candidate;
  const committedAttempt = stepped.attempt;
  const node = workflow.nodes.find((n) => n.nodeId === selectedSlot.nodeId);
  const phase =
    node?.phaseId !== undefined && closure !== undefined
      ? closure.phasesById[node.phaseId]
      : undefined;
  if (node === undefined || phase === undefined) {
    return {
      kind: 'failed',
      frame,
      failureCode: 'workflow-closure-invalid',
      detail: `Candidate '${selectedSlot.candidateId}' target node/phase missing from frozen closure.`
    };
  }

  const resolvedInputs = resolveNodeInputBindings({
    workflow,
    frame,
    targetNodeId: node.nodeId,
    ...(input.handoffEnvelope !== undefined
      ? { overrideInputsByPort: input.handoffEnvelope.inputsByPort }
      : {})
  });
  if (!resolvedInputs.ok) {
    return {
      kind: 'failed',
      frame,
      failureCode: resolvedInputs.code,
      detail: resolvedInputs.message
    };
  }

  const existingNodeAttempts = attemptsForNode(frame, node.nodeId);
  const attemptIndex = committedAttempt?.attemptIndex ?? existingNodeAttempts.length + 1;
  const attemptId =
    committedAttempt?.attemptId ??
    `${frame.invocationId}:${selectedSlot.candidateId}:attempt-${attemptIndex}`;
  const inputEnvelope: InvocationInputEnvelope =
    input.handoffEnvelope ??
    Object.freeze({
      envelopeId: `${frame.invocationId}:${node.nodeId}:attempt-${attemptIndex}:env`,
      invocationId: frame.invocationId,
      targetNodeId: node.nodeId,
      source: 'binding',
      inputsByPort: resolvedInputs.resolvedByPort,
      localInputs: Object.freeze([]),
      outputTargetOverrides: Object.freeze([]),
      acceptedAt: startedAt
    });

  const pendingAttempt = createNodeAttemptRecord({
    frame,
    nodeId: node.nodeId,
    nodeKind: 'phase',
    targetDefinitionId: phase.phaseId,
    inputEnvelope,
    startedAt,
    attemptId,
    attemptIndex,
    status: 'pending-dispatch'
  });

  const frameWithPending = recordNodeAttempt(
    {
      ...frame,
      activeNodeId: node.nodeId,
      status: 'in-flight'
    },
    pendingAttempt
  );
  const updatedRun = upsertInvocationFrame(run, frameWithPending);

  return {
    kind: 'dispatch-phase',
    node,
    phase,
    candidateId: selectedSlot.candidateId,
    pendingAttempt,
    boundInputs: resolvedInputs.resolvedByPort,
    inputEnvelope,
    fence,
    updatedRun,
    updatedFrame: frameWithPending
  };
}

export function findCandidateIdForNode(
  control: CandidateBlockControl,
  nodeId: string
): string | undefined {
  return control.candidates.find((c) => c.nodeId === nodeId)?.candidateId;
}

export function extractValidatedOutputStrings(
  declaredOutputs?: Readonly<Record<string, ResolvedPortValue>>
): Readonly<Record<string, string>> | undefined {
  if (declaredOutputs === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, port] of Object.entries(declaredOutputs)) {
    if (typeof port.value === 'string') out[key] = port.value;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

export function findCandidateBlockRecoveryState(input: {
  readonly executor: CandidateBlockExecutor;
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
}):
  | { readonly kind: 'none' }
  | {
      readonly kind: 'return-already-committed';
      readonly winningCandidateId: string;
      readonly winningAttemptId: string;
      readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
    }
  | { readonly kind: 'needs-step'; readonly ledgerFrame: ControlFrame } {
  const rootRunId = input.run.controlState?.ledgerRunId ?? input.run.connectedRunId;
  const root = input.executor.getLedgerStore().getRoot(rootRunId);
  const ledgerFrame = root?.framesByKey[input.frame.invocationId];
  if (ledgerFrame === undefined || ledgerFrame.kind !== 'candidate-block') {
    return { kind: 'none' };
  }
  if (
    ledgerFrame.returnCommitId !== undefined &&
    ledgerFrame.winningCandidateId !== undefined &&
    ledgerFrame.winningAttemptId !== undefined
  ) {
    return {
      kind: 'return-already-committed',
      winningCandidateId: ledgerFrame.winningCandidateId,
      winningAttemptId: ledgerFrame.winningAttemptId,
      decisionResults: ledgerFrame.decisionResults
    };
  }
  const hasInFlightSlot =
    ledgerFrame.candidateSlots?.some((slot) => slot.status === 'in-flight') === true;
  if (!hasInFlightSlot && (ledgerFrame.status === 'selecting' || ledgerFrame.status === 'retry-delayed')) {
    return { kind: 'needs-step', ledgerFrame };
  }
  return { kind: 'none' };
}

export function resolveCandidateQueueId(run: ConnectedWorkflowRun): string {
  return resolveBoundQueueId(run);
}

export type CandidateSettlementDecision =
  | { readonly kind: 'duplicate-noop'; readonly run: ConnectedWorkflowRun }
  | {
      readonly kind: 'completed';
      readonly nextRun: ConnectedWorkflowRun;
      readonly completedFrame: WorkflowInvocationFrame;
      readonly outputs: Readonly<Record<string, ResolvedPortValue>>;
      readonly winningCandidateId: string;
    }
  | {
      readonly kind: 'paused';
      readonly nextRun: ConnectedWorkflowRun;
      readonly pauseCause: string;
    }
  | {
      readonly kind: 'canceled';
      readonly nextRun: ConnectedWorkflowRun;
      readonly frame: WorkflowInvocationFrame;
    }
  | {
      readonly kind: 'retry-or-fallback';
      readonly nextRun: ConnectedWorkflowRun;
      readonly entryNodeId: string;
    }
  | {
      readonly kind: 'failed';
      readonly nextRun: ConnectedWorkflowRun;
      readonly frame: WorkflowInvocationFrame;
      readonly failureCode: string;
      readonly detail?: string | undefined;
    }
  | {
      readonly kind: 'stale-fence';
      readonly detail: string;
    };

export async function settleCandidateBlockStep(input: {
  readonly executor: CandidateBlockExecutor;
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly workflow: WorkflowDefinition;
  readonly control: CandidateBlockControl;
  readonly nodeId: string;
  readonly settledAttempt: NodeAttemptRecord;
  readonly status: WorkflowNodeTerminalStatus;
  readonly completedAt: number;
  readonly fence: ExecutionFence;
  readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>> | undefined;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly verdict?: 'pass' | 'fail' | null | undefined;
  readonly failureCode?: string | undefined;
  readonly extras?: CandidateSettlementExtras | undefined;
  readonly resolveCandidateSpec?: CandidateSpecResolver | undefined;
}): Promise<CandidateSettlementDecision> {
  const { executor, run, frame, workflow, control, nodeId, settledAttempt, completedAt, fence } = input;
  const candidateId = findCandidateIdForNode(control, nodeId) ?? nodeId;
  const { byId, resolvedById } = buildCandidateMemberSpecs({
    run,
    workflow,
    control,
    resolveCandidateSpec: input.resolveCandidateSpec
  });
  const outcome = classifyCandidateSettlementOutcome({
    status: input.status,
    failureCode: input.failureCode,
    verdict: input.verdict,
    extras: input.extras
  });
  const rootRunId = run.controlState?.ledgerRunId ?? run.connectedRunId;
  const retryDelayMs =
    outcome === 'retryable-transient'
      ? computeCandidateRetryDelayMs(resolvedById[candidateId], settledAttempt.attemptIndex)
      : undefined;
  const validatedOutputs = extractValidatedOutputStrings(input.declaredOutputs);
  const spec: CandidateMemberSpec | undefined = Object.hasOwn(byId, candidateId)
    ? byId[candidateId]
    : undefined;

  const settled = await executor.settleCandidateAttempt({
    rootRunId,
    frameKey: frame.invocationId,
    attemptId: settledAttempt.attemptId,
    candidateId,
    fence,
    outcome,
    ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(input.extras?.resetsAtMs !== undefined ? { resetsAtMs: input.extras.resetsAtMs } : {}),
    ...(input.extras?.topUpRequired !== undefined ? { topUpRequired: input.extras.topUpRequired } : {}),
    ...(validatedOutputs !== undefined ? { validatedOutputs } : {}),
    ...(input.decisionResults !== undefined ? { decisionResults: input.decisionResults } : {}),
    ...(input.extras?.usageRecord !== undefined ? { usageRecord: input.extras.usageRecord } : {}),
    ...(spec?.quotaTarget !== undefined ? { quotaTarget: spec.quotaTarget } : {})
  });

  if (!settled.ok) {
    if (settled.code === 'stale-execution-fence') {
      return {
        kind: 'stale-fence',
        detail: settled.message ?? 'Stale execution fence during candidate settlement.'
      };
    }
    return {
      kind: 'failed',
      nextRun: upsertInvocationFrame(run, frame),
      frame,
      failureCode: 'candidate-block-settle-failed',
      detail: settled.message
    };
  }

  // Idempotent duplicate settlement after return already committed
  if (!settled.returnCommitted && settled.returnCommitId !== undefined) {
    return { kind: 'duplicate-noop', run };
  }

  const nextRun = upsertInvocationFrame(run, frame);

  if (settled.returnCommitted) {
    const publicOutputs = resolveWorkflowPublicOutputs({
      workflow,
      frame,
      selectedCandidateId: candidateId
    });
    if (!publicOutputs.ok) {
      return {
        kind: 'failed',
        nextRun,
        frame,
        failureCode: publicOutputs.code,
        detail: publicOutputs.message
      };
    }
    const completedFrame: WorkflowInvocationFrame = {
      ...frame,
      activeNodeId: null,
      status: 'completed',
      completedAt,
      resolvedOutputs: publicOutputs.resolvedByPort
    };
    return {
      kind: 'completed',
      nextRun: upsertInvocationFrame(nextRun, completedFrame),
      completedFrame,
      outputs: publicOutputs.resolvedByPort,
      winningCandidateId: candidateId
    };
  }

  const ledgerStatus = settled.frame?.status;
  if (ledgerStatus === 'intervention-required') {
    const pauseCause = settled.frame?.pauseCause ?? 'intervention-required';
    return {
      kind: 'paused',
      nextRun: pauseRunForCandidateBlock(nextRun, frame, pauseCause, completedAt),
      pauseCause
    };
  }
  if (ledgerStatus === 'canceled' || outcome === 'canceled') {
    return { kind: 'canceled', nextRun, frame };
  }
  return {
    kind: 'retry-or-fallback',
    nextRun,
    entryNodeId: workflow.startNodeIds[0] ?? nodeId
  };
}

export interface CandidateDispatchOrchestrationHooks<TResult> {
  readonly executor: CandidateBlockExecutor;
  readonly connectedRuns: {
    compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRevision: number): Promise<ConnectedRunWriteResult>;
  };
  readonly dispatchPhase: (input: {
    readonly run: ConnectedWorkflowRun;
    readonly frame: WorkflowInvocationFrame;
    readonly node: WorkflowNode;
    readonly phase: PhaseDefinition;
    readonly workflowId: string;
    readonly candidateId: string;
    readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
    readonly inputEnvelope: InvocationInputEnvelope;
    readonly nodePath: string;
    readonly attemptId: string;
    readonly attemptIndex: number;
    readonly queueId: string;
    readonly startedAt: number;
    readonly fence: ExecutionFence;
    readonly phaseHandoff?: FrozenPhaseHandoffDelivery;
  }) => Promise<
    | { readonly outcome: 'dispatched'; readonly queueItemId: string }
    | { readonly outcome: 'rejected'; readonly reason: string; readonly detail?: string }
  >;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;
  readonly resolveExecutionFence?: ((run: ConnectedWorkflowRun, queueId: string) => ExecutionFence) | undefined;
  readonly resolveCandidateSpec?: CandidateSpecResolver | undefined;
  readonly cancelOrphanedQueueItem?: ((target: WorkflowLeafTarget) => Promise<void> | void) | undefined;
  readonly onStale: (current: ConnectedWorkflowRun | null, reason?: 'stale-fence') => TResult;
  readonly onPaused: (run: ConnectedWorkflowRun, invocationId: string, pauseCause: string) => TResult;
  readonly onPhaseDispatched: (input: {
    readonly run: ConnectedWorkflowRun;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly attemptId: string;
    readonly queueItemId: string;
  }) => TResult;
  readonly persistRunStep: (
    nextRun: ConnectedWorkflowRun,
    expectedRevision: number,
    buildSuccess: (persisted: ConnectedWorkflowRun) => TResult
  ) => Promise<TResult>;
  readonly failFrameAndPropagate: (
    run: ConnectedWorkflowRun,
    expectedRevision: number,
    frame: WorkflowInvocationFrame,
    completedAt: number,
    failureCode: string,
    detail?: string
  ) => Promise<TResult>;
}

export async function orchestrateCandidateBlockDispatch<TResult>(
  hooks: CandidateDispatchOrchestrationHooks<TResult>,
  input: {
    readonly run: ConnectedWorkflowRun;
    readonly expectedRevision: number;
    readonly frame: WorkflowInvocationFrame;
    readonly workflow: WorkflowDefinition;
    readonly control: CandidateBlockControl;
    readonly nodeId: string;
    readonly startedAt: number;
    readonly handoffEnvelope?: InvocationInputEnvelope | undefined;
  }
): Promise<TResult> {
  const { run, expectedRevision, frame, workflow, control, startedAt } = input;
  const boundQueueId = resolveBoundQueueId(run);
  const fence: ExecutionFence =
    hooks.resolveExecutionFence?.(run, boundQueueId) ?? {
      primacyClaim: `primacy:${run.connectedRunId}`,
      queueClaim: `queue:${boundQueueId}`,
      rootGeneration: 1
    };
  const decision = await prepareCandidateBlockDispatch({
    executor: hooks.executor,
    run,
    frame,
    workflow,
    control,
    fence,
    startedAt,
    handoffEnvelope: input.handoffEnvelope,
    resolveCandidateSpec: hooks.resolveCandidateSpec
  });
  if (decision.kind === 'stale-fence') return hooks.onStale(run, 'stale-fence');
  if (decision.kind === 'noop-active') return hooks.onPaused(decision.run, frame.invocationId, decision.status);
  if (decision.kind === 'paused') {
    return hooks.persistRunStep(decision.run, expectedRevision, (persisted) =>
      hooks.onPaused(persisted, frame.invocationId, decision.pauseCause)
    );
  }
  if (decision.kind === 'failed') {
    return hooks.failFrameAndPropagate(
      run, expectedRevision, decision.frame, startedAt, decision.failureCode, decision.detail
    );
  }
  const deliveryRes = await buildAttemptHandoffDelivery({
    coordinator: hooks.phaseHandoffCoordinator,
    run: decision.updatedRun,
    frame: decision.updatedFrame,
    nodeId: decision.node.nodeId,
    phase: decision.phase,
    pendingAttempt: decision.pendingAttempt
  });
  if (!deliveryRes.ok) {
    return hooks.failFrameAndPropagate(
      run, expectedRevision, frame, startedAt, deliveryRes.failureCode, deliveryRes.detail
    );
  }
  const preWritten = await hooks.connectedRuns.compareAndSetConnectedRun(decision.updatedRun, expectedRevision);
  if (preWritten.outcome === 'stale') return hooks.onStale(preWritten.current);

  const dispatched = await hooks.dispatchPhase({
    run: preWritten.run,
    frame: decision.updatedFrame,
    node: decision.node,
    phase: decision.phase,
    workflowId: workflow.workflowId,
    candidateId: decision.candidateId,
    boundInputs: decision.boundInputs,
    inputEnvelope: decision.inputEnvelope,
    nodePath: decision.pendingAttempt.nodePath,
    attemptId: decision.pendingAttempt.attemptId,
    attemptIndex: decision.pendingAttempt.attemptIndex,
    queueId: boundQueueId,
    startedAt,
    fence: decision.fence,
    ...(deliveryRes.delivery !== undefined ? { phaseHandoff: deliveryRes.delivery } : {})
  });
  if (dispatched.outcome === 'rejected') {
    if (dispatched.reason === 'rejected-foreign-lock') return hooks.onStale(preWritten.run, 'stale-fence');
    const failedAttempt: NodeAttemptRecord = Object.freeze({
      ...decision.pendingAttempt,
      status: 'failed',
      completedAt: startedAt,
      failureCode: dispatched.reason,
      ...(dispatched.detail !== undefined ? { failureMessage: dispatched.detail } : {})
    });
    return hooks.failFrameAndPropagate(
      preWritten.run, preWritten.run.revision,
      recordNodeAttempt(decision.updatedFrame, failedAttempt),
      startedAt, dispatched.reason, dispatched.detail
    );
  }
  const inFlightAttempt: NodeAttemptRecord = Object.freeze({
    ...decision.pendingAttempt,
    status: 'in-flight',
    queueItemId: dispatched.queueItemId
  });
  const boundRun = upsertInvocationFrame(
    preWritten.run,
    recordNodeAttempt(decision.updatedFrame, inFlightAttempt)
  );
  const written = await hooks.connectedRuns.compareAndSetConnectedRun(boundRun, preWritten.run.revision);
  if (written.outcome === 'written') {
    return hooks.onPhaseDispatched({
      run: written.run,
      invocationId: frame.invocationId,
      nodeId: decision.node.nodeId,
      attemptId: inFlightAttempt.attemptId,
      queueItemId: dispatched.queueItemId
    });
  }
  await hooks.cancelOrphanedQueueItem?.({ queueId: boundQueueId, taskId: dispatched.queueItemId });
  return hooks.onStale(written.current);
}

export interface CandidateSettleOrchestrationHooks<TResult> {
  readonly executor: CandidateBlockExecutor;
  readonly resolveExecutionFence?: ((run: ConnectedWorkflowRun, queueId: string) => ExecutionFence) | undefined;
  readonly resolveCandidateSpec?: CandidateSpecResolver | undefined;
  readonly onCompleted: (run: ConnectedWorkflowRun, outputs: Readonly<Record<string, ResolvedPortValue>>) => TResult;
  readonly onPaused: (run: ConnectedWorkflowRun, invocationId: string, pauseCause: string) => TResult;
  readonly persistRunStep: (
    nextRun: ConnectedWorkflowRun,
    expectedRevision: number,
    buildSuccess: (persisted: ConnectedWorkflowRun) => TResult,
    releaseTerminalPins?: boolean
  ) => Promise<TResult>;
  readonly cancelFrameAndPropagate: (
    run: ConnectedWorkflowRun,
    expectedRevision: number,
    frame: WorkflowInvocationFrame,
    completedAt: number
  ) => Promise<TResult>;
  readonly failFrameAndPropagate: (
    run: ConnectedWorkflowRun,
    expectedRevision: number,
    frame: WorkflowInvocationFrame,
    completedAt: number,
    failureCode: string,
    detail?: string
  ) => Promise<TResult>;
  readonly dispatchNext: (
    run: ConnectedWorkflowRun,
    expectedRevision: number,
    invocationId: string,
    entryNodeId: string,
    at: number
  ) => Promise<TResult>;
  readonly settleParent: (
    run: ConnectedWorkflowRun,
    expectedRevision: number,
    parentInvocationId: string,
    parentNodeId: string,
    parentAttemptIndex: number,
    completedAt: number,
    outputs: Readonly<Record<string, ResolvedPortValue>>,
    decisionResults?: Readonly<Record<string, DecisionFieldValue>>
  ) => Promise<TResult>;
  readonly markRootCompleted?: (run: ConnectedWorkflowRun, completedAt: number) => Promise<void>;
  readonly onStale: (run: ConnectedWorkflowRun, reason: 'stale-fence') => TResult;
}

export async function orchestrateCandidateBlockSettlement<TResult>(
  hooks: CandidateSettleOrchestrationHooks<TResult>,
  input: {
    readonly run: ConnectedWorkflowRun;
    readonly expectedRevision: number;
    readonly frame: WorkflowInvocationFrame;
    readonly workflow: WorkflowDefinition;
    readonly control: CandidateBlockControl;
    readonly nodeId: string;
    readonly settledAttempt: NodeAttemptRecord;
    readonly status: WorkflowNodeTerminalStatus;
    readonly completedAt: number;
    readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>> | undefined;
    readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
    readonly verdict?: 'pass' | 'fail' | null | undefined;
    readonly failureCode?: string | undefined;
    readonly extras?: CandidateSettlementExtras | undefined;
  }
): Promise<TResult> {
  const { run, expectedRevision, frame, workflow, control, nodeId, settledAttempt, completedAt } = input;
  const boundQueueId = resolveBoundQueueId(run);
  const fence: ExecutionFence =
    hooks.resolveExecutionFence?.(run, boundQueueId) ?? {
      primacyClaim: `primacy:${run.connectedRunId}`,
      queueClaim: `queue:${boundQueueId}`,
      rootGeneration: 1
    };
  const decision = await settleCandidateBlockStep({
    executor: hooks.executor,
    run,
    frame,
    workflow,
    control,
    nodeId,
    settledAttempt,
    status: input.status,
    completedAt,
    fence,
    declaredOutputs: input.declaredOutputs,
    decisionResults: input.decisionResults,
    verdict: input.verdict,
    failureCode: input.failureCode,
    extras: input.extras,
    resolveCandidateSpec: hooks.resolveCandidateSpec
  });
  if (decision.kind === 'stale-fence') {
    return hooks.onStale(run, 'stale-fence');
  }
  if (decision.kind === 'duplicate-noop') {
    return hooks.onCompleted(decision.run, frame.resolvedOutputs);
  }
  if (decision.kind === 'paused') {
    return hooks.persistRunStep(decision.nextRun, expectedRevision, (persisted) =>
      hooks.onPaused(persisted, frame.invocationId, decision.pauseCause)
    );
  }
  if (decision.kind === 'canceled') {
    return hooks.cancelFrameAndPropagate(decision.nextRun, expectedRevision, decision.frame, completedAt);
  }
  if (decision.kind === 'failed') {
    return hooks.failFrameAndPropagate(
      decision.nextRun, expectedRevision, decision.frame, completedAt, decision.failureCode, decision.detail
    );
  }
  if (decision.kind === 'retry-or-fallback') {
    return hooks.dispatchNext(decision.nextRun, expectedRevision, frame.invocationId, decision.entryNodeId, completedAt);
  }
  if (
    decision.completedFrame.parentInvocationId !== null &&
    decision.completedFrame.parentCallNodeId !== null
  ) {
    const parentFrame = decision.nextRun.invocations?.[decision.completedFrame.parentInvocationId];
    const parentAttempt = attemptsForNode(parentFrame, decision.completedFrame.parentCallNodeId).find(
      (a) => a.childInvocationId === decision.completedFrame.invocationId
    );
    if (parentFrame !== undefined && parentAttempt !== undefined) {
      return hooks.settleParent(
        decision.nextRun, expectedRevision, parentFrame.invocationId,
        parentAttempt.nodeId, parentAttempt.attemptIndex, completedAt,
        decision.outputs, input.decisionResults
      );
    }
  }
  const terminalState: { persistedRun: ConnectedWorkflowRun | null } = { persistedRun: null };
  const res = await hooks.persistRunStep(
    decision.nextRun,
    expectedRevision,
    (persisted) => {
      terminalState.persistedRun = persisted;
      return hooks.onCompleted(persisted, decision.outputs);
    },
    true
  );
  if (terminalState.persistedRun !== null) {
    await hooks.markRootCompleted?.(terminalState.persistedRun, completedAt);
  }
  return res;
}

