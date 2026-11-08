// Feature 089 T005 — continuing a run, below the host seam.
//
// Everything `cmd-continue-workflow.ts` did apart from resolving the workspace
// root and acknowledging the answer now lives here, so the headless entrypoint
// reaches the same gates through the same code rather than through a second
// implementation of them (FR-003, FR-004). Gates 2-7 were already in
// `workflow-launcher.ts` and are untouched; what moved is gate 1, the
// launcher-result to wire-result mapping, and the projection both refusal arms
// carry.
//
// Gate 1 moved rather than staying in the adapter (an amendment to T006's
// wording, recorded in `tasks.md`): `run-not-found` is an outcome the parity
// suite compares, and a gate implemented once per adapter is exactly the second
// implementation FR-003 exists to prevent.
//
// Like its launch sibling, a continuation reads NO catalog. Everything resolves
// from the run's own frozen snapshot (FR-003, FR-004 of feature 088), so a
// Pipeline edited, reordered, or deleted since the launch cannot reach a run
// already underway — there is nothing here to resolve it against.
//
// This module imports no `vscode` and holds no host API. The workspace root and
// the clock arrive as input, as `workflow-launcher.ts` already requires them to,
// and the projector arrives by reference — see `ContinuationDeps`.

import type {
  ConnectedRunProjection,
  ContinueWorkflowPayload,
  ContinueWorkflowResult
} from '../../contracts/sidebar-ipc';
import { resolveBoundQueueId, type ConnectedWorkflowRun } from '../../state/connected-workflow-run';
import type { ChildRunStateReader } from '../../ui/sidebar/connected-run-projector';
import {
  continueWaitingHandoff,
  type ContinueWaitingHandoffDeps,
  type ContinueWaitingHandoffInput,
  type ContinueWaitingHandoffResult
} from './continuation-composer';
import type { NodeRunStartDeps } from './node-run-starter';
import { phaseDispatchResultOf, startPhaseAttempt } from './phase-attempt-start';
import {
  ControlCommandService,
  type ControlCommandServiceDeps
} from './control-command-service';
import { WorkflowControlService } from './workflow-control-service';
import type { WorkflowLeafControlHooks } from './workflow-leaf-control';
import { continueWorkflow, type ConnectedRunWriter } from './workflow-launcher';

export {
  continueWaitingHandoff,
  type ContinueWaitingHandoffDeps,
  type ContinueWaitingHandoffInput,
  type ContinueWaitingHandoffResult
};

/**
 * The connected-run store, as a continuation needs it: read one run, read a
 * child's state, and write with a compare-and-set (FR-046).
 *
 * `ConnectedRunPort` in `ui/sidebar/commands/router-types.ts` satisfies this
 * structurally, so the sidebar wires nothing new.
 */
export interface ConnectedRunStore extends ConnectedRunWriter {
  get(connectedRunId: string): ConnectedWorkflowRun | null;
  readonly readChildState: ChildRunStateReader;
}

export interface ContinuationDeps extends NodeRunStartDeps {
  /**
   * Optional on the same terms it is on `RouterDeps`: a window with no launcher
   * wired is a legitimate state, answered as a queue refusal below rather than
   * as a crash.
   */
  readonly connectedRuns?: ConnectedRunStore;
  /**
   * What a Pause or Cancel needs from the window that runs it: stopping the leaf, its countdown,
   * and the fence. Optional because a caller with no controller, the headless entrypoint, has no
   * leaf of its own to stop.
   */
  readonly workflowControlHooks?: WorkflowLeafControlHooks;
  /**
   * Offers a queue its work once a command has queued a leaf on it. The drain is edge-triggered and
   * a command has no driver on the stack, so nothing else would. Optional for the same reason as the
   * hooks above: the headless entrypoint has no drain to offer it to.
   */
  readonly wakeWorkflowQueue?: (queueId: string) => void;
  /**
   * Takes the failed rows a Workflow's Retry answers off the queue. Optional like the hooks above: a
   * headless caller that omits it leaves the new attempt waiting behind the failed row, and on a
   * `halt-on-failure` queue that row reports the halt.
   */
  readonly retireWorkflowFailures?: (run: ConnectedWorkflowRun) => Promise<void>;
  /**
   * The projector's two functions, passed **by reference** rather than as
   * closures over the reader.
   *
   * Injected for the reason `workflow-launcher.ts` already injects eligibility:
   * the fold over recorded decisions belongs to `connected-run-projector.ts`,
   * and deriving it a second time is how the host and the view come to disagree.
   * By reference rather than pre-bound because binding `readChildState` is this
   * service's job — an adapter that had to write the closure itself would be
   * writing the one line that could differ between the two adapters.
   *
   * A value import would be the first `services/` → `ui/` runtime dependency in
   * the repo; every existing one is type-only, and `ChildRunStateReader` above
   * keeps it that way.
   */
  readonly projectRun: (
    run: ConnectedWorkflowRun,
    readChildState: ChildRunStateReader
  ) => ConnectedRunProjection;
  readonly isNodeStartable: (
    run: ConnectedWorkflowRun,
    nodeId: string,
    readChildState: ChildRunStateReader
  ) => boolean;
  /**
   * FR-R5-F31 — optional candidate-block control command service (or deps)
   * shared between the editor `CMD_CONTINUE_WORKFLOW` handler and the headless
   * workflow-run adapter.
   */
  readonly controlCommandService?: ControlCommandService;
  readonly controlCommandServiceDeps?: ControlCommandServiceDeps;
}

export interface ContinuationInput {
  readonly payload: ContinueWorkflowPayload;
  /** Resolved by the caller; `null` means no folder is open. */
  readonly workspaceRoot: string | null;
  readonly startedAt: number;
}

/** A window with nothing to continue against. */
const LAUNCHER_UNAVAILABLE: ContinueWorkflowResult = {
  outcome: 'rejected-queue',
  reason: 'queue-refused',
  detail: 'launcher-unavailable'
};

/**
 * The projection a refusal carries, or the run-not-found arm when there is nothing
 * left to project.
 *
 * `rejected-stale` reports the *authoritative* record — the one the store holds
 * now, not the one the caller addressed — because the whole point of the arm is to
 * tell a view built on a superseded snapshot what is actually true. A run that has
 * disappeared between gate 1 and gate 2 has no authoritative record, so it is
 * reported as `run-not-found`: the same answer gate 1 would have given a moment
 * earlier, rather than a projection of a run the operator can no longer act on.
 */
function staleResult(
  deps: ContinuationDeps,
  runs: ConnectedRunStore,
  current: ConnectedWorkflowRun | null
): ContinueWorkflowResult {
  if (current === null) return { outcome: 'rejected-run', reason: 'run-not-found' };
  return { outcome: 'rejected-stale', projection: deps.projectRun(current, runs.readChildState) };
}

/**
 * Gate 1, the launcher call, and the mapping of its answer onto the wire.
 *
 * Every arm the wire declares is produced here, which is what lets the Phase 5
 * parity suite compare the two adapters outcome-for-outcome.
 */
export async function continueConnectedRun(
  deps: ContinuationDeps,
  input: ContinuationInput
): Promise<ContinueWorkflowResult> {
  if (input.payload.controlCommand !== undefined) {
    const commandService =
      deps.controlCommandService ??
      (deps.controlCommandServiceDeps !== undefined
        ? new ControlCommandService(deps.controlCommandServiceDeps)
        : undefined);
    if (commandService !== undefined) {
      const acknowledgement = await commandService.executeControlCommand(
        input.payload.controlCommand
      );
      return {
        outcome: 'control-acknowledged',
        acknowledgement
      };
    }
  }

  const runs = deps.connectedRuns;
  if (runs === undefined) return LAUNCHER_UNAVAILABLE;

  // Gate 1.
  const run = runs.get(input.payload.connectedRunId);
  if (run === null) return { outcome: 'rejected-run', reason: 'run-not-found' };

  if (input.payload.operation !== undefined) {
    const controlService = new WorkflowControlService({
      connectedRuns: runs,
      dispatchPhase: async (phaseInput) => {
        if (run.frozenClosure === undefined) {
          return { outcome: 'rejected', reason: 'missing-closure' };
        }
        return phaseDispatchResultOf(
          await startPhaseAttempt(deps, phaseInput, input.workspaceRoot, { continuesWorkflow: true })
        );
      },
      ...deps.workflowControlHooks
    });
    const outcome = await controlService.executeCommand({
      runId: run.connectedRunId,
      commandId:
        input.payload.commandId ??
        `${run.connectedRunId}:${input.payload.operation}:${input.payload.expectedRevision}`,
      expectedRevision: input.payload.expectedRevision,
      operation: input.payload.operation,
      ...(input.payload.invocationId !== undefined
        ? { targetInvocationId: input.payload.invocationId }
        : {}),
      targetNodeId: input.payload.nodeId,
      continuationRequest: input.payload.request,
      now: input.startedAt
    });
    if (outcome.accepted) {
      // After the commit, because a refused Retry leaves its failed row standing, and before the wake,
      // because the drain reads that row. Not on a replay: a failure that came after the first delivery
      // is not one this Retry answered.
      const answersFailures =
        input.payload.operation === 'retry-phase' || input.payload.operation === 'retry-invocation';
      if (answersFailures && !outcome.idempotentReplay) {
        await deps.retireWorkflowFailures?.(outcome.run);
      }
      if (outcome.receipt.spawnedAttemptId !== undefined) {
        deps.wakeWorkflowQueue?.(resolveBoundQueueId(outcome.run));
      }
      return {
        outcome: 'started',
        revision: outcome.run.revision,
        queueItemId: outcome.receipt.spawnedAttemptId ?? outcome.receipt.targetInvocationId
      };
    }
    if (outcome.refusalCode === 'run-not-found') {
      return { outcome: 'rejected-run', reason: 'run-not-found' };
    }
    if (outcome.refusalCode === 'stale-revision') {
      return staleResult(deps, runs, outcome.run);
    }
    return {
      outcome: 'rejected-state',
      reason:
        outcome.refusalCode === 'active-descendant-blocks-retry'
          ? 'child-not-terminal'
          : 'node-not-eligible',
      projection: deps.projectRun(outcome.run ?? run, runs.readChildState)
    };
  }

  const continued = await continueWorkflow(
    {
      ...deps,
      connectedRuns: runs,
      isChildSettled: (queueItemId) => runs.readChildState(queueItemId) !== 'in-flight'
    },
    {
      run,
      expectedRevision: input.payload.expectedRevision,
      nodeId: input.payload.nodeId,
      request: input.payload.request,
      workspaceRoot: input.workspaceRoot,
      startedAt: input.startedAt,
      isNodeStartable: (current, nodeId) =>
        deps.isNodeStartable(current, nodeId, runs.readChildState)
    }
  );

  if (continued.outcome === 'started') {
    return {
      outcome: 'started',
      revision: continued.run.revision,
      queueItemId: continued.queueItemId
    };
  }
  if (continued.outcome === 'rejected-stale') return staleResult(deps, runs, continued.current);
  if (continued.outcome === 'rejected-state') {
    return {
      outcome: 'rejected-state',
      reason: continued.reason,
      projection: deps.projectRun(continued.run, runs.readChildState)
    };
  }
  if (continued.outcome === 'rejected-definition') {
    // The wire narrows this arm to the two conditions a continuation can actually
    // reach. `workflow-not-found`, `workflow-invalid`, and `node-not-startable` are
    // launch-time refusals about the *catalog*, and a continuation reads none — so
    // a run whose frozen graph somehow produced one is a host defect, reported as a
    // queue refusal rather than widened into the wire's vocabulary.
    if (continued.reason === 'pipeline-mismatch' || continued.reason === 'no-workspace-root') {
      return { outcome: 'rejected-definition', reason: continued.reason };
    }
    deps.logger.warn(
      `continuation-service: launcher refused a continuation as ${continued.reason}, which a frozen run cannot reach`
    );
    return LAUNCHER_UNAVAILABLE;
  }
  return continued;
}
