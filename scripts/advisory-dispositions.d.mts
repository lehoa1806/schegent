// Feature 249 (FR-R4-F21) — the declaration side of `advisory-dispositions.mjs`, so
// `typecheck:tests` can see the list reader and the application of a list without the script
// becoming TypeScript. Same arrangement as `gate-distance.d.mts`.
import type { ComparisonResult } from './advisory-compare.mjs';
import type { DispositionStatus, DispositionVerdict, TreeName } from './advisory-model.mjs';

/** One entry of a version-1 list, every field required and a non-empty string. */
export interface DispositionEntry {
  readonly advisory: string;
  readonly ecosystem: 'npm';
  readonly package: string;
  readonly tree: TreeName;
  readonly range: string;
  readonly status: DispositionStatus;
  readonly owner: string;
  /** `YYYY-MM-DD`. */
  readonly decidedOn: string;
  /** `YYYY-MM-DD`. An entry expires at 00:00:00Z on this day. */
  readonly expiresOn: string;
}

/** Why a named list cannot be used. `unreadable` is given by the caller for a path it could not read. */
export type DispositionDefect = 'unreadable' | 'over-bound' | 'malformed' | 'unsupported-format';

export type DispositionList =
  | { readonly state: 'read'; readonly entries: readonly DispositionEntry[] }
  | { readonly state: 'unusable'; readonly defect: DispositionDefect };

/** Read a list's text: its entries, or the defect that makes it unusable. */
export declare function parseDispositionList(text: string): DispositionList;

/**
 * A new result whose findings carry a disposition. Nothing else about it changes: no class, total,
 * reason or completeness. With no list the result is returned as it is.
 */
export declare function applyDispositions(
  result: ComparisonResult,
  list: DispositionList | { readonly state: 'not-supplied' } | null,
  evaluatedAt: string
): ComparisonResult;

/**
 * The finding shape `dispositionOf` reads. A caller with a different finding adapts it to this:
 * the identifiers, the package, the tree and the installed locations of one side.
 */
export interface DispositionSubject {
  readonly ids: { readonly canonical: string; readonly aliases: readonly string[] };
  readonly package: string;
  readonly tree: TreeName;
  readonly candidate?: { readonly locations: ReadonlyArray<{ readonly version: string }> };
  readonly base?: { readonly locations: ReadonlyArray<{ readonly version: string }> };
}

/** One related entry's own result, as `dispositionOf` returns it. */
export interface DispositionEntryResult {
  readonly advisory: string;
  readonly status: DispositionStatus;
  readonly owner: string;
  readonly decidedOn: string;
  readonly expiresOn: string;
  readonly result: 'covers' | 'expired' | 'does-not-cover';
  readonly mismatch?: { readonly reason: 'other-tree' | 'range-excludes'; readonly versions?: readonly string[] };
}

/**
 * FR-R4-F09 (contract AR6) -- the verdict and related entries of one finding at `evaluatedMs`.
 * Exported with no change of behavior, so release preparation and the comparison share one
 * coverage rule.
 */
export declare function dispositionOf(
  finding: DispositionSubject,
  list: DispositionList,
  evaluatedMs: number
): { readonly verdict: DispositionVerdict; readonly entries: readonly DispositionEntryResult[] };
