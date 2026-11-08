// FR-R5-F03 (T008, T009) — Authoritative control projections and bounded
// ancestry evidence for nested Workflow runs.
//
// Exposes legal control operations, waiting/pause/failure reasons, revision
// tokens, recovery dispositions, and full invocation ancestry without
// duplicating child Phase transcripts into parent frames.
//
// Zero `vscode` imports and zero I/O: shared by host and headless adapters.

import type {
  ConnectedInvocationAttemptProjection,
  ConnectedInvocationProjection,
  ConnectedRepeatCompletedPassProjection,
  ConnectedRepeatNodeProjection,
  ControlCandidateProjection,
  ControlLegalActionEntry,
  ControlProjection
} from '../../contracts/sidebar-ipc/workflow-run';
import type { RootControlState } from '../../contracts/control-ledger';
import {
  attemptsForNode,
  resolveBoundQueueId,
  resolveRootInvocationId,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type RecoveryDispositionRecord,
  type WorkflowControlOperation,
  type WorkflowDelayedRetryCause,
  type WorkflowInvocationFrame,
  type WorkflowInvocationStatus,
  type WorkflowPauseCause
} from '../../state/connected-workflow-run';
import { lookupRecord } from './control-ledger-store';
import {
  buildRepeatFrameKey,
  resolveFrozenRepeatControl
} from './repeat-executor';
import {
  computeAllowedControlActions,
  findLatestLeafPhaseAttempt
} from './workflow-control-transition-table';
import { projectCandidatePhaseIdentity } from '../../ui/sidebar/phase-projector';

export {
  buildControlProjection,
  type BuildControlProjectionInput
} from './control-command-service';

export const CANDIDATE_BLOCK_FRAME_STATES = Object.freeze([
  'selecting',
  'dispatch-pending',
  'executing',
  'retry-delayed',
  'waiting-availability',
  'intervention-required',
  'monitoring-expired',
  'completed',
  'failed',
  'canceled'
] as const);

export type CandidateBlockFrameState = (typeof CANDIDATE_BLOCK_FRAME_STATES)[number];

/**
 * FR-R5-F32 (F32-T01) — Deterministic projection fixture builder for every
 * candidate-block frame state, preserving absence when optional evidence is omitted.
 */
export function buildCandidateBlockStateFixture(
  state: CandidateBlockFrameState,
  overrides: Partial<ControlProjection> = {}
): ControlProjection {
  const isTerminal = state === 'completed' || state === 'failed' || state === 'canceled';
  const isPausedLike =
    state === 'intervention-required' || state === 'monitoring-expired';
  const defaultCandidates: readonly ControlCandidateProjection[] = Object.freeze([
    Object.freeze({
      candidateId: 'cand-primary',
      nodeId: 'node-cand-primary',
      backend: 'claude',
      priority: 1,
      authoredOrder: 0,
      attemptsUsed: state === 'selecting' ? 0 : 1,
      maxAttempts: 3,
      eligibility:
        state === 'intervention-required'
          ? ('intervention' as const)
          : ('eligible' as const),
      policyExcluded: false,
      phaseId: 'phase-implement-primary',
      phaseName: 'Primary Implementer',
      instructionSummary: 'Implement feature with primary instructions.',
      operatorKind: 'json-file'
    }),
    Object.freeze({
      candidateId: 'cand-fallback',
      nodeId: 'node-cand-fallback',
      backend: 'codex',
      priority: 2,
      authoredOrder: 1,
      attemptsUsed: 0,
      maxAttempts: 2,
      eligibility: 'eligible' as const,
      policyExcluded: false,
      phaseId: 'phase-implement-fallback',
      phaseName: 'Fallback Implementer',
      instructionSummary: 'Implement feature with fallback instructions.',
      operatorKind: 'json-file'
    })
  ]);

  return Object.freeze({
    version: 1,
    rootRunId: 'root-run-fixture-1',
    queueId: 'default',
    invocationId: '00000000-0000-4000-8000-000000000101',
    workflowId: 'wf-candidate-block',
    generation: 1,
    frameKind: 'candidate-block',
    state,
    availabilityPolicy: 'first-ready',
    selectedCandidateId: 'cand-primary',
    allowedCandidateIds: Object.freeze(['cand-primary', 'cand-fallback']),
    candidates: defaultCandidates,
    attemptsUsed: state === 'selecting' ? 0 : 1,
    maxDispatches: 40,
    rootDispatchesUsed: state === 'selecting' ? 0 : 1,
    rootMaxDispatches: 100,
    ...(state === 'completed' ? { resultStatus: 'done', resultReason: 'completed' } : {}),
    ...(state === 'failed' ? { resultStatus: 'failed', resultReason: 'all-candidates-exhausted' } : {}),
    spendMode: 'count-only',
    spendEnforcementQuality: 'count-only',
    legalActions: Object.freeze<readonly ControlLegalActionEntry[]>([
      { kind: 'check-now', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' },
      { kind: 'try-now', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' && state !== 'monitoring-expired' },
      { kind: 'select-candidate', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' },
      { kind: 'set-policy', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' },
      { kind: 'set-allowed-candidates', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' },
      { kind: 'renew-monitoring', allowed: !isTerminal && state !== 'executing' && state !== 'dispatch-pending' },
      { kind: 'pause', allowed: !isTerminal && !isPausedLike },
      { kind: 'resume', allowed: isPausedLike && state !== 'monitoring-expired', ...(state === 'monitoring-expired' ? { reason: 'monitoring-expired' as const } : {}) },
      { kind: 'cancel', allowed: !isTerminal }
    ]),
    evidenceRefs: Object.freeze([]),
    ...overrides
  });
}

export const MAX_EVIDENCE_SUMMARY_CHARS = 256;

/**
 * FR-R5-F03 (T008) — Bounded ancestry metadata attached to nested runtime
 * events, control receipts, and audit records.
 */
export interface AncestryEvidenceMetadata {
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly nodePath: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly queueId: string;
}

export interface InvocationControlProjection {
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly workflowId: string;
  readonly depth: number;
  readonly nodePath: string;
  readonly status: WorkflowInvocationStatus;
  readonly currentNodeId: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptIndex: number | null;
  readonly allowedActions: readonly WorkflowControlOperation[];
  readonly waitingReason: string | null;
  readonly pauseCause: WorkflowPauseCause | null;
  readonly pauseExplanation?: string | null;
  readonly pauseGuidance?: string | null;
  readonly failureReason: string | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: WorkflowDelayedRetryCause | null;
}

export interface WorkflowPauseCauseDescription {
  readonly explanation: string;
  readonly guidance: string;
}

/**
 * FR-R5-F08 — deterministic human-readable explanation and operator guidance
 * for each `WorkflowPauseCause`.
 */
export function describeWorkflowPauseCause(
  cause: WorkflowPauseCause | null | undefined
): WorkflowPauseCauseDescription | null {
  if (cause === null || cause === undefined) return null;
  switch (cause) {
    case 'recovery-uncertain-effect':
      return Object.freeze({
        explanation:
          'Paused during restart recovery because the active Phase attempt had no live queue task or verified settlement evidence.',
        guidance:
          'Inspect workspace outputs, then choose Resume (reconciles evidence before re-dispatching), Retry Phase, or Cancel.'
      });
    case 'credit-exhausted':
      return Object.freeze({
        explanation: 'Paused because backend provider credit or quota was exhausted during execution.',
        guidance: 'Restore provider credit or wait for quota reset, then choose Resume or Cancel.'
      });
    case 'spend-bound-exceeded':
      return Object.freeze({
        explanation: 'Paused because cumulative invocation spend reached the configured spend bound.',
        guidance: 'Review invocation spend and outputs, then choose Resume or Cancel.'
      });
    case 'operator-pause':
      return Object.freeze({
        explanation: 'Paused by operator request.',
        guidance: 'Choose Resume to continue or Cancel to stop this workflow.'
      });
  }
}

export interface WorkflowRunControlProjection {
  readonly runId: string;
  readonly queueId: string;
  readonly revision: number;
  readonly status: WorkflowInvocationStatus;
  readonly activeInvocationId: string;
  readonly rootInvocationId: string;
  readonly rootAllowedActions: readonly WorkflowControlOperation[];
  readonly invocations: Readonly<Record<string, InvocationControlProjection>>;
  readonly recoveryDisposition: RecoveryDispositionRecord | null;
}

function findLatestAttemptForFrame(
  frame: WorkflowInvocationFrame
): NodeAttemptRecord | undefined {
  if (frame.activeNodeId !== null) {
    const activeList = attemptsForNode(frame, frame.activeNodeId);
    const lastActive = activeList[activeList.length - 1];
    if (lastActive !== undefined) {
      return lastActive;
    }
  }
  const leafPhase = findLatestLeafPhaseAttempt(frame);
  if (leafPhase !== undefined) {
    return leafPhase;
  }
  let latest: NodeAttemptRecord | undefined;
  for (const list of Object.values(frame.attemptsByNodeId)) {
    const candidate = list[list.length - 1];
    if (candidate === undefined) continue;
    if (latest === undefined || candidate.startedAt >= latest.startedAt) {
      latest = candidate;
    }
  }
  return latest;
}

function deriveWaitingReason(frame: WorkflowInvocationFrame): string | null {
  if (frame.status === 'waiting-for-handoff') {
    if (frame.pendingHandoff?.acceptedEnvelope !== undefined) {
      return 'handoff-accepted-pending-dispatch';
    }
    return 'manual-handoff-approval';
  }
  if (frame.controlMarkers?.pendingRetryCause !== null && frame.controlMarkers?.pendingRetryCause !== undefined) {
    return frame.controlMarkers.pendingRetryCause;
  }
  if (frame.status === 'paused') {
    return frame.controlMarkers?.manualPauseCause ?? 'operator-pause';
  }
  return null;
}

function resolveDeepestActiveInvocationId(
  run: ConnectedWorkflowRun,
  rootInvocationId: string
): string {
  const invocations = run.invocations ?? {};
  let candidate: WorkflowInvocationFrame | undefined = invocations[rootInvocationId];
  for (const frame of Object.values(invocations)) {
    if (
      frame.status === 'in-flight' ||
      frame.status === 'waiting-for-handoff' ||
      frame.status === 'paused'
    ) {
      if (candidate === undefined || frame.depth >= candidate.depth) {
        candidate = frame;
      }
    }
  }
  return candidate?.invocationId ?? rootInvocationId;
}

/**
 * Build the authoritative control projection for a single `WorkflowInvocationFrame`.
 */
export function buildInvocationControlProjection(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): InvocationControlProjection {
  const latestAttempt = findLatestAttemptForFrame(frame);
  const allowedActions = computeAllowedControlActions(run, frame.invocationId);
  const pauseCause = frame.controlMarkers?.manualPauseCause ?? null;
  const pauseDescription = describeWorkflowPauseCause(pauseCause);
  const pendingRetryAt = frame.controlMarkers?.pendingRetryAt ?? null;
  const pendingRetryCause = frame.controlMarkers?.pendingRetryCause ?? null;
  const failureReason =
    frame.status === 'failed'
      ? frame.failureCode ?? latestAttempt?.failureCode ?? 'unhandled-node-failure'
      : null;

  return Object.freeze({
    invocationId: frame.invocationId,
    parentInvocationId: frame.parentInvocationId,
    workflowId: frame.workflowId,
    depth: frame.depth,
    nodePath: frame.nodePath,
    status: frame.status,
    currentNodeId: frame.activeNodeId ?? latestAttempt?.nodeId ?? null,
    activeAttemptId: latestAttempt?.attemptId ?? null,
    activeAttemptIndex: latestAttempt?.attemptIndex ?? null,
    allowedActions,
    waitingReason: deriveWaitingReason(frame),
    pauseCause,
    pauseExplanation: pauseDescription?.explanation ?? null,
    pauseGuidance: pauseDescription?.guidance ?? null,
    failureReason,
    pendingRetryAt,
    pendingRetryCause
  });
}

/**
 * Build the authoritative control projection for an entire `ConnectedWorkflowRun`.
 */
export function buildWorkflowRunControlProjection(
  run: ConnectedWorkflowRun
): WorkflowRunControlProjection {
  const rootInvocationId = resolveRootInvocationId(run);
  const invocationsMap = run.invocations ?? {};
  const projections: Record<string, InvocationControlProjection> = {};

  for (const [invId, frame] of Object.entries(invocationsMap)) {
    projections[invId] = buildInvocationControlProjection(run, frame);
  }

  const rootFrame = invocationsMap[rootInvocationId];
  const rootStatus: WorkflowInvocationStatus = rootFrame?.status ?? 'in-flight';
  const rootAllowedActions =
    projections[rootInvocationId]?.allowedActions ?? Object.freeze([]);
  const activeInvocationId = resolveDeepestActiveInvocationId(run, rootInvocationId);

  return Object.freeze({
    runId: run.connectedRunId,
    queueId: resolveBoundQueueId(run),
    revision: run.revision,
    status: rootStatus,
    activeInvocationId,
    rootInvocationId,
    rootAllowedActions,
    invocations: Object.freeze(projections),
    recoveryDisposition: run.recoveryDisposition ?? null
  });
}

/**
 * Construct bounded `AncestryEvidenceMetadata` for a specific invocation and
 * optional node/attempt within `run` (`FR-R5-F03-T08`).
 *
 * Never copies child Phase transcripts into parent records.
 */
export function buildAncestryEvidenceMetadata(
  run: ConnectedWorkflowRun,
  invocationId: string,
  nodeId?: string | undefined
): AncestryEvidenceMetadata | undefined {
  const frame = run.invocations?.[invocationId];
  if (frame === undefined) {
    return undefined;
  }
  const targetNodeId = nodeId ?? frame.activeNodeId ?? frame.entryNodeId;
  const attempts = attemptsForNode(frame, targetNodeId);
  const latestAttempt = attempts[attempts.length - 1];
  const attemptIndex = latestAttempt?.attemptIndex ?? 1;
  const attemptId =
    latestAttempt?.attemptId ?? `${frame.invocationId}:${targetNodeId}:attempt-${attemptIndex}`;

  return Object.freeze({
    rootRunId: frame.rootRunId,
    invocationId: frame.invocationId,
    parentInvocationId: frame.parentInvocationId,
    nodePath: latestAttempt?.nodePath ?? frame.nodePath,
    attemptId,
    attemptIndex,
    queueId: resolveBoundQueueId(run)
  });
}

/**
 * FR-R5-F06 — Project hierarchical `ConnectedInvocationProjection` rows for
 * the sidebar/webview wire contract from `run.invocations` and `run.frozenClosure`.
 */
export function projectConnectedInvocations(
  run: ConnectedWorkflowRun,
  _control: WorkflowRunControlProjection = buildWorkflowRunControlProjection(run),
  controlProjectionsByInvocationId?: Readonly<Record<string, ControlProjection>>
): readonly ConnectedInvocationProjection[] | undefined {
  const frames = run.invocations;
  if (frames === undefined || Object.keys(frames).length === 0) return undefined;
  const orderedFrames: WorkflowInvocationFrame[] = Object.values(frames).sort((a, b) =>
    a.depth !== b.depth ? a.depth - b.depth : a.startedAt - b.startedAt
  );
  return Object.freeze(
    orderedFrames.map((frame): ConnectedInvocationProjection => {
      const ctrl = buildInvocationControlProjection(run, frame);
      const wfDef = run.frozenClosure?.workflowsById[frame.workflowId];
      const versionRef = run.frozenClosure?.catalogVersionsById?.[frame.workflowId];
      const attempts: ConnectedInvocationAttemptProjection[] = Object.values(frame.attemptsByNodeId)
        .flatMap((list) => list)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((att) =>
          Object.freeze({
            attemptId: att.attemptId,
            attemptIndex: att.attemptIndex,
            nodeId: att.nodeId,
            nodeKind: att.nodeKind,
            status: att.status,
            startedAt: att.startedAt,
            ...(att.completedAt !== undefined ? { endedAt: att.completedAt } : {}),
            ...(att.queueItemId !== undefined ? { queueItemId: att.queueItemId } : {}),
            ...(att.childInvocationId !== undefined ? { childInvocationId: att.childInvocationId } : {}),
            ...(att.failureCode !== undefined ? { failureCode: att.failureCode } : {})
          })
        );
      const rawHandoff =
        frame.pendingHandoff ??
        (run.pendingHandoff?.invocationId === frame.invocationId ? run.pendingHandoff : null);
      const pendingHandoff =
        rawHandoff !== null
          ? Object.freeze({
              fromNodeId: rawHandoff.fromNodeId,
              toNodeId: rawHandoff.target.kind === 'node' ? rawHandoff.target.nodeId : null,
              connectionId: String(rawHandoff.connectionIndex),
              boundInputPortIds: Object.freeze(Object.keys(rawHandoff.prefilledInputsByPort))
            })
          : null;
      const suppliedControlProjection = controlProjectionsByInvocationId?.[frame.invocationId];
      let controlProjection: ControlProjection | undefined = suppliedControlProjection;
      if (controlProjection !== undefined && wfDef !== undefined && controlProjection.candidates !== undefined) {
        const enrichedCandidates = controlProjection.candidates.map((cand) => {
          const nodeDef = wfDef.nodes.find((n) => n.nodeId === cand.nodeId);
          const phaseDef =
            nodeDef?.phaseId !== undefined
              ? run.frozenClosure?.phasesById[nodeDef.phaseId]
              : undefined;
          const phaseIdentity = projectCandidatePhaseIdentity(phaseDef);
          if (!phaseIdentity) return cand;
          return Object.freeze({
            ...cand,
            phaseId: cand.phaseId ?? phaseIdentity.phaseId,
            phaseName: cand.phaseName ?? phaseIdentity.phaseName,
            ...(cand.instructionSummary === undefined && phaseIdentity.instructionSummary !== undefined
              ? { instructionSummary: phaseIdentity.instructionSummary }
              : {}),
            ...(cand.operatorKind === undefined && phaseIdentity.operatorKind !== undefined
              ? { operatorKind: phaseIdentity.operatorKind }
              : {})
          });
        });
        controlProjection = Object.freeze({
          ...controlProjection,
          candidates: Object.freeze(enrichedCandidates)
        });
      }
      return Object.freeze({
        invocationId: frame.invocationId,
        parentInvocationId: frame.parentInvocationId,
        workflowId: frame.workflowId,
        ...(wfDef !== undefined ? { workflowName: wfDef.name } : {}),
        ...(versionRef !== undefined ? { frozenVersionId: versionRef.versionId } : {}),
        depth: frame.depth,
        nodePath: frame.nodePath,
        status: ctrl.status,
        currentNodeId: ctrl.currentNodeId,
        activeAttemptId: ctrl.activeAttemptId,
        activeAttemptIndex: ctrl.activeAttemptIndex,
        allowedActions: ctrl.allowedActions,
        waitingReason: ctrl.waitingReason,
        pauseCause: ctrl.pauseCause,
        pauseExplanation: ctrl.pauseExplanation ?? null,
        pauseGuidance: ctrl.pauseGuidance ?? null,
        failureReason: ctrl.failureReason,
        pendingRetryAt: ctrl.pendingRetryAt,
        pendingRetryCause: ctrl.pendingRetryCause,
        ...(pendingHandoff !== null ? { pendingHandoff } : {}),
        outputPortIds: Object.freeze(Object.keys(frame.resolvedOutputs)),
        attempts: Object.freeze(attempts),
        ...(controlProjection !== undefined ? { controlProjection } : {})
      });
    })
  );
}

/**
 * FR-R5-F33 (F33-T02, F33-T07) — Build authoritative `ConnectedRepeatNodeProjection`
 * for a `node.control.kind === 'repeat'` workflow node, distinguishing Repeat pass count
 * (`iteration` / `maxIterations`) from nested leaf Phase attempt count (`leafAttemptCount`)
 * and exposing condition outcome, carry ref, exhaustion reason, and legal actions.
 */
export function buildRepeatNodeProjection(
  run: ConnectedWorkflowRun,
  nodeId: string,
  ledgerRoot?: RootControlState
): ConnectedRepeatNodeProjection | undefined {
  const rootId = resolveRootInvocationId(run);
  const parentFrame =
    lookupRecord(run.invocations ?? {}, rootId) ?? Object.values(run.invocations ?? {}).at(0);
  const parentWf =
    parentFrame !== undefined && run.frozenClosure !== undefined
      ? lookupRecord(run.frozenClosure.workflowsById, parentFrame.workflowId) ?? run.graph
      : run.graph;
  const node = parentWf.nodes.find((n) => n.nodeId === nodeId);
  if (node?.control?.kind !== 'repeat') return undefined;

  const resolvedCtrl = resolveFrozenRepeatControl(run, parentWf, node);
  const maxIterations = resolvedCtrl.ok
    ? resolvedCtrl.control.maxIterations
    : node.control.maxIterations;
  const onExhausted = resolvedCtrl.ok
    ? resolvedCtrl.control.onExhausted
    : (node.control.onExhausted ?? 'pause');

  const parentInvId = parentFrame !== undefined ? parentFrame.invocationId : rootId;
  const frameKey = buildRepeatFrameKey(parentInvId, nodeId);
  const ledgerFrame =
    ledgerRoot !== undefined ? lookupRecord(ledgerRoot.framesByKey, frameKey) : undefined;
  const ledgerRepeat = ledgerFrame?.repeatState;

  const parentAttempts =
    parentFrame !== undefined ? attemptsForNode(parentFrame, nodeId) : [];
  const latestParentAttempt = parentAttempts.at(-1);

  const childFrames = Object.values(run.invocations ?? {}).filter(
    (f) => f.parentInvocationId === parentInvId && f.parentCallNodeId === nodeId
  );

  // Count nested leaf Phase attempts across all child Workflow invocations spawned by this Repeat node
  const childIds = new Set(childFrames.map((f) => f.invocationId));
  let leafAttemptCount = 0;
  for (const frame of Object.values(run.invocations ?? {})) {
    if (!childIds.has(frame.invocationId) && !childIds.has(frame.parentInvocationId ?? '')) {
      continue;
    }
    for (const attList of Object.values(frame.attemptsByNodeId)) {
      for (const att of attList) {
        if (att.nodeKind === 'phase') {
          leafAttemptCount += 1;
        }
      }
    }
  }

  const completedPasses: ConnectedRepeatCompletedPassProjection[] =
    ledgerRepeat?.completedPasses !== undefined && ledgerRepeat.completedPasses.length > 0
      ? ledgerRepeat.completedPasses.map((p) =>
          Object.freeze({
            iteration: p.iteration,
            invocationId: p.invocationId,
            status: p.status,
            ...(p.resultRef !== undefined ? { resultRef: p.resultRef } : {})
          })
        )
      : parentAttempts
          .filter(
            (a) =>
              a.status === 'completed' ||
              a.status === 'failed' ||
              a.status === 'canceled' ||
              (a.status === 'paused' && a.failureCode === 'repeat-exhausted')
          )
          .map((a) =>
            Object.freeze({
              iteration: a.attemptIndex,
              invocationId: a.childInvocationId ?? a.attemptId,
              status:
                a.status === 'paused' && a.failureCode === 'repeat-exhausted'
                  ? ('completed' as const)
                  : a.status === 'completed' || a.status === 'failed' || a.status === 'canceled'
                    ? a.status
                    : ('completed' as const)
            })
          );

  const iteration =
    ledgerRepeat?.iteration ??
    ledgerRepeat?.currentPass ??
    (parentAttempts.length > 0 ? parentAttempts.length : 1);

  const activeChild = childFrames.find((f) => f.status === 'in-flight' || f.status === 'paused');
  const currentChildInvocationId =
    ledgerRepeat?.currentChildInvocationId !== undefined
      ? ledgerRepeat.currentChildInvocationId
      : (activeChild?.invocationId ?? null);

  const parentFailureCode = parentFrame !== undefined ? parentFrame.failureCode : undefined;
  const parentStatus = parentFrame !== undefined ? parentFrame.status : undefined;
  const isExhausted =
    ledgerRepeat?.exhaustionReason === 'repeat-exhausted' ||
    parentFailureCode === 'repeat-exhausted' ||
    latestParentAttempt?.failureCode === 'repeat-exhausted';
  const isUnresolved =
    ledgerRepeat?.conditionResult === 'unresolved' ||
    parentFailureCode === 'unresolved-condition';

  const conditionResult =
    ledgerRepeat?.conditionResult ??
    (isUnresolved
      ? 'unresolved'
      : isExhausted
        ? 'false'
        : latestParentAttempt?.status === 'completed' &&
            Object.keys(latestParentAttempt.declaredOutputs).length > 0
          ? 'true'
          : parentAttempts.length > 1 && activeChild !== undefined
            ? 'false'
            : 'not-evaluated');

  const exhaustionReason =
    ledgerRepeat?.exhaustionReason ??
    (isExhausted ? 'repeat-exhausted' : isUnresolved ? 'unresolved-condition' : undefined);

  const latestCarryEnv = [...(run.inputEnvelopes ?? [])]
    .reverse()
    .find((env) => env.targetNodeId === nodeId && env.envelopeId.includes(':carry-env'));
  const carryEnvelopeRef = ledgerRepeat?.carryEnvelopeRef ?? latestCarryEnv?.envelopeId;
  const fallbackCarryValues: Record<string, string | number | boolean> | undefined =
    latestCarryEnv !== undefined
      ? Object.fromEntries(
          Object.entries(latestCarryEnv.inputsByPort).map(([portId, portVal]) => [portId, portVal.value])
        )
      : undefined;
  const carryValues = ledgerRepeat?.carryValues ?? fallbackCarryValues;

  const isTerminal =
    parentStatus === 'completed' ||
    parentStatus === 'failed' ||
    parentStatus === 'canceled' ||
    ledgerFrame?.status === 'completed' ||
    ledgerFrame?.status === 'failed' ||
    ledgerFrame?.status === 'canceled';
  const isPaused = parentStatus === 'paused' || ledgerFrame?.status === 'paused';

  const legalActions: readonly ControlLegalActionEntry[] = Object.freeze([
    { kind: 'pause', allowed: !isTerminal && !isPaused },
    {
      kind: 'resume',
      allowed: isPaused && !isExhausted && !isTerminal,
      ...(isExhausted ? { reason: 'illegal-state' as const } : {})
    },
    { kind: 'cancel', allowed: !isTerminal }
  ]);

  return Object.freeze({
    version: 1 as const,
    kind: 'repeat' as const,
    iteration,
    currentPass: iteration,
    maxIterations,
    conditionResult,
    currentChildInvocationId,
    onExhausted,
    ...(exhaustionReason !== undefined ? { exhaustionReason } : {}),
    ...(carryEnvelopeRef !== undefined ? { carryEnvelopeRef } : {}),
    ...(carryValues !== undefined ? { carryValues } : {}),
    leafAttemptCount,
    completedPasses: Object.freeze(completedPasses),
    legalActions
  });
}
