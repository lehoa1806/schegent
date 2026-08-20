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

import type { CatalogKind } from '../contracts/catalog-store';
import type { CatalogVersionRef } from '../contracts/catalog-version';
import type { RunProvenance } from './ports';

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
 * The reader retention consults before pruning a version (FR-037).
 *
 * @param enumeratePlans Yields the versions live runs froze. **Called on every
 *                       question, never snapshotted**: housekeeping asks once per
 *                       candidate and the queue drains while it walks, so a
 *                       remembered enumeration answers from a world that has
 *                       already moved.
 */
export function createQueueRunProvenance(
  enumeratePlans: () => Iterable<RunVersionCarrier>
): RunProvenance {
  return {
    async isReferenced(kind: CatalogKind, id: string, versionId: string): Promise<boolean> {
      for (const plan of enumeratePlans()) {
        const frozen = plan.catalogVersion;
        // Absence is "not recorded" (FR-027), never a wildcard: one legacy plan
        // matching everything would switch retention off for the whole catalog.
        if (frozen === undefined) continue;
        // All three parts, because the store permits a Pipeline and a Workflow to
        // share an id — `(pipeline, X, v4)` and `(workflow, X, v4)` are two
        // versions and an exemption earned by one does not cover the other.
        if (frozen.kind === kind && frozen.id === id && frozen.versionId === versionId) {
          return true;
        }
      }
      return false;
    }
  };
}
