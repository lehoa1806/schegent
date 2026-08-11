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

import type { RunOutputRecord } from '../../contracts/run-results';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  ConnectedNodeRecord,
  RoutingDecision
} from '../../state/connected-workflow-run';
import { appendDecision } from '../../state/connected-workflow-run';
import type { SanitizedLogger } from '../../lib/logger';
import type { ConnectedRunWriter } from './workflow-launcher';
import type { NodeAttemptFacts } from './condition-context';
import { buildConditionContext } from './condition-context';
import { selectNextNodes } from './next-node-selector';

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
