// Feature 088 (T025) — the prefill, which is a draft and nothing more.
//
// When an operator selects an eligible node, the composer opens on that node's
// Pipeline with the incoming connections' bound output references already filled
// in (FR-035, FR-036). Two properties make that safe, and both are structural
// rather than promised:
//
//   * It is never persisted. The return value is a `RunRequest` draft that lives
//     in the view until the operator submits; nothing here writes.
//   * It is never trusted. What starts a run is the `RunRequest` the operator
//     submits, validated by `validateRunRequest()` like any other (FR-039). The
//     host does not receive the prefill and could not tell it from any other
//     submission if it did — which is exactly why it does not need to.
//
// So the prefill is a convenience, and a wrong one costs an edit rather than a
// bad run.
//
// FR-037's "never a mixture across attempts" is inherited rather than
// re-enforced: the facts arrive as the `ConditionContext` the eligibility
// decision was made against, and `buildConditionContext()` refuses two entries
// for the same node. There is no attempt selection to get wrong here because
// there is no attempt selection here at all.
//
// No I/O. A bound value is the workspace-relative reference the source run
// recorded, never the document behind it.

import type { RunInputValue, RunRequest } from '../../contracts/run-request';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type { WorkflowRunPipeline } from '../../state/workflow-run';
import type { ConditionContext } from './condition-context';
import { resolveOperand } from './condition-context';

/** One prefilled port, and where its value came from. */
export interface PrefilledPort {
  /** An input port of the destination node's Pipeline. */
  readonly portId: string;
  /** Position in the frozen graph's `connections`, as a `RoutingDecision` reports it. */
  readonly connectionIndex: number;
  readonly sourceNodeId: string;
  /** The declared output port of the source node that supplied the value. */
  readonly sourceOutput: string;
}

export interface ContinuationPrefill {
  /** A draft. Editable in full, submitted only by the operator (FR-036, FR-038). */
  readonly request: RunRequest;
  /** What was filled, so the view can say why a value is there without re-deriving it. */
  readonly prefilled: readonly PrefilledPort[];
}

export interface ContinuationPrefillInput {
  /** The run's frozen graph — the authority for what connects to what (FR-003). */
  readonly graph: WorkflowDefinition;
  /** The destination node's frozen Pipeline (FR-004), for its declared input ports. */
  readonly pipeline: WorkflowRunPipeline;
  readonly nodeId: string;
  /**
   * The connections that made this node eligible, as the `RoutingDecision`
   * recorded them: positions in the frozen graph's `connections`, in offer order.
   *
   * Supplied rather than re-derived. The decision is what the operator is acting
   * on, and re-deriving eligibility here would be a second oracle that could
   * disagree with the one they are looking at.
   */
  readonly viaConnections: readonly number[];
  /** The facts of the exact attempts that decision read (FR-037). */
  readonly context: ConditionContext;
}

/**
 * Build the draft (FR-036, FR-037).
 *
 * Every step is a skip rather than an error. A connection whose source did not
 * complete, whose named output the run never resolved, or whose destination port
 * the frozen Pipeline does not declare simply contributes no value — the operator
 * gets an empty field they can fill, which is the correct outcome for a binding
 * that has nothing behind it. Refusing to open the composer at all would make an
 * unresolved optional output block a start that validation would have accepted.
 *
 * First binding wins when two connections name the same destination port. They
 * arrive in offer order, so the first is the one the operator's own selection
 * ranked highest; overwriting it with a later one would silently prefer a branch
 * they did not choose.
 */
export function composeContinuationPrefill(input: ContinuationPrefillInput): ContinuationPrefill {
  const ports = new Map((input.pipeline.inputs ?? []).map((port) => [port.portId, port]));
  const inputs: RunInputValue[] = [];
  const prefilled: PrefilledPort[] = [];
  const filled = new Set<string>();

  for (const index of input.viaConnections) {
    const connection = input.graph.connections[index];
    if (connection === undefined || connection.to.nodeId !== input.nodeId) continue;
    const port = ports.get(connection.to.portId);
    if (port === undefined || filled.has(port.portId)) continue;

    // The same rule a condition reads by, deliberately: completed attempt,
    // declared output, resolved, reference present. A binding that could read
    // what a condition cannot would be a second definition of "available
    // output", and the one that decided the branch is the one that must hold.
    const lookup = resolveOperand(
      { source: 'node-output', nodeId: connection.from.nodeId, field: connection.from.portId },
      input.context
    );
    if (!lookup.resolved || typeof lookup.value !== 'string') continue;

    filled.add(port.portId);
    inputs.push({ portId: port.portId, type: port.type, value: lookup.value });
    prefilled.push({
      portId: port.portId,
      connectionIndex: index,
      sourceNodeId: connection.from.nodeId,
      sourceOutput: connection.from.portId
    });
  }

  return {
    // Everything else empty: supplemental material and output targets are the
    // operator's to name for this session (FR-038), and a guessed output target
    // is a write to a location nobody chose.
    request: {
      pipelineId: input.pipeline.id,
      inputs,
      supplemental: [],
      outputs: []
    },
    prefilled
  };
}
