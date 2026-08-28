// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Pure reducers over a queue snapshot. No I/O, no timers, no processes.

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
// **Completed history is the second source** (feature 103, T077, FR-040). Feature
// 102 left it out because there was no durable history to read, and said so here.
// There is now, and the gap that comment described turned out to be visible: a
// finished run's version became an ordinary retention candidate the instant the
// run ended, while the row recording it stayed on the surface for another fifty
// runs — long enough for an operator to open a row and find the definition behind
// it already pruned. `retainedHistoryPlans` closes that, and the per-queue history
// cap is what keeps it bounded: the pin lasts exactly as long as the row does.
//
// Both functions take what they read rather than reaching for it, so neither
// caches and the caller cannot accidentally hoist the read out of the thunk.

import type { RunVersionCarrier } from '../catalog/run-provenance-queue';
import type { CatalogVersionRef } from '../contracts/catalog-version';
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
 * A completed run in history, reduced to the one field the pin set reads.
 *
 * No status here, and that is the difference between the two sources. Liveness is
 * a question you ask a queue item; a history row has already answered it, and the
 * only thing that ends its pin is leaving the store. `HistoryRecord` satisfies
 * this structurally, so the caller passes `HistoryStore.list()` unchanged.
 */
interface EnumerableHistoryEntry {
  readonly catalogVersion?: CatalogVersionRef;
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

/**
 * Every version a retained history row recorded (FR-040).
 *
 * No filtering by status, by age, or by queue. A row that is still in the store
 * is still on the surface, and every one of those is a row whose definition an
 * operator can open — which is the whole claim FR-040 makes. Adding a second rule
 * here would be a second retention policy free to disagree with the per-queue cap
 * that is already the only one (FR-044, FR-045).
 *
 * @param entries `HistoryStore.list()`, read fresh by the caller on every
 *                question. Passing the rows rather than the store is what makes
 *                that the caller's visible responsibility instead of a detail
 *                buried in here (FR-042).
 */
export function retainedHistoryPlans(
  entries: Iterable<EnumerableHistoryEntry>
): readonly RunVersionCarrier[] {
  const pinned: RunVersionCarrier[] = [];
  for (const entry of entries) {
    // Rows written before provenance existed record nothing, and "nothing" pins
    // nothing — dropping them here keeps the matcher from having to decide.
    if (entry.catalogVersion !== undefined) pinned.push({ catalogVersion: entry.catalogVersion });
  }
  return pinned;
}
