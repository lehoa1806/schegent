// Feature 102 (T049, US6 — FR-033) — which runs are live, answered where the
// queue and the run map are.
//
// `createQueueRunProvenance` compares versions and holds no opinion about which
// runs count; this is that opinion, and it is here rather than in `src/catalog/`
// because it is a rule about queue and Run lifecycle, which the catalog is not
// allowed to learn (FR-057, `tests/lint/catalog-purity.test.ts`).
//
// **Live means not terminal.** Not "currently draining", not "in flight". A Task
// the operator submitted and the host froze a version for will execute that
// version when its turn comes, whether it is pending, paused, or in flight at the
// instant housekeeping walks. Narrowing to the draining one would prune the body
// out from under everything still waiting — a defect that hides perfectly,
// because the queue usually is draining while anyone is watching.
//
// **Both carriers, because there are two.** A queue item carries the version on
// the plan it froze (T035); a Run carries it on the pipeline snapshot it is
// executing (T037). A connected Run freezes each member Pipeline as it starts, so
// its snapshot can name a version no queue item's plan does.
//
// **Connected runs are deliberately absent.** They record no lifecycle at all —
// `deleteConnectedRuns()` removes the record because there is no status to set —
// so nothing about one ever becomes terminal, and enumerating them would exempt
// their versions until the queue itself is deleted. The Run they belong to is
// enumerated here and does have a status, which is the same information with an
// end to it.
//
// Completed history is out of scope until the run-history surface adds durable
// history (FR-034). A finished Task's version becomes an ordinary retention
// candidate, which is what makes the bound reachable on a workspace that has run
// anything.

import type { RunVersionCarrier } from '../catalog/run-provenance-queue';
import { isTerminalRequestStatus } from '../queue/feature-request';
import { isTerminalRunStatus } from '../state/workflow-run';

/** A queue item, reduced to what liveness and provenance read. */
interface EnumerableRequest {
  readonly status: string;
  readonly runPlan?: RunVersionCarrier;
}

/** A Run, reduced to the same two things. */
interface EnumerableRun {
  readonly status: string;
  readonly pipeline?: RunVersionCarrier;
}

/**
 * Every version an accepted, non-terminal run has frozen.
 *
 * @param requests Every queue's Tasks, terminal ones included — they are filtered
 *                 here so the caller does not have to know the rule.
 * @param runs     Every Run in the run map, likewise unfiltered.
 */
export function liveRunPlans(
  requests: Iterable<EnumerableRequest>,
  runs: Iterable<EnumerableRun>
): readonly RunVersionCarrier[] {
  const live: RunVersionCarrier[] = [];
  for (const request of requests) {
    if (isTerminalRequestStatus(request.status)) continue;
    if (request.runPlan !== undefined) live.push(request.runPlan);
  }
  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) continue;
    if (run.pipeline !== undefined) live.push(run.pipeline);
  }
  return live;
}
