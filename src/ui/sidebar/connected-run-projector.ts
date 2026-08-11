// Feature 088 (T038) — the connected-run read model.
//
// Everything the view shows about a connected run is derived here, on read, from
// two sources and no third: the stored aggregate, and the current state of the
// child Pipeline Runs it references. Nothing below is persisted (FR-002), and
// there is no second derivation anywhere — `cmd-continue-workflow.ts` asks this
// module whether a node is startable (gate 4) with the same fold the view renders,
// so the host and the operator cannot come to disagree about what is offerable.
//
// The derivation table is data-model.md "Derived", resolved in its order:
//
//   completed / in-flight / failed / canceled   the latest attempt's child run
//   available                                   offered by the most recent
//                                               decision that considered it
//   blocked                                     considered and not offered (FR-055)
//   unvisited                                   in the graph, in no decision
//
// Terminal-state-first is FR-055a: a node whose most recent attempt finished stays
// in that terminal state rather than returning to `available`. Whether it will
// accept another start is an *action*, not a fifth state.
//
// Two rules about a child reference the host cannot resolve, and they are
// deliberately different answers to deliberately different questions:
//
//   * `hydrating` is FR-058's question — have the child-run references arrived?
//     An unresolvable one answers no, and the view shows a loading state rather
//     than a speculative action set.
//   * The node's own state is read as *no observation at all*, so the node falls
//     through to the decision fold. That is the same reading
//     `ChildRunSettledProbe` documents for the FR-044 gate — a queue item nothing
//     holds is not executing — and reading it as "still going" instead would leave
//     a connected run permanently unstartable on the strength of a reference that
//     no longer resolves.
//
// No `vscode` import: the child-state reader arrives as a port.

import type {
  ConnectedNodeAction,
  ConnectedNodeProjection,
  ConnectedNodeState,
  ConnectedRunProjection
} from '../../contracts/sidebar-ipc';
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';

/**
 * What one child Pipeline Run is doing, in the vocabulary the wire already uses.
 *
 * Drawn from `ConnectedNodeState` rather than declared afresh: these four members
 * ARE the node states a child can produce, and a parallel enum would be a second
 * vocabulary for the same lifecycle.
 */
export type ConnectedChildState = Extract<
  ConnectedNodeState,
  'completed' | 'in-flight' | 'failed' | 'canceled'
>;

/** `null` when the host cannot resolve the reference — see the header. */
export type ChildRunStateReader = (queueItemId: string) => ConnectedChildState | null;

type OfferedState = Extract<ConnectedNodeState, 'available' | 'blocked'>;

const NO_ACTIONS: readonly ConnectedNodeAction[] = Object.freeze([]);
const START: readonly ConnectedNodeAction[] = Object.freeze(['start']);
const RESTART: readonly ConnectedNodeAction[] = Object.freeze(['restart']);

/** The node one connection points at, or `undefined` if the index is not in the frozen graph. */
function destinationOf(run: ConnectedWorkflowRun, connectionIndex: number): string | undefined {
  return run.graph.connections[connectionIndex]?.to.nodeId;
}

/**
 * Fold the recorded decisions into "offered" / "considered and not offered".
 *
 * Walked newest-first, and the first decision that mentions a node decides it —
 * so a node that was blocked and later became eligible projects as `available`,
 * and a branch that was offered stays offered after a sibling advances. Within one
 * decision, offered wins: a node reachable by two connections, one eligible and
 * one not, was offered.
 */
function foldDecisions(run: ConnectedWorkflowRun): ReadonlyMap<string, OfferedState> {
  const decided = new Map<string, OfferedState>();
  const claim = (nodeId: string | undefined, state: OfferedState): void => {
    if (nodeId === undefined || decided.has(nodeId)) return;
    decided.set(nodeId, state);
  };
  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const decision = run.decisions[index];
    if (decision === undefined) continue;
    const eligible = new Set(decision.eligible);
    for (const outcome of decision.connections) {
      if (eligible.has(outcome.index)) claim(destinationOf(run, outcome.index), 'available');
    }
    for (const outcome of decision.connections) {
      if (!eligible.has(outcome.index)) claim(destinationOf(run, outcome.index), 'blocked');
    }
  }
  return decided;
}

interface ChildReading {
  /** The latest attempt's child state, or `null` when there is no attempt or it is unresolvable. */
  readonly latest: ConnectedChildState | null;
  readonly attemptCount: number;
  readonly latestQueueItemId?: string;
}

function readChild(
  run: ConnectedWorkflowRun,
  nodeId: string,
  readChildState: ChildRunStateReader
): ChildReading {
  const attempts = run.nodes[nodeId]?.attempts ?? [];
  const latestAttempt = attempts[attempts.length - 1];
  if (latestAttempt === undefined) return { latest: null, attemptCount: 0 };
  return {
    latest: readChildState(latestAttempt.queueItemId),
    attemptCount: attempts.length,
    latestQueueItemId: latestAttempt.queueItemId
  };
}

/**
 * FR-044, as the projection sees it: every attempt of every node, not just each
 * node's latest. The invariant is scoped to the connected run, and this is the
 * same walk `workflow-launcher.ts`'s gate 3 makes — which is why a projection
 * taken while any child is still in flight offers nothing anywhere.
 */
function eachAttempt(
  run: ConnectedWorkflowRun,
  readChildState: ChildRunStateReader,
  predicate: (state: ConnectedChildState | null) => boolean
): boolean {
  return Object.values(run.nodes).some((record) =>
    record.attempts.some((attempt) => predicate(readChildState(attempt.queueItemId)))
  );
}

function stateOf(reading: ChildReading, offered: OfferedState | undefined, isStart: boolean): ConnectedNodeState {
  if (reading.latest !== null) return reading.latest;
  if (offered !== undefined) return offered;
  // A start node with nothing recorded against it is offerable: it is where the
  // Workflow begins, and it is also the shape a launch that crashed between its
  // enqueue and its write leaves behind (contract, *Partial writes*).
  return isStart ? 'available' : 'unvisited';
}

function actionsOf(state: ConnectedNodeState, attemptCount: number): readonly ConnectedNodeAction[] {
  // FR-016 — a finished node accepts another start; an unfinished one does not.
  if (state === 'completed' || state === 'failed' || state === 'canceled') return RESTART;
  // `available` with attempts behind it is a re-offer of a node whose reading did
  // not resolve; the operator's composer is the repeat-start one either way.
  if (state === 'available') return attemptCount > 0 ? RESTART : START;
  return NO_ACTIONS;
}

/**
 * The whole read model of one connected run (FR-055, FR-055a, FR-057, FR-058).
 *
 * Ordered by the frozen graph's own node order, so the view renders a stable list
 * that matches the Workflow the operator authored.
 */
export function projectConnectedRun(
  run: ConnectedWorkflowRun,
  readChildState: ChildRunStateReader
): ConnectedRunProjection {
  const decided = foldDecisions(run);
  const anyInFlight = eachAttempt(run, readChildState, (state) => state === 'in-flight');
  const hydrating = eachAttempt(run, readChildState, (state) => state === null);
  const startNodes = new Set(run.graph.startNodeIds);

  const nodes: ConnectedNodeProjection[] = run.graph.nodes.map((node) => {
    const reading = readChild(run, node.nodeId, readChildState);
    const state = stateOf(reading, decided.get(node.nodeId), startNodes.has(node.nodeId));
    return {
      nodeId: node.nodeId,
      pipelineId: node.pipelineId,
      state,
      // FR-057 — only what the host would accept right now. While any child is
      // non-terminal the launcher refuses every start (FR-044), so nothing is
      // legal anywhere and the projection says so rather than offering a control
      // that is guaranteed to be refused.
      actions: anyInFlight ? NO_ACTIONS : actionsOf(state, reading.attemptCount),
      attemptCount: reading.attemptCount,
      ...(reading.latestQueueItemId !== undefined
        ? { latestQueueItemId: reading.latestQueueItemId }
        : {})
    };
  });

  return {
    connectedRunId: run.connectedRunId,
    workflowId: run.workflowId,
    revision: run.revision,
    hydrating,
    nodes: Object.freeze(nodes)
  };
}

/**
 * Gate 4 of `CMD_CONTINUE_WORKFLOW` (FR-016), as the projection answers it.
 *
 * Deliberately defined as "the projection offers this node an action" rather than
 * as its own predicate over the decisions. FR-057 says the view offers only what
 * is legal, and the only way to keep that true is for legality to have exactly one
 * definition — this one.
 */
export function isNodeStartable(
  run: ConnectedWorkflowRun,
  nodeId: string,
  readChildState: ChildRunStateReader
): boolean {
  const projection = projectConnectedRun(run, readChildState);
  return projection.nodes.some((node) => node.nodeId === nodeId && node.actions.length > 0);
}
