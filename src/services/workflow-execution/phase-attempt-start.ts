// The one place a Phase node attempt becomes a `RunRequest`.
//
// Four production paths start a Phase attempt: the launcher, the control service behind a
// sidebar command, the completion handler that advances a run when a leaf finishes, and
// startup recovery. They used to carry a copy of this request each, and the copies
// disagreed: only the launcher's held what the operator attached at launch, so every Phase
// past the entry chain ran without the instructions, without the supplemental material and
// with no output target. Each path now keeps its own availability check and calls this.
//
// What a request holds:
//
// - Instructions and supplemental material belong to the whole run. A node's own local
//   inputs replace the launch supplemental rather than add to it, which is the rule the
//   launcher always had; merging could exceed a budget the launch was validated against.
// - An output target reaches the node a binding says produces that output, under the key
//   `resolveWorkflowPublicOutputs` reads afterwards. A target told to any other node, or
//   under the root port's name, leaves the bound node reporting nothing and the run ending
//   in `missing-required-output`.
// - Overwriting needs consent. The launch value stands, plus one rule: this run may
//   overwrite what it told an earlier Phase attempt to write. That covers a retry in the
//   same frame, a retried child (a new frame, numbered from 1), a loop, and two nodes bound
//   to one port. Anything else that appeared at a target is refused by the same gate a
//   launch goes through. A dispatch refused at the gate records no attempt, so refusal is
//   not a route to consent.
//
// No `vscode` import: the headless entrypoint runs this too. The coordinator is imported
// for types only, so the coordinator and this module stay free of a cycle.

import type {
  ExecutionEnvelope,
  FrozenOutputRequest,
  RunRequest
} from '../../contracts/run-request';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type {
  ConnectedRunLaunchContext,
  ConnectedWorkflowRun,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import type {
  PhaseAttemptDispatchInput,
  PhaseAttemptDispatchResult
} from './connected-run-coordinator';
import {
  startPhaseNodeRun,
  toSupplementalInputs,
  type NodeRunStartDeps,
  type NodeRunStartResult
} from './node-run-starter';

type OutputTargets = ReadonlyMap<string, FrozenOutputRequest>;

const NO_TARGETS: OutputTargets = new Map();
const VALIDATION_CODE_SEPARATOR = ', ';

/**
 * What a launch attached to the whole run, or `undefined` when it attached nothing, so a
 * run with nothing attached keeps the record shape it always had.
 */
export function launchContextOf(
  envelope: Pick<ExecutionEnvelope, 'supplemental' | 'outputs' | 'instructions'>
): ConnectedRunLaunchContext | undefined {
  const { supplemental, outputs, instructions } = envelope;
  if (supplemental.length === 0 && outputs.length === 0 && instructions === undefined) {
    return undefined;
  }
  return {
    supplemental,
    outputs,
    ...(instructions !== undefined ? { instructions } : {})
  };
}

function workflowOf(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): WorkflowDefinition | undefined {
  return run.frozenClosure?.workflowsById[frame.workflowId];
}

/**
 * The targets of `workflow`'s public outputs, re-keyed for `nodeId`. The key takes the same
 * precedence `resolveWorkflowPublicOutputs` reads with. Two ports bound to one node under
 * one key resolve to the same value, so the first binding's target is the one told.
 */
function routeThroughBindings(
  workflow: WorkflowDefinition | undefined,
  nodeId: string,
  targets: OutputTargets
): OutputTargets {
  const routed = new Map<string, FrozenOutputRequest>();
  for (const binding of workflow?.bindings ?? []) {
    if (binding.kind !== 'output' || binding.nodeId !== nodeId) continue;
    const target = targets.get(binding.portId);
    if (target === undefined) continue;
    const key = binding.sourcePortId ?? binding.outputKey ?? binding.portId;
    if (!routed.has(key)) routed.set(key, { ...target, portId: key });
  }
  return routed;
}

/** The targets of a frame's public outputs, routed down through every call above it. */
function publicTargetsOf(run: ConnectedWorkflowRun, frame: WorkflowInvocationFrame): OutputTargets {
  const callsInnermostFirst: { parent: WorkflowInvocationFrame; callNodeId: string }[] = [];
  const seen = new Set([frame.invocationId]);
  let cursor = frame;
  while (cursor.parentInvocationId !== null && cursor.parentCallNodeId !== null) {
    const parent = run.invocations?.[cursor.parentInvocationId];
    if (parent === undefined || seen.has(parent.invocationId)) return NO_TARGETS;
    seen.add(parent.invocationId);
    callsInnermostFirst.push({ parent, callNodeId: cursor.parentCallNodeId });
    cursor = parent;
  }
  let targets: OutputTargets = new Map(
    (run.launchContext?.outputs ?? []).map((output) => [output.portId, output])
  );
  for (const { parent, callNodeId } of callsInnermostFirst.reverse()) {
    targets = routeThroughBindings(workflowOf(run, parent), callNodeId, targets);
  }
  return targets;
}

/** One attempt's targets: routed from the run's, with its own overrides winning by port. */
function attemptTargets(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  nodeId: string,
  overrides: readonly FrozenOutputRequest[]
): OutputTargets {
  const targets = new Map(
    routeThroughBindings(workflowOf(run, frame), nodeId, publicTargetsOf(run, frame))
  );
  for (const override of overrides) targets.set(override.portId, override);
  return targets;
}

/**
 * Every target an earlier Phase attempt of this run was told to write. The attempt being
 * started is never in here: the coordinator records an attempt only after its dispatch is
 * accepted. A call node's attempt is excluded because it is on record before its child's
 * first Phase dispatches, and it writes nothing itself.
 */
function targetsOfEarlierAttempts(run: ConnectedWorkflowRun): ReadonlySet<string> {
  const told = Object.values(run.invocations ?? {}).flatMap((frame) =>
    Object.values(frame.attemptsByNodeId)
      .flat()
      .filter((attempt) => attempt.nodeKind === 'phase' && attempt.queueItemId !== undefined)
      .flatMap((attempt) => {
        const overrides = attempt.inputEnvelope.outputTargetOverrides;
        const targets = attemptTargets(run, frame, attempt.nodeId, overrides);
        return [...targets.values()].map((output) => output.target);
      })
  );
  return new Set(told);
}

function attemptOutputs(input: PhaseAttemptDispatchInput): readonly FrozenOutputRequest[] {
  const overrides = input.inputEnvelope?.outputTargetOverrides ?? [];
  const targets = attemptTargets(input.run, input.frame, input.node.nodeId, overrides);
  if (targets.size === 0) return [];
  const told = targetsOfEarlierAttempts(input.run);
  return [...targets.values()].map((output) =>
    told.has(output.target) ? { ...output, overwriteConfirmed: true } : output
  );
}

/** The `RunRequest` for one Phase attempt. Pure: reads the run and the dispatch input only. */
export function buildPhaseAttemptRequest(input: PhaseAttemptDispatchInput): RunRequest {
  const context = input.run.launchContext;
  const localInputs = input.inputEnvelope?.localInputs ?? [];
  const instructions = context?.instructions;
  return {
    pipelineId: input.phase.phaseId,
    inputs: Object.values(input.boundInputs).map((port) => ({
      portId: port.portId,
      type: port.type as RunRequest['inputs'][number]['type'],
      value: port.value
    })),
    supplemental: toSupplementalInputs(localInputs.length > 0 ? localInputs : context?.supplemental),
    outputs: attemptOutputs(input),
    ...(instructions !== undefined ? { instructions } : {})
  };
}

/** Build the attempt's request and put it through the same gates as any other start. */
export async function startPhaseAttempt(
  deps: NodeRunStartDeps,
  input: PhaseAttemptDispatchInput,
  workspaceRoot: string | null,
  options?: { readonly continuesWorkflow?: true }
): Promise<NodeRunStartResult> {
  const closure = input.run.frozenClosure;
  if (closure === undefined) {
    return { outcome: 'rejected-definition', reason: 'pipeline-not-found' };
  }
  return startPhaseNodeRun(deps, {
    frozenClosure: closure,
    phaseId: input.phase.phaseId,
    request: buildPhaseAttemptRequest(input),
    workspaceRoot,
    description: input.node.label ?? input.phase.name,
    queueId: input.queueId,
    ...(input.run.controlState !== undefined
      ? { ledgerRunId: input.run.controlState.ledgerRunId }
      : {}),
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
    ...options,
    occurrence: {
      rootRunId: input.run.connectedRunId,
      invocationId: input.frame.invocationId,
      parentInvocationId: input.frame.parentInvocationId,
      nodePath: input.nodePath ?? `${input.frame.nodePath}/${input.node.nodeId}`,
      attemptId: input.attemptId,
      attemptIndex: input.attemptIndex
    }
  });
}

/**
 * The coordinator's reading of a start. A refused validation names its error codes, a closed
 * set with no path or operator text in it, because `rejected-validation` alone leaves the
 * operator looking at a failed Phase with no idea what to fix.
 */
export function phaseDispatchResultOf(started: NodeRunStartResult): PhaseAttemptDispatchResult {
  if (started.outcome === 'enqueued') {
    return { outcome: 'dispatched', queueItemId: started.queueItemId };
  }
  if (started.outcome === 'rejected-validation') {
    const codes = new Set(started.errors.map((error) => error.code));
    return {
      outcome: 'rejected',
      reason: started.outcome,
      detail: [...codes].join(VALIDATION_CODE_SEPARATOR)
    };
  }
  return { outcome: 'rejected', reason: started.outcome };
}
