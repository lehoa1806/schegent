// Feature 099 (FR-R3-015) T485 — the 50-version bound and its exemptions (FR-034-FR-038).
//
// Pure and separately testable, which is what lets the exemptions be proven against
// a stub before the data behind them exists: FR-R3-018 supplies the real run
// provenance, and this feature ships one that answers `false` for everything.
//
// The clause most easily got wrong is FR-035a. Retention walks oldest-first and
// **advances past** an exempt version to the next eligible one — it does not stop at
// the first exemption. Stopping would let one run-referenced old version hold an
// unbounded history open, and the difference is invisible in the common case where
// nothing is exempt.
//
// Three exemptions, and they are not the same kind of thing:
//
//   - **active** (FR-036) is decidable from the manifest alone, and is checked first
//     because it costs nothing.
//   - **draft** (feature 100, FR-021) is decidable the same way. Feature 099 already
//     exempted the draft pointer and reported it as `active`, which was harmless
//     while the pointer was inert and is wrong now that FR-021 makes the reported
//     reason observable. Only the label moves; the pruning logic is untouched.
//   - **run-referenced** and **history-referenced** (FR-037, feature 103 FR-040) are
//     a port call, so they are asked only about versions that are otherwise about to
//     be pruned. Asking about all 50 would make every save pay for a question about
//     versions nothing was going to touch. The port names which of the two it found,
//     and this walk reports that name rather than choosing one: the difference is
//     when the version is released — a live run ends, a history row is evicted — and
//     only the port knows which happened.

import { CATALOG_RETENTION_BOUND, type CatalogManifestEntry } from '../contracts/catalog-store';
import type { ReferenceExemption } from './ports';

export type RetentionExemption = 'active' | 'draft' | ReferenceExemption;

export interface RetentionPlan {
  /** Version ids to remove, oldest first. Empty when nothing is over the bound or all is exempt. */
  readonly remove: readonly string[];
  readonly retained: readonly string[];
  readonly exempt: readonly { readonly versionId: string; readonly why: RetentionExemption }[];
}

/**
 * What to prune for one definition.
 *
 * `isReferenced` is the `RunProvenance` port narrowed to this definition, so the
 * plan is a pure function of the entry plus one predicate — testable with a stub
 * that names the exempt ids directly. It answers with the reason rather than a
 * bare `true`, and that reason is copied into the plan unexamined.
 */
export async function planRetention(
  entry: CatalogManifestEntry,
  isReferenced: (versionId: string) => Promise<ReferenceExemption | false>,
  bound: number = CATALOG_RETENTION_BOUND
): Promise<RetentionPlan> {
  const total = entry.versions.length;
  if (total <= bound) {
    return { remove: [], retained: entry.versions.map((version) => version.versionId), exempt: [] };
  }

  const overBound = total - bound;
  const remove: string[] = [];
  const exempt: { versionId: string; why: RetentionExemption }[] = [];

  // Oldest first — which is the stored order (FR-018), so no sort is needed.
  for (const version of entry.versions) {
    if (remove.length === overBound) break;

    if (version.versionId === entry.activeVersionId) {
      exempt.push({ versionId: version.versionId, why: 'active' });
      continue;
    }
    // Live since feature 100. A pending draft is work in progress that nothing else
    // holds a copy of, so pruning it would discard an edit the operator has not
    // published and cannot recover (FR-021).
    if (version.versionId === entry.draftVersionId) {
      exempt.push({ versionId: version.versionId, why: 'draft' });
      continue;
    }
    const referenced = await isReferenced(version.versionId);
    if (referenced) {
      exempt.push({ versionId: version.versionId, why: referenced });
      continue;
    }

    remove.push(version.versionId);
  }

  const removing = new Set(remove);
  return {
    remove,
    retained: entry.versions
      .map((version) => version.versionId)
      .filter((versionId) => !removing.has(versionId)),
    exempt
  };
}

/**
 * The entry after a prune.
 *
 * Version ids are **never renumbered** (FR-005): a definition pruned down to
 * `v41`-`v90` keeps those ids, and the next save is `v91`.
 */
export function withVersionsRemoved(
  entry: CatalogManifestEntry,
  removed: readonly string[]
): CatalogManifestEntry {
  if (removed.length === 0) return entry;
  const gone = new Set(removed);
  return {
    ...entry,
    versions: entry.versions.filter((version) => !gone.has(version.versionId))
  };
}
