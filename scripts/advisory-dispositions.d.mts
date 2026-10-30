// Feature 249 (FR-R4-F21) — the declaration side of `advisory-dispositions.mjs`, so
// `typecheck:tests` can see the list reader and the application of a list without the script
// becoming TypeScript. Same arrangement as `gate-distance.d.mts`.
import type { ComparisonResult } from './advisory-compare.mjs';
import type { DispositionStatus, TreeName } from './advisory-model.mjs';

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
