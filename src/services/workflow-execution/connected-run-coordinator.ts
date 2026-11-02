// Feature 088 (T026) — what happens when a child Pipeline Run stops.
//
// One event, one reaction: the node's outgoing connections are evaluated and the
// resulting `RoutingDecision` is appended to the connected run (FR-020, FR-030).
// Nothing is started. The selector offers, the operator chooses, and the gap
// between the two is the whole point of a *manual* continuation (FR-032, FR-040).
//
// The failure requirements need no code here, and that is the interesting part:
//
//   * FR-050 — a failed or canceled child cannot alter a completed node's
//     recorded outputs, because the aggregate holds no outputs to alter. Outputs
//     live on the child runs, which this path reads and never writes.
//   * FR-051 — the connected run has no status field to mark failed. A child
//     failure appends a decision like any other terminal outcome and leaves the
//     run readable, with whatever action set its decisions imply.
//   * FR-052 — a terminal status is routable because `failed` and `canceled` are
//     members of the same closed status set `completed` is, and the evaluator
//     compares them field-wise without caring which. There is no success branch
//     in this module.
//
// No `vscode` import and no I/O of its own: child facts and the write path
// arrive as ports.

import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeTerminalStatus
} from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  ConnectedNodeRecord,
  InvocationInputEnvelope,
  NodeAttemptRecord,
  PendingHandoffRecord,
  RoutingDecision,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import {
  appendDecision,
  clearInvocationControlMarkers,
  recordNodeAttempt,
  resolveBoundQueueId,
  setPendingHandoff,
  upsertInvocationFrame
} from '../../state/connected-workflow-run';
import type { SanitizedLogger } from '../../lib/logger';
import type { ConnectedRunWriter } from './workflow-launcher';
import {
  resolveNodeInputBindings,
  resolveWorkflowPublicOutputs
} from './binding-resolver';
import type { NodeAttemptFacts } from './condition-context';
import {
  buildConditionContext,
  buildInvocationConditionContext
} from './condition-context';
import {
  createChildWorkflowInvocationFrame,
  createNodeAttemptRecord
} from './connected-run-factory';
import { selectNextNodes, selectNextTransition } from './next-node-selector';

/** What one finished child run contributes. Read from the child, never stored here. */
export interface ChildRunFacts {
  readonly status: WorkflowNodeTerminalStatus;
  /** As the child recorded them: location references, never file contents. */
  readonly outputs: readonly RunOutputRecord[];
}

/**
 * Read one child run's terminal facts, or `null` if it has not reached a terminal
 * state (or is no longer resolvable).
 *
 * Both non-answers collapse to `null` on purpose: a node whose facts cannot be
 * read contributes nothing to the context, and an operand naming it resolves as
 * unresolved, which every operator turns into `false` (FR-024). A branch is not
 * taken on a fact nobody has.
 */
export type ChildRunFactsReader = (queueItemId: string) => ChildRunFacts | null;

export interface ConnectedRunCoordinatorDeps {
  readonly connectedRuns: ConnectedRunWriter;
  readonly readChildFacts: ChildRunFactsReader;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

export interface ChildTerminalInput {
  readonly run: ConnectedWorkflowRun;
  readonly nodeId: string;
  /** Which attempt of that node finished; the decision is recorded against it. */
  readonly attemptIndex: number;
  readonly decidedAt: number;
}

export type ChildTerminalResult =
  | { readonly outcome: 'recorded'; readonly run: ConnectedWorkflowRun; readonly decision: RoutingDecision }
  | { readonly outcome: 'ignored'; readonly reason: 'unknown-attempt' | 'not-terminal' }
  | { readonly outcome: 'rejected-stale'; readonly current: ConnectedWorkflowRun | null };

/** The attempt a decision is being recorded against, if the record holds one. */
function attemptOf(record: ConnectedNodeRecord | undefined, index: number): string | undefined {
  return record?.attempts[index]?.queueItemId;
}

/**
 * The facts every node contributes to this evaluation.
 *
 * The node being routed contributes the attempt that just finished; every other
 * node contributes its **latest** terminal attempt, walking backwards so a
 * re-started node routes on what it most recently produced rather than on what it
 * produced the first time. A node with no terminal attempt contributes nothing,
 * and `buildConditionContext()` refuses a second entry for any node — so values
 * cannot mix across attempts (FR-037) by construction rather than by care.
 */
function collectFacts(
  run: ConnectedWorkflowRun,
  routedNodeId: string,
  routedAttemptIndex: number,
  readChildFacts: ChildRunFactsReader
): readonly NodeAttemptFacts[] {
  const facts: NodeAttemptFacts[] = [];
  for (const record of Object.values(run.nodes)) {
    const attempts =
      record.nodeId === routedNodeId
        ? record.attempts.slice(routedAttemptIndex, routedAttemptIndex + 1)
        : [...record.attempts].reverse();
    for (const attempt of attempts) {
      const child = readChildFacts(attempt.queueItemId);
      if (child === null) continue;
      facts.push({ nodeId: record.nodeId, status: child.status, outputs: child.outputs });
      break;
    }
  }
  return facts;
}

/**
 * Evaluate and record one node's outgoing connections (FR-020, FR-030).
 *
 * Idempotent against a replayed event only in the sense that matters: a second
 * call for the same attempt appends a second decision computed from the same
 * facts, and the projection reads the most recent one. Decisions are append-only
 * (FR-030), so nothing is rewritten and the trail stays a record of what was
 * evaluated and when — which is what makes "why was this branch not offered"
 * answerable at all.
 */
export async function recordChildTerminal(
  deps: ConnectedRunCoordinatorDeps,
  input: ChildTerminalInput
): Promise<ChildTerminalResult> {
  const run = input.run;
  const queueItemId = attemptOf(run.nodes[input.nodeId], input.attemptIndex);
  if (queueItemId === undefined) {
    // The event names an attempt this run never recorded — an orphan child from a
    // crash between the enqueue and the append (contract, *Partial writes*). It
    // ran as a normal Pipeline Run and is visible in the queue; there is nothing
    // to route from, and inventing an attempt reference would make the trail
    // claim a start the run never made.
    return { outcome: 'ignored', reason: 'unknown-attempt' };
  }
  if (deps.readChildFacts(queueItemId) === null) {
    // Called for a child that has not actually finished. Refused rather than
    // routed on an absent status, which would evaluate every condition to false
    // and record a decision that says the branches were considered.
    return { outcome: 'ignored', reason: 'not-terminal' };
  }

  const decision = selectNextNodes({
    graph: run.graph,
    nodeId: input.nodeId,
    attemptIndex: input.attemptIndex,
    decidedAt: input.decidedAt,
    context: buildConditionContext(
      collectFacts(run, input.nodeId, input.attemptIndex, deps.readChildFacts)
    )
  });

  const next = appendDecision(run, decision);
  const written = await deps.connectedRuns.compareAndSetConnectedRun(next, run.revision);
  if (written.outcome === 'stale') {
    // Someone wrote between the read and here. The caller re-reads and calls
    // again rather than this module looping: a retry here would race the same way
    // and would hide a caller that is holding a stale run across an await.
    deps.logger.warn(
      'connected-run-coordinator: routing decision superseded by a concurrent write; not recorded'
    );
    return { outcome: 'rejected-stale', current: written.current };
  }
  return { outcome: 'recorded', run: written.run, decision };
}

// ---------------------------------------------------------------------------
// FR-R5-F02 (T021) — Composable Workflow call/return & node dispatch
// ---------------------------------------------------------------------------

export interface PhaseAttemptDispatchInput {
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly node: WorkflowNode;
  readonly phase: PhaseDefinition;
  readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly queueId: string;
  readonly startedAt: number;
}

export type PhaseAttemptDispatchResult =
  | { readonly outcome: 'dispatched'; readonly queueItemId: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ComposableWorkflowCoordinatorDeps {
  readonly connectedRuns: ConnectedRunWriter;
  readonly dispatchPhase: (
    input: PhaseAttemptDispatchInput
  ) => Promise<PhaseAttemptDispatchResult>;
}

export type ComposableWorkflowStepResult =
  | {
      readonly outcome: 'phase-dispatched';
      readonly run: ConnectedWorkflowRun;
      readonly invocationId: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly queueItemId: string;
    }
  | {
      readonly outcome: 'waiting-for-handoff';
      readonly run: ConnectedWorkflowRun;
      readonly invocationId: string;
      readonly fromNodeId: string;
      readonly toNodeId: string;
    }
  | {
      readonly outcome: 'workflow-completed';
      readonly run: ConnectedWorkflowRun;
      readonly outputs: Readonly<Record<string, ResolvedPortValue>>;
    }
  | {
      readonly outcome: 'workflow-failed';
      readonly run: ConnectedWorkflowRun;
      readonly invocationId: string;
      readonly failureCode: string;
      readonly detail?: string;
    }
  | {
      readonly outcome: 'workflow-canceled';
      readonly run: ConnectedWorkflowRun;
      readonly invocationId: string;
    }
  | {
      readonly outcome: 'rejected-stale';
      readonly current: ConnectedWorkflowRun | null;
    };

function latestInputEnvelopeForTarget(
  run: ConnectedWorkflowRun,
  invocationId: string,
  targetNodeId: string
): InvocationInputEnvelope | undefined {
  const envelopes = run.inputEnvelopes;
  if (envelopes === undefined || envelopes.length === 0) return undefined;
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const env = envelopes[i];
    if (
      env !== undefined &&
      env.invocationId === invocationId &&
      env.targetNodeId === targetNodeId
    ) {
      return env;
    }
  }
  return undefined;
}

async function persistRunStep(
  writer: ConnectedRunWriter,
  next: ConnectedWorkflowRun,
  expectedRevision: number,
  buildResult: (persisted: ConnectedWorkflowRun) => ComposableWorkflowStepResult
): Promise<ComposableWorkflowStepResult> {
  const written = await writer.compareAndSetConnectedRun(next, expectedRevision);
  if (written.outcome === 'stale') {
    return { outcome: 'rejected-stale', current: written.current };
  }
  return buildResult(written.run);
}

/**
 * Dispatch a target node (`phase` or nested `workflow`) inside an active
 * `WorkflowInvocationFrame` (FR-008, FR-009, FR-011, FR-012, FR-017).
 *
 * When the target node is a `workflow` node, this pushes a child
 * `WorkflowInvocationFrame` and enters `childWorkflow.startNodeIds[0]`
 * within the root run's bound `queueId` without acquiring a second slot.
 */
export async function dispatchComposableNode(
  deps: ComposableWorkflowCoordinatorDeps,
  input: {
    readonly run: ConnectedWorkflowRun;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly startedAt: number;
  }
): Promise<ComposableWorkflowStepResult> {
  return dispatchNodeInternal(
    deps,
    input.run,
    input.run.revision,
    input.invocationId,
    input.nodeId,
    input.startedAt
  );
}

async function dispatchNodeInternal(
  deps: ComposableWorkflowCoordinatorDeps,
  run: ConnectedWorkflowRun,
  expectedRevision: number,
  invocationId: string,
  nodeId: string,
  startedAt: number
): Promise<ComposableWorkflowStepResult> {
  const closure = run.frozenClosure;
  const frame = run.invocations?.[invocationId];
  if (closure === undefined || frame === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'workflow-closure-invalid',
      detail: `Missing frozen closure or invocation frame '${invocationId}'.`
    };
  }
  const workflow: WorkflowDefinition | undefined = closure.workflowsById[frame.workflowId];
  const node = workflow?.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (workflow === undefined || node === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'invalid-entry-node',
      detail: `Node '${nodeId}' not found in frozen workflow '${frame.workflowId}'.`
    };
  }

  const nodeKind = node.kind ?? (node.phaseId !== undefined ? 'phase' : 'workflow');
  const handoffEnvelope = latestInputEnvelopeForTarget(run, invocationId, nodeId);

  const targetPorts =
    nodeKind === 'phase'
      ? undefined
      : closure.workflowsById[node.workflowId ?? '']?.inputs;

  const resolved = resolveNodeInputBindings({
    workflow,
    frame,
    targetNodeId: nodeId,
    ...(targetPorts !== undefined ? { targetInputPorts: targetPorts } : {}),
    ...(handoffEnvelope !== undefined
      ? { overrideInputsByPort: handoffEnvelope.inputsByPort }
      : {})
  });
  if (!resolved.ok) {
    const failedRun = upsertInvocationFrame(run, {
      ...frame,
      status: 'failed',
      completedAt: startedAt,
      failureCode: resolved.code,
      failureMessage: resolved.message
    });
    return persistRunStep(deps.connectedRuns, failedRun, expectedRevision, (persisted) => ({
      outcome: 'workflow-failed',
      run: persisted,
      invocationId,
      failureCode: resolved.code,
      detail: resolved.message
    }));
  }

  const boundInputs = resolved.resolvedByPort;
  const existingAttempts = frame.attemptsByNodeId[nodeId] ?? [];
  const nextAttemptIndex = existingAttempts.length + 1;
  const inputEnvelope: InvocationInputEnvelope =
    handoffEnvelope ??
    Object.freeze({
      envelopeId: `${invocationId}:${nodeId}:attempt-${nextAttemptIndex}:env`,
      invocationId,
      targetNodeId: nodeId,
      source: 'binding',
      inputsByPort: boundInputs,
      localInputs: Object.freeze([]),
      outputTargetOverrides: Object.freeze([]),
      acceptedAt: startedAt
    });

  if (nodeKind === 'phase') {
    const phaseId = node.phaseId ?? '';
    const phase = closure.phasesById[phaseId];
    if (phase === undefined) {
      return {
        outcome: 'workflow-failed',
        run,
        invocationId,
        failureCode: 'workflow-closure-invalid',
        detail: `Phase '${phaseId}' missing from frozen closure.`
      };
    }

    const previewAttempt = createNodeAttemptRecord({
      frame,
      nodeId,
      nodeKind: 'phase',
      targetDefinitionId: phaseId,
      inputEnvelope,
      startedAt
    });

    const dispatched = await deps.dispatchPhase({
      run,
      frame,
      node,
      phase,
      boundInputs,
      attemptId: previewAttempt.attemptId,
      attemptIndex: previewAttempt.attemptIndex,
      queueId: resolveBoundQueueId(run),
      startedAt
    });
    if (dispatched.outcome === 'rejected') {
      const failedRun = upsertInvocationFrame(run, {
        ...frame,
        status: 'failed',
        completedAt: startedAt,
        failureCode: dispatched.reason
      });
      return persistRunStep(deps.connectedRuns, failedRun, expectedRevision, (persisted) => ({
        outcome: 'workflow-failed',
        run: persisted,
        invocationId,
        failureCode: dispatched.reason
      }));
    }

    const attempt = createNodeAttemptRecord({
      frame,
      nodeId,
      nodeKind: 'phase',
      targetDefinitionId: phaseId,
      inputEnvelope,
      startedAt,
      queueItemId: dispatched.queueItemId
    });
    const updatedFrame = recordNodeAttempt(frame, attempt);
    const nextRun = upsertInvocationFrame(run, updatedFrame);
    return persistRunStep(deps.connectedRuns, nextRun, expectedRevision, (persisted) => ({
      outcome: 'phase-dispatched',
      run: persisted,
      invocationId,
      nodeId,
      attemptId: attempt.attemptId,
      queueItemId: dispatched.queueItemId
    }));
  }

  // Child workflow node call (`nodeKind === 'workflow'`):
  // Always enters child workflow at `startNodeIds[0]` (FR-002).
  const childWorkflowId = node.workflowId ?? '';
  const childWorkflow = closure.workflowsById[childWorkflowId];
  const childEntryNodeId = childWorkflow?.startNodeIds[0];
  if (childWorkflow === undefined || childEntryNodeId === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'invalid-entry-node',
      detail: `Child workflow '${childWorkflowId}' has no valid entry node.`
    };
  }

  const parentAttemptId = `${invocationId}:${nodeId}:attempt-${nextAttemptIndex}`;
  const childFrame = createChildWorkflowInvocationFrame({
    parentFrame: frame,
    callNodeId: nodeId,
    parentAttemptId,
    childWorkflow,
    boundInputs,
    startedAt
  });
  const parentAttempt = createNodeAttemptRecord({
    frame,
    nodeId,
    nodeKind: 'workflow',
    targetDefinitionId: childWorkflow.workflowId,
    inputEnvelope,
    startedAt,
    childInvocationId: childFrame.invocationId
  });

  const updatedParentFrame = recordNodeAttempt(frame, parentAttempt);
  let nextRun = upsertInvocationFrame(run, updatedParentFrame);
  nextRun = upsertInvocationFrame(nextRun, childFrame);
  return dispatchNodeInternal(
    deps,
    nextRun,
    expectedRevision,
    childFrame.invocationId,
    childEntryNodeId,
    startedAt
  );
}

/**
 * Record terminal completion of an in-flight node attempt and advance the
 * composable Workflow along its priority-ordered outgoing connections,
 * returning from child `WorkflowInvocationFrame`s on `{ kind: 'return' }` or
 * terminal sink nodes (FR-004, FR-005, FR-010, FR-013, FR-014, FR-015).
 */
export async function completeComposableNodeAttempt(
  deps: ComposableWorkflowCoordinatorDeps,
  input: {
    readonly run: ConnectedWorkflowRun;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly attemptIndex?: number;
    readonly status: WorkflowNodeTerminalStatus;
    readonly completedAt: number;
    readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>>;
    readonly verdict?: 'pass' | 'fail' | null;
    readonly failureCode?: string;
  }
): Promise<ComposableWorkflowStepResult> {
  return settleAttemptInternal(
    deps,
    input.run,
    input.run.revision,
    input.invocationId,
    input.nodeId,
    input.attemptIndex,
    input.status,
    input.completedAt,
    input.declaredOutputs,
    input.verdict,
    input.failureCode
  );
}

async function settleAttemptInternal(
  deps: ComposableWorkflowCoordinatorDeps,
  run: ConnectedWorkflowRun,
  expectedRevision: number,
  invocationId: string,
  nodeId: string,
  attemptIndex: number | undefined,
  status: WorkflowNodeTerminalStatus,
  completedAt: number,
  declaredOutputs?: Readonly<Record<string, ResolvedPortValue>>,
  verdict?: 'pass' | 'fail' | null,
  failureCode?: string
): Promise<ComposableWorkflowStepResult> {
  const closure = run.frozenClosure;
  const frame = run.invocations?.[invocationId];
  if (closure === undefined || frame === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'workflow-closure-invalid'
    };
  }
  const workflow = closure.workflowsById[frame.workflowId];
  if (workflow === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'workflow-closure-invalid'
    };
  }

  const nodeAttempts = frame.attemptsByNodeId[nodeId] ?? [];
  const existingAttempt =
    attemptIndex === undefined
      ? nodeAttempts[nodeAttempts.length - 1]
      : nodeAttempts.find((a) => a.attemptIndex === attemptIndex) ??
        nodeAttempts[attemptIndex];
  if (existingAttempt === undefined) {
    return {
      outcome: 'workflow-failed',
      run,
      invocationId,
      failureCode: 'unhandled-node-failure',
      detail: `Attempt '${nodeId}#${String(attemptIndex ?? 'latest')}' not found in invocation '${invocationId}'.`
    };
  }

  const settledAttempt: NodeAttemptRecord = Object.freeze({
    ...existingAttempt,
    status,
    completedAt,
    ...(declaredOutputs !== undefined
      ? { declaredOutputs: Object.freeze({ ...declaredOutputs }) }
      : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(failureCode !== undefined ? { failureCode } : {})
  });
  const frameWithAttempt = recordNodeAttempt(frame, settledAttempt);

  const context = buildInvocationConditionContext(frameWithAttempt, settledAttempt);
  const transition = selectNextTransition({
    graph: workflow,
    nodeId,
    attemptIndex: settledAttempt.attemptIndex,
    decidedAt: completedAt,
    attemptStatus: status,
    context
  });

  const updatedFrame: WorkflowInvocationFrame = {
    ...frameWithAttempt,
    decisions: Object.freeze([...frameWithAttempt.decisions, transition.decision])
  };
  let nextRun = upsertInvocationFrame(run, updatedFrame);

  if (
    transition.outcome === 'unhandled-node-failure' ||
    transition.outcome === 'no-eligible-transition'
  ) {
    if (status === 'canceled' && transition.outcome === 'unhandled-node-failure') {
      return cancelFrameAndPropagate(
        deps,
        nextRun,
        expectedRevision,
        updatedFrame,
        completedAt
      );
    }
    return failFrameAndPropagate(
      deps,
      nextRun,
      expectedRevision,
      updatedFrame,
      completedAt,
      transition.outcome
    );
  }

  if (
    transition.outcome === 'terminal-sink' ||
    (transition.outcome === 'transition' && transition.target.kind === 'return')
  ) {
    const publicOutputs = resolveWorkflowPublicOutputs({
      workflow,
      frame: updatedFrame
    });
    if (!publicOutputs.ok) {
      return failFrameAndPropagate(
        deps,
        nextRun,
        expectedRevision,
        updatedFrame,
        completedAt,
        publicOutputs.code,
        publicOutputs.message
      );
    }

    const completedFrame: WorkflowInvocationFrame = {
      ...updatedFrame,
      activeNodeId: null,
      status: 'completed',
      completedAt,
      resolvedOutputs: publicOutputs.resolvedByPort
    };
    nextRun = upsertInvocationFrame(nextRun, completedFrame);

    if (
      completedFrame.parentInvocationId !== null &&
      completedFrame.parentCallNodeId !== null
    ) {
      const parentFrame = nextRun.invocations?.[completedFrame.parentInvocationId];
      const parentNodeAttempts =
        parentFrame?.attemptsByNodeId[completedFrame.parentCallNodeId] ?? [];
      const parentAttempt = parentNodeAttempts.find(
        (a) => a.childInvocationId === completedFrame.invocationId
      );
      if (parentFrame !== undefined && parentAttempt !== undefined) {
        return settleAttemptInternal(
          deps,
          nextRun,
          expectedRevision,
          parentFrame.invocationId,
          parentAttempt.nodeId,
          parentAttempt.attemptIndex,
          'completed',
          completedAt,
          publicOutputs.resolvedByPort
        );
      }
    }

    return persistRunStep(deps.connectedRuns, nextRun, expectedRevision, (persisted) => ({
      outcome: 'workflow-completed',
      run: persisted,
      outputs: publicOutputs.resolvedByPort
    }));
  }

  // `transition.outcome === 'transition'` with `transition.target.kind === 'node'`
  if (transition.target.kind !== 'node') {
    throw new Error('Unreachable: return target handled above');
  }
  const targetNodeId = transition.target.nodeId;
  if (transition.handoff === 'manual') {
    const targetNode = workflow.nodes.find((n) => n.nodeId === targetNodeId);
    const targetKind =
      targetNode?.kind ?? (targetNode?.phaseId !== undefined ? 'phase' : 'workflow');
    const targetPorts =
      targetKind === 'phase'
        ? undefined
        : closure.workflowsById[targetNode?.workflowId ?? '']?.inputs;
    const prefilled = resolveNodeInputBindings({
      workflow,
      frame: updatedFrame,
      targetNodeId,
      ...(targetPorts !== undefined ? { targetInputPorts: targetPorts } : {})
    });
    const prefilledInputsByPort = prefilled.ok ? prefilled.resolvedByPort : Object.freeze({});
    const handoffRecord: PendingHandoffRecord = Object.freeze({
      invocationId,
      fromNodeId: nodeId,
      fromAttemptId: settledAttempt.attemptId,
      connectionIndex: transition.connectionIndex,
      target: { kind: 'node' as const, nodeId: targetNodeId },
      prefilledInputsByPort,
      pausedAt: completedAt
    });
    nextRun = upsertInvocationFrame(nextRun, {
      ...updatedFrame,
      activeNodeId: targetNodeId,
      status: 'waiting-for-handoff',
      pendingHandoff: handoffRecord
    });
    nextRun = setPendingHandoff(nextRun, handoffRecord);
    return persistRunStep(deps.connectedRuns, nextRun, expectedRevision, (persisted) => ({
      outcome: 'waiting-for-handoff',
      run: persisted,
      invocationId,
      fromNodeId: nodeId,
      toNodeId: targetNodeId
    }));
  }

  return dispatchNodeInternal(
    deps,
    nextRun,
    expectedRevision,
    invocationId,
    targetNodeId,
    completedAt
  );
}

async function failFrameAndPropagate(
  deps: ComposableWorkflowCoordinatorDeps,
  run: ConnectedWorkflowRun,
  expectedRevision: number,
  frame: WorkflowInvocationFrame,
  completedAt: number,
  failureCode: string,
  detail?: string
): Promise<ComposableWorkflowStepResult> {
  const failedFrame: WorkflowInvocationFrame = {
    ...frame,
    activeNodeId: null,
    status: 'failed',
    completedAt,
    failureCode,
    ...(detail !== undefined ? { failureMessage: detail } : {})
  };
  const nextRun = upsertInvocationFrame(run, failedFrame);

  if (failedFrame.parentInvocationId !== null && failedFrame.parentCallNodeId !== null) {
    const parentFrame = nextRun.invocations?.[failedFrame.parentInvocationId];
    const parentNodeAttempts =
      parentFrame?.attemptsByNodeId[failedFrame.parentCallNodeId] ?? [];
    const parentAttempt = parentNodeAttempts.find(
      (a) => a.childInvocationId === failedFrame.invocationId
    );
    if (parentFrame !== undefined && parentAttempt !== undefined) {
      return settleAttemptInternal(
        deps,
        nextRun,
        expectedRevision,
        parentFrame.invocationId,
        parentAttempt.nodeId,
        parentAttempt.attemptIndex,
        'failed',
        completedAt,
        undefined,
        undefined,
        failureCode
      );
    }
  }

  return persistRunStep(deps.connectedRuns, nextRun, expectedRevision, (persisted) => ({
    outcome: 'workflow-failed',
    run: persisted,
    invocationId: frame.invocationId,
    failureCode,
    ...(detail !== undefined ? { detail } : {})
  }));
}

async function cancelFrameAndPropagate(
  deps: ComposableWorkflowCoordinatorDeps,
  run: ConnectedWorkflowRun,
  expectedRevision: number,
  frame: WorkflowInvocationFrame,
  completedAt: number
): Promise<ComposableWorkflowStepResult> {
  const existingMarkers = frame.controlMarkers;
  const canceledFrame: WorkflowInvocationFrame = {
    ...frame,
    activeNodeId: null,
    status: 'canceled',
    completedAt,
    pendingHandoff: null,
    ...(existingMarkers !== undefined
      ? { controlMarkers: clearInvocationControlMarkers(existingMarkers) }
      : {})
  };
  const nextRun = upsertInvocationFrame(run, canceledFrame);

  if (canceledFrame.parentInvocationId !== null && canceledFrame.parentCallNodeId !== null) {
    const parentFrame = nextRun.invocations?.[canceledFrame.parentInvocationId];
    const parentNodeAttempts =
      parentFrame?.attemptsByNodeId[canceledFrame.parentCallNodeId] ?? [];
    const parentAttempt = parentNodeAttempts.find(
      (a) => a.childInvocationId === canceledFrame.invocationId
    );
    if (parentFrame !== undefined && parentAttempt !== undefined) {
      return settleAttemptInternal(
        deps,
        nextRun,
        expectedRevision,
        parentFrame.invocationId,
        parentAttempt.nodeId,
        parentAttempt.attemptIndex,
        'canceled',
        completedAt
      );
    }
  }

  return persistRunStep(deps.connectedRuns, nextRun, expectedRevision, (persisted) => ({
    outcome: 'workflow-canceled',
    run: persisted,
    invocationId: frame.invocationId
  }));
}
