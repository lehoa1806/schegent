// Feature 099 (FR-R3-015) T485a — the run-provenance exemption, before there is
// any run provenance to consult (FR-037).
//
// Retention must never prune a version a retained run references. This feature has
// nothing to ask: run history arrives with FR-R3-018. The exemption is nonetheless
// written, wired, and tested now, against this implementation, because the
// alternative — adding the exemption later, when there is finally data behind it —
// means the retention walk ships once without it and the first version it wrongly
// prunes is a version a run's provenance pointed at.
//
// Answering `false` for everything is exactly today's behaviour: no runs are
// recorded, so no version is referenced. It is not a stub standing in for missing
// work; it is the correct answer for the current state of the system, and
// FR-R3-018 replaces the module without touching the walk.

import type { CatalogKind } from '../contracts/catalog-store';
import type { RunProvenance } from './ports';

/** Nothing is referenced, because nothing records references yet. Replaced by FR-R3-018. */
export const runProvenanceNone: RunProvenance = {
  async isReferenced(_kind: CatalogKind, _id: string, _versionId: string): Promise<boolean> {
    return false;
  }
};
