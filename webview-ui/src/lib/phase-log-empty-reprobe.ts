// Feature 020 BUG-004 (T093, FR-029a) — bounds automatic `store.reload()` checks
// when an in-flight Phase initially returned zero recorded iterations.
//
// Each phase-log read request appends a `phase-log-read` audit row on the host, which
// updates `snapshot.auditTail` and pushes a fresh `WorkflowSnapshot`. Reloading on
// every new `WorkflowSnapshot` reference created an unbounded ~9 Hz loop while
// `iterations` stayed empty. Allow at most one immediate snapshot re-probe per
// `(queueId, taskId, phaseId)` tuple and thereafter reload only when the Run's own
// activity, liveness, or phase-progression state advances.

import type { QueueItem, WorkflowSnapshot } from './snapshot-types';

export interface EmptyIterationReprobeArgs {
  readonly snapshot: WorkflowSnapshot;
  readonly loading: boolean;
  readonly isEmptyAwaitingOutput: boolean;
  readonly selection: {
    readonly queueId: string | null;
    readonly taskId: string | null;
    readonly phaseId: string | null;
  };
  readonly tailInFlight: QueueItem | null;
}

function deriveRunActivitySignature(
  snapshot: WorkflowSnapshot,
  queueId: string | null,
  taskId: string | null
): string {
  if (taskId === null) return '';
  const { queues } = snapshot;
  const runtime =
    (queueId !== null ? queues.find((q) => q.queueId === queueId) : undefined) ??
    queues.find((q) => q.inFlightRun?.feature?.id === taskId) ??
    null;
  const activeRun = runtime === null ? null : runtime.inFlightRun;
  const phaseSig = (runtime === null ? [] : runtime.phases)
    .map((p) => `${p.name}:${p.state}:${p.iteration}`)
    .join(',');
  return [
    activeRun === null ? '' : (activeRun.liveActivity.lastEventAt ?? ''),
    activeRun === null ? '' : (activeRun.liveActivity.summary ?? ''),
    activeRun?.liveness?.lastActivityAt ?? '',
    phaseSig
  ].join('|');
}

export interface EmptyIterationReprobeGate {
  shouldReload(args: EmptyIterationReprobeArgs): boolean;
}

export function createEmptyIterationReprobeGate(): EmptyIterationReprobeGate {
  let lastSnapshot: WorkflowSnapshot | null = null;
  let trackedTupleKey: string | null = null;
  let immediateProbesUsed = 0;
  let lastActivitySignature: string | null = null;

  return {
    shouldReload(args: EmptyIterationReprobeArgs): boolean {
      const prev = lastSnapshot;
      lastSnapshot = args.snapshot;

      const matchesInFlight =
        args.tailInFlight !== null &&
        args.selection.taskId !== null &&
        args.selection.phaseId !== null &&
        args.tailInFlight.id === args.selection.taskId &&
        args.tailInFlight.currentPhase === args.selection.phaseId;

      const tupleKey = matchesInFlight
        ? `${args.selection.queueId ?? ''}:${args.selection.taskId}:${args.selection.phaseId}`
        : null;
      const activitySignature = deriveRunActivitySignature(
        args.snapshot,
        args.selection.queueId,
        args.selection.taskId
      );

      if (tupleKey !== trackedTupleKey) {
        trackedTupleKey = tupleKey;
        immediateProbesUsed = 0;
        lastActivitySignature = activitySignature;
        return false;
      }

      if (!args.loading && !args.isEmptyAwaitingOutput) {
        immediateProbesUsed = 0;
        lastActivitySignature = activitySignature;
        return false;
      }

      if (
        args.loading ||
        !args.isEmptyAwaitingOutput ||
        prev === null ||
        prev === args.snapshot ||
        !matchesInFlight
      ) {
        return false;
      }

      if (activitySignature !== lastActivitySignature) {
        lastActivitySignature = activitySignature;
        return true;
      }

      if (immediateProbesUsed < 1) {
        immediateProbesUsed += 1;
        return true;
      }

      return false;
    }
  };
}
