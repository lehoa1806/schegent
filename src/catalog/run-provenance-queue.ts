// Feature 102 (T049, US6 — FR-033, FR-037) — the run-provenance exemption, now
// that runs record a version to be exempt about.
//
// Feature 099 wrote the exemption against a reader that answered `false` for
// everything, because nothing recorded a version then. T035 stamps one on
// every frozen plan and T037 stamps one on every Run's pipeline snapshot, so the
// question retention has been asking all along finally has an answer, and this
// module is it. The retention walk is untouched: it asked the port before and it
// asks the port now.
//
// **A callback, not a queue import.** `src/catalog/` does not learn about
// `src/queue/` or about run state — `tests/lint/catalog-purity.test.ts` would
// refuse it, and the rule that lint enforces is the reason the port exists. What
// crosses the boundary is one function that yields records, and what this module
// knows about those records is one optional field.
//
// **Which runs are live is not this module's opinion.** The caller decides, and
// `src/activation/run-provenance-enumeration.ts` is where that decision lives,
// beside the queue and the run map it reads. Filtering here would put a rule
// about queue lifecycle inside the catalog, which is the coupling the port was
// built to avoid.

// **Two sources since feature 103 (T078, FR-040).** A version is held open by a
// live run *or* by a run that finished and is still in history, and the module
// name has not moved with the meaning — it still says "queue". Renaming it here
// would be a drive-by refactor inside another story's phase; the name is recorded
// as a deviation instead, and what the module actually is is stated in this
// paragraph.
//
// **No cache, deliberately.** Both enumerations are called on every question, and
// the second one re-reads durable history each time. That is the entire
// enforcement of FR-042: a version must stop being exempt on the very next prune
// after its row is evicted, and any memo — per pass, per definition, per
// housekeeping run — puts a step in between.

import type { CatalogKind } from '../contracts/catalog-store';
import type { CatalogVersionRef } from '../contracts/catalog-version';
import type { ReferenceExemption, RunProvenance } from './ports';

/**
 * One live run, reduced to the only thing provenance reads off it.
 *
 * Stated as this shape rather than as `FrozenRunPlan` because the version has
 * two carriers and both are live: a queue item carries it on the plan it froze
 * (T035), and a Run carries it on the pipeline snapshot it is executing (T037).
 * A `FrozenRunPlan`-only signature would mean wrapping the second in a synthetic
 * envelope, which `tests/lint/no-envelope-reconstruction.test.ts` forbids for a
 * good reason and which would be a lie about where the value came from.
 *
 * `FrozenRunPlan` satisfies this structurally, so a caller enumerating plans
 * passes them unchanged.
 */
export interface RunVersionCarrier {
  readonly catalogVersion?: CatalogVersionRef;
}

/**
 * The reader retention consults before pruning a version (FR-037, FR-040).
 *
 * @param enumeratePlans    Yields the versions live runs froze. **Called on every
 *                          question, never snapshotted**: housekeeping asks once
 *                          per candidate and the queue drains while it walks, so a
 *                          remembered enumeration answers from a world that has
 *                          already moved.
 * @param enumerateRetained Yields the versions recorded by runs that have finished
 *                          and are still in history, under the same rule. Optional
 *                          and defaulted to nothing, because the store is built
 *                          before the history store exists and a caller with no
 *                          history yet should get the same reader with one source
 *                          rather than a different reader.
 */
export function createQueueRunProvenance(
  enumeratePlans: () => Iterable<RunVersionCarrier>,
  enumerateRetained: () => Iterable<RunVersionCarrier> = () => []
): RunProvenance {
  return {
    async isReferenced(
      kind: CatalogKind,
      id: string,
      versionId: string
    ): Promise<ReferenceExemption | false> {
      // Live first. When both hold the version the live run is the truer answer:
      // it releases sooner, and it is the event an operator waiting to prune would
      // watch for. History takes over at that moment without the version ever
      // becoming prunable in between, which is FR-040's handover.
      if (matches(enumeratePlans(), kind, id, versionId)) return 'run-referenced';
      if (matches(enumerateRetained(), kind, id, versionId)) return 'history-referenced';
      return false;
    }
  };
}

/** Does any carrier in `carriers` name exactly this version? */
function matches(
  carriers: Iterable<RunVersionCarrier>,
  kind: CatalogKind,
  id: string,
  versionId: string
): boolean {
  for (const carrier of carriers) {
    const frozen = carrier.catalogVersion;
    // Absence is "not recorded" (FR-027), never a wildcard: one legacy plan
    // matching everything would switch retention off for the whole catalog.
    if (frozen === undefined) continue;
    // All three parts, because the store permits a Pipeline and a Workflow to
    // share an id — `(pipeline, X, v4)` and `(workflow, X, v4)` are two versions
    // and an exemption earned by one does not cover the other.
    if (frozen.kind === kind && frozen.id === id && frozen.versionId === versionId) {
      return true;
    }
  }
  return false;
}
