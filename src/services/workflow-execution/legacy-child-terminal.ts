// Feature 088 (T026) — Legacy Pipeline-node connected-run child-terminal
// decision recording, factored out of `connected-run-coordinator.ts` so the
// composable coordinator remains well within its LOC budget. Re-exported from
// `connected-run-coordinator.ts` for full API compatibility. Zero `vscode` imports.

import type { RunOutputRecord } from '../../contracts/run-results';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import type { SanitizedLogger } from '../../lib/logger';
import {
  appendDecision,
  type ConnectedNodeRecord,
  type ConnectedWorkflowRun,
  type RoutingDecision
} from '../../state/connected-workflow-run';
import { buildConditionContext, type NodeAttemptFacts } from './condition-context';
import { buildRoutingDecisionObservation, selectNextNodes } from './next-node-selector';
import type { ConnectedRunWriter } from './workflow-launcher';

/** What one finished child run contributes. Read from the child, never stored here. */
export interface ChildRunFacts {
  readonly status: WorkflowNodeTerminalStatus;
  /** As the child recorded them: location references, never file contents. */
  readonly outputs: readonly RunOutputRecord[];
}

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

function attemptOf(record: ConnectedNodeRecord | undefined, index: number): string | undefined {
  return record?.attempts[index]?.queueItemId;
}

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

export async function recordChildTerminal(
  deps: ConnectedRunCoordinatorDeps,
  input: ChildTerminalInput
): Promise<ChildTerminalResult> {
  const run = input.run;
  const queueItemId = attemptOf(run.nodes[input.nodeId], input.attemptIndex);
  if (queueItemId === undefined) {
    return { outcome: 'ignored', reason: 'unknown-attempt' };
  }
  if (deps.readChildFacts(queueItemId) === null) {
    return { outcome: 'ignored', reason: 'not-terminal' };
  }

  const context = buildConditionContext(
    collectFacts(run, input.nodeId, input.attemptIndex, deps.readChildFacts)
  );
  const decision = selectNextNodes({
    graph: run.graph,
    nodeId: input.nodeId,
    attemptIndex: input.attemptIndex,
    decidedAt: input.decidedAt,
    context
  });
  const observation = buildRoutingDecisionObservation(
    {
      runId: run.connectedRunId,
      graph: run.graph,
      nodeId: input.nodeId,
      attemptIndex: input.attemptIndex,
      decidedAt: input.decidedAt,
      context,
      selectSingleWinner: false
    },
    decision
  );

  const next = appendDecision(run, decision, observation);
  const written = await deps.connectedRuns.compareAndSetConnectedRun(next, run.revision);
  if (written.outcome === 'stale') {
    deps.logger.warn(
      'connected-run-coordinator: routing decision superseded by a concurrent write; not recorded'
    );
    return { outcome: 'rejected-stale', current: written.current };
  }
  return { outcome: 'recorded', run: written.run, decision };
}

