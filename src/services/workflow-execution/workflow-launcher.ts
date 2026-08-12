// Feature 088 (T022, T023, T024) — the gates a connected-run start passes.
//
// Two entry points, one for each command in
// specs/088-workflow-continuation/contracts/workflow-run-ipc.md:
//
//   * `launchWorkflow()`   — opens a connected run at an allowed starting node;
//   * `continueWorkflow()` — starts one more node of a run that already exists.
//
// Everything they share is the start itself, and it is not reimplemented here:
// both reach `node-run-starter.ts`, which is the same resolve → validate → guard
// → enqueue seam `cmd-launch-pipeline.ts` reaches (plan D2). A node's child run
// is therefore a Pipeline Run in every respect that matters — same
// `validateRunRequest()`, same `FrozenRunPlan`, same `scheduleOrEnqueue`, and so
// the same audit, transcript, lock, and cancellation behaviour (FR-014, FR-015,
// FR-067). There is no second, relaxed path.
//
// What is NOT here:
//
//   * The catalog gates. Resolving the Workflow and validating its graph
//     (gates 1-2) belong to the handler, which is the layer that can see the
//     effective catalog. This module receives the resolved definition.
//   * The projection. A refusal carries the authoritative aggregate; the handler
//     projects it into the legal action set (FR-045) with the same projector the
//     view renders, so a stale view corrects itself from the refusal rather than
//     from a second, launcher-shaped copy of the same derivation.
//   * Eligibility. Which successors are offerable is a fold over recorded
//     decisions and is injected as `isNodeStartable`, so the FR-044 gate below
//     stays structurally ahead of it and the fold keeps one owner.
//
// No `vscode` import: the store and the child-status probe arrive as ports.

import type { RunRequestFieldError, RunRequest } from '../../contracts/run-request';
import type { WorkflowDefinition, WorkflowNode } from '../../contracts/workflow-definitions';
import type { PipelineCatalog } from '../../config/pipeline-config';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';
import { appendAttempt, resolveBoundQueueId } from '../../state/connected-workflow-run';
import type { ConnectedRunWriteResult } from '../../state/workspace-state';
import { createConnectedRunSnapshot } from './connected-run-factory';
import type { NodeRunStartDeps, NodeRunStartResult } from './node-run-starter';
import { startPipelineRun } from './node-run-starter';

/**
 * Why a start was refused for a reason that is neither a field nor the run's
 * current state.
 *
 * `workflow-not-found` and `workflow-invalid` are the handler's gates 1-2; they
 * are named here because the refusal vocabulary is one closed set on the wire,
 * and because the factory below can produce `workflow-invalid` as a residual.
 */
export type WorkflowStartRefusal =
  | 'workflow-not-found'
  | 'workflow-invalid'
  | 'node-not-startable'
  | 'pipeline-mismatch'
  | 'no-workspace-root';

/** Why a start was refused for something the run's current state decides. */
export type ConnectedRunStateRefusal = 'child-not-terminal' | 'node-not-eligible';

export type LaunchWorkflowResult =
  | {
      readonly outcome: 'started';
      readonly run: ConnectedWorkflowRun;
      readonly queueItemId: string;
    }
  | { readonly outcome: 'rejected-definition'; readonly reason: WorkflowStartRefusal }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: 'queue-refused';
      readonly detail?: string;
    };

export type ContinueWorkflowResult =
  | {
      readonly outcome: 'started';
      readonly run: ConnectedWorkflowRun;
      readonly queueItemId: string;
    }
  /** `current` is the authoritative record, or `null` if the run is gone. */
  | { readonly outcome: 'rejected-stale'; readonly current: ConnectedWorkflowRun | null }
  | {
      readonly outcome: 'rejected-state';
      readonly reason: ConnectedRunStateRefusal;
      readonly run: ConnectedWorkflowRun;
    }
  | { readonly outcome: 'rejected-definition'; readonly reason: WorkflowStartRefusal }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: 'queue-refused';
      readonly detail?: string;
    };

/**
 * Has this child Pipeline Run stopped?
 *
 * Deliberately a boolean rather than a status. The FR-044 gate asks one question
 * — may another node start — and a status here would be a second vocabulary for
 * child lifecycle alongside the one the run record already owns.
 *
 * An id the host cannot resolve answers `true`. That is not a fallback: a queue
 * item nothing holds is not executing, and the alternative — reading "unknown" as
 * "still going" — would leave a connected run permanently unstartable on the
 * strength of a reference that no longer resolves.
 */
export type ChildRunSettledProbe = (queueItemId: string) => boolean;

/** The compare-and-set write path (FR-046). Structurally the workspace store. */
export interface ConnectedRunWriter {
  compareAndSetConnectedRun(
    next: ConnectedWorkflowRun,
    expectedRevision: number
  ): Promise<ConnectedRunWriteResult>;
}

export interface WorkflowLauncherDeps extends NodeRunStartDeps {
  readonly connectedRuns: ConnectedRunWriter;
  readonly isChildSettled: ChildRunSettledProbe;
}

export interface LaunchWorkflowInput {
  readonly connectedRunId: string;
  /** Resolved from the **effective** catalog by the handler, before any freeze. */
  readonly workflow: WorkflowDefinition;
  readonly catalog: PipelineCatalog;
  readonly startNodeId: string;
  readonly request: RunRequest;
  readonly workspaceRoot: string | null;
  readonly startedAt: number;
  readonly defaultRunnerKind?: BackendRunnerKind;
  /**
   * Feature 092 (T080, FR-041, FR-042) — the queue this run binds to.
   *
   * Named once, here, at the only moment a binding may be chosen. It goes two
   * places from this one value: onto the aggregate, where it is fixed for the
   * run's life, and onto this first child's enqueue. Every later child reads it
   * back off the aggregate, so the two cannot diverge.
   */
  readonly queueId?: string;
}

export interface ContinueWorkflowInput {
  /** As stored. The handler resolved it; gate 1 has already passed. */
  readonly run: ConnectedWorkflowRun;
  readonly expectedRevision: number;
  readonly nodeId: string;
  /** What the operator submitted — never the prefill (FR-039). */
  readonly request: RunRequest;
  readonly workspaceRoot: string | null;
  readonly startedAt: number;
  /**
   * Gate 4 (FR-016). Injected because eligibility is a fold over the recorded
   * decisions, which `connected-run-projector.ts` owns; deriving it a second
   * time here is how the host and the view would come to disagree about which
   * nodes are offerable.
   */
  readonly isNodeStartable: (run: ConnectedWorkflowRun, nodeId: string) => boolean;
}

/** The node a start names, or `undefined` when the graph has no such node. */
function nodeOf(graph: WorkflowDefinition, nodeId: string): WorkflowNode | undefined {
  return graph.nodes.find((node) => node.nodeId === nodeId);
}

/**
 * FR-044, as one predicate over the whole aggregate.
 *
 * Every attempt of every node, not just each node's latest: the invariant is
 * scoped to the connected run rather than to a node, and walking the whole list
 * means it holds without depending on attempts being appended in the order a
 * reader assumes.
 */
function childInFlight(run: ConnectedWorkflowRun, isChildSettled: ChildRunSettledProbe): boolean {
  return Object.values(run.nodes).some((record) =>
    record.attempts.some((attempt) => !isChildSettled(attempt.queueItemId))
  );
}

/**
 * Translate the shared seam's outcome into a command's own vocabulary.
 *
 * The seam refuses `pipeline-not-found` when the request names a Pipeline the
 * frozen snapshot does not hold, which on this path can only mean the request was
 * addressed at a different node's Pipeline — reported as `pipeline-mismatch`
 * rather than as a missing definition, because nothing is missing. `pipeline-
 * invalid` cannot arise at all against a snapshot, which is complete by
 * construction; it maps to `workflow-invalid` for exhaustiveness rather than
 * because there is a path to it.
 */
function refusalOf(
  started: Exclude<NodeRunStartResult, { outcome: 'enqueued' }>
): LaunchWorkflowResult & ContinueWorkflowResult {
  if (started.outcome === 'rejected-validation') {
    return { outcome: 'rejected-validation', errors: started.errors };
  }
  if (started.outcome === 'rejected-queue') {
    return {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      ...(started.detail !== undefined ? { detail: started.detail } : {})
    };
  }
  if (started.reason === 'pipeline-not-found') {
    return { outcome: 'rejected-definition', reason: 'pipeline-mismatch' };
  }
  if (started.reason === 'pipeline-invalid') {
    return { outcome: 'rejected-definition', reason: 'workflow-invalid' };
  }
  return { outcome: 'rejected-definition', reason: started.reason };
}

/**
 * Open a connected run and start its first node (FR-011, FR-012, FR-014, FR-015).
 *
 * Gate order is the contract's, and the single state-writing step sits after all
 * of it:
 *
 *   3  the node is an allowed start
 *   3a the request names that node's Pipeline
 *   —  the aggregate is BUILT IN MEMORY (nothing durable yet)
 *   4-6 workspace root, validation, queue    — reached through the shared seam
 *   —  the aggregate is WRITTEN ONCE, already carrying the first attempt
 *
 * FR-012 reads "a refused launch MUST leave no connected-run state behind" with no
 * gate qualifier, so no gate may precede a write. Building the snapshot early and
 * writing it late is what makes that hold: gate 5 needs the Pipeline the run would
 * freeze, and gates 4-6 must still be able to refuse without leaving a run behind.
 *
 * The write is a compare-and-set against revision 0, which is also the id-collision
 * check — revision 0 means "no run under this id", and a launch that finds one
 * refuses rather than merging into a live run.
 *
 * A crash between the enqueue and the write leaves an orphan queue item that runs
 * as a normal Pipeline Run and is visible in the queue; nothing is silently lost,
 * and nothing is compensated by a delete (contract, *Partial writes*).
 */
export async function launchWorkflow(
  deps: WorkflowLauncherDeps,
  input: LaunchWorkflowInput
): Promise<LaunchWorkflowResult> {
  // Gate 3 (FR-011). A start node that the graph does not contain is refused the
  // same way as one the graph contains but does not allow: in both cases the
  // named node is not something this Workflow starts at.
  if (!input.workflow.startNodeIds.includes(input.startNodeId)) {
    return { outcome: 'rejected-definition', reason: 'node-not-startable' };
  }
  const node = nodeOf(input.workflow, input.startNodeId);
  if (node === undefined) {
    return { outcome: 'rejected-definition', reason: 'node-not-startable' };
  }
  // Gate 3a. Checked before the freeze so a mis-addressed request costs nothing.
  if (node.pipelineId !== input.request.pipelineId) {
    return { outcome: 'rejected-definition', reason: 'pipeline-mismatch' };
  }

  const snapshot = createConnectedRunSnapshot({
    connectedRunId: input.connectedRunId,
    workflow: input.workflow,
    catalog: input.catalog,
    startedAt: input.startedAt,
    ...(input.defaultRunnerKind ? { defaultRunnerKind: input.defaultRunnerKind } : {}),
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {})
  });
  if (snapshot.outcome === 'rejected') {
    // A residual: gate 2's graph validation resolves every node's Pipeline
    // against the same effective catalog, so reaching here means the catalog
    // moved between the two reads. Refused rather than started against a
    // partially resolved graph.
    return { outcome: 'rejected-definition', reason: 'workflow-invalid' };
  }

  // Gates 4-6. Still nothing durable: a refusal here returns with the snapshot
  // discarded, which is FR-012 at the gates that would otherwise have written.
  const started = await startPipelineRun(deps, {
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    frozenPipeline: snapshot.run.pipelines[node.pipelineId],
    description: node.label ?? input.workflow.name,
    // FR-042. Read back off the aggregate rather than from `input`, so the
    // child's queue and the run's binding are the same value by construction
    // and not by two call sites agreeing.
    queueId: resolveBoundQueueId(snapshot.run)
  });
  if (started.outcome !== 'enqueued') return refusalOf(started);

  const opened = appendAttempt(snapshot.run, input.startNodeId, {
    queueItemId: started.queueItemId,
    startedAt: input.startedAt
  });
  const created = await deps.connectedRuns.compareAndSetConnectedRun(opened, 0);
  if (created.outcome === 'stale') {
    // Revision 0 means "no run under this id". A collision is a caller defect —
    // the id is minted per launch — so it is refused rather than merged into. The
    // child is already queued and stays queued; it runs as a normal Pipeline Run,
    // and rolling it back would be a destructive write on a failure path.
    deps.logger.warn('workflow-launcher: connected run id already in use, launch refused');
    return { outcome: 'rejected-definition', reason: 'workflow-invalid' };
  }

  return { outcome: 'started', run: created.run, queueItemId: started.queueItemId };
}

/**
 * Start one more node of an existing connected run (FR-016, FR-044, FR-045).
 *
 * Gate order, and the reason for it:
 *
 *   2  `expectedRevision` matches   — a stale command reports staleness, never
 *                                     the state it happens to conflict with
 *   3  no child is non-terminal     — FR-044, ahead of validation
 *   4  the node is startable now    — injected fold (FR-016)
 *   4a the request names that node's Pipeline
 *   4b-6 workspace root, validation, queue
 *   7  append the attempt and increment
 *
 * Gate 2 first is the same revision-before-everything ordering the save-command
 * family holds, for the same reason: after a stale command the operator refreshes,
 * after a state refusal they wait, and reporting the wrong one sends them down the
 * wrong path.
 *
 * Idempotency (FR-047) needs nothing else. Two identical submissions arrive with
 * the same `expectedRevision`; the first reaches gate 7 and increments, the second
 * fails gate 2. No dedup key, no request id, no time window — the compare-and-set
 * is the mechanism, which is why gate 7 is one write and not two.
 */
export async function continueWorkflow(
  deps: WorkflowLauncherDeps,
  input: ContinueWorkflowInput
): Promise<ContinueWorkflowResult> {
  const run = input.run;
  // Gate 2 (FR-046).
  if (run.revision !== input.expectedRevision) {
    return { outcome: 'rejected-stale', current: run };
  }
  // Gate 3 (FR-044). Before validation, so an operator whose request also has a
  // field problem is told the thing that is actually blocking them.
  if (childInFlight(run, deps.isChildSettled)) {
    return { outcome: 'rejected-state', reason: 'child-not-terminal', run };
  }
  // Gate 4 (FR-016). Admits an eligible successor and a re-start of a node whose
  // latest attempt is terminal; both are the same question to the fold.
  if (!input.isNodeStartable(run, input.nodeId)) {
    return { outcome: 'rejected-state', reason: 'node-not-eligible', run };
  }

  const node = nodeOf(run.graph, input.nodeId);
  if (node === undefined) {
    // The frozen graph is the authority for the run's life, so a node it does not
    // contain is not startable — regardless of what the catalog holds now.
    return { outcome: 'rejected-state', reason: 'node-not-eligible', run };
  }
  // Gate 4a.
  if (node.pipelineId !== input.request.pipelineId) {
    return { outcome: 'rejected-definition', reason: 'pipeline-mismatch' };
  }

  // Gates 4b-6, against the FROZEN Pipeline rather than the effective catalog:
  // the catalog is consulted once per connected run, at launch, and from then on
  // the run executes what it froze (FR-003, FR-004, FR-005). This is the one
  // place the two commands deliberately differ.
  const started = await startPipelineRun(deps, {
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    frozenPipeline: run.pipelines[node.pipelineId],
    description: node.label ?? run.graph.name,
    // FR-042, FR-043. The bound queue, taken from the run — a continuation has
    // no say in it. That is also what makes the paused-queue refusal (FR-043)
    // land on the right queue: `scheduleOrEnqueue` checks the queue named here,
    // so a paused bound queue stops this run advancing while every other queue
    // carries on.
    queueId: resolveBoundQueueId(run)
  });
  if (started.outcome !== 'enqueued') return refusalOf(started);

  // Gate 7, and the same enqueue-then-write order the launch above holds: a crash
  // between them leaves a queue item that runs as a normal Pipeline Run and is
  // visible in the queue, rather than an attempt reference pointing at nothing.
  return {
    outcome: 'started',
    run: await recordAttempt(deps, run, input.nodeId, started.queueItemId, {
      startedAt: input.startedAt
    }),
    queueItemId: started.queueItemId
  };
}

/**
 * Append the child reference and persist it, or keep going without it.
 *
 * The enqueue has already happened by the time this runs, so a refused write is
 * not something to undo — the child is queued and will execute. What is lost is
 * the link from the connected run to it, which the warn records and which the
 * queue itself still shows. Rolling the enqueue back instead would be a
 * destructive write on a failure path that no operator confirmed, which is the
 * same stance the package-import rule takes.
 */
async function recordAttempt(
  deps: WorkflowLauncherDeps,
  run: ConnectedWorkflowRun,
  nodeId: string,
  queueItemId: string,
  attempt: { readonly startedAt: number }
): Promise<ConnectedWorkflowRun> {
  const next = appendAttempt(run, nodeId, { queueItemId, startedAt: attempt.startedAt });
  const written = await deps.connectedRuns.compareAndSetConnectedRun(next, run.revision);
  if (written.outcome === 'written') return written.run;
  deps.logger.warn(
    'workflow-launcher: child enqueued but the attempt reference was superseded; the queue item is unaffected'
  );
  return written.current ?? run;
}
