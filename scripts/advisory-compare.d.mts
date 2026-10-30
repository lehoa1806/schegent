// Feature 249 (FR-R4-F21) — the declaration side of `advisory-compare.mjs`, so `typecheck:tests` can
// see base selection and the comparison without the script becoming TypeScript. Same arrangement as
// `gate-distance.d.mts`.
//
// The signatures are fixed here, once, with every input the later stories need (the four captures,
// both lockfile sets, the selected base, the evaluation time and a blob seam), so adding validation
// or further classification rows changes only the module's body. The result types are written with
// open `string` codes where the module's code sets are closed in `advisory-model.mjs`: a result is
// read by the record and the report, which print a code and never branch on one they do not know.
import type { AdvisoryIds, CaptureLocation } from './advisory-model.mjs';

/** `git <args>`: the trimmed output, or `null` when git exits non-zero. */
export type GitSeam = (args: readonly string[]) => string | null;

export interface BaseRequest {
  /** The candidate, as a revision. Never begins with `-`. */
  readonly candidate: string;
  /** The target branch, `develop` when absent. Mutually exclusive with `base`. */
  readonly target?: string;
  /** An explicit base revision. */
  readonly base?: string;
}

/** What `selectBase` chose, or why it chose nothing. */
export interface BaseSelection {
  /** The full commit id, or `null` when no base was selected. */
  readonly commit: string | null;
  readonly rule: 'merge-base' | 'explicit';
  readonly target: string | null;
  /** `base-not-selected` when `commit` is `null`. */
  readonly reason?: 'base-not-selected';
  /** `target-missing`, `no-merge-base`, `several-merge-bases` or `base-unresolved`. */
  readonly detail?: string;
}

/**
 * A capture file as the CLI hands it over: its text, or the fact that it was over the read bound or
 * could not be read. Absent (`undefined` or `null`) means the operator named none.
 */
export type CaptureInput =
  | { readonly text: string }
  | { readonly overBound: true }
  | { readonly unreadable: true };

/** A parsed lockfile. Only `packages` is read, and only its `version` and `name`. */
export interface LockfileInput {
  readonly lockfileVersion?: unknown;
  readonly packages?: Readonly<Record<string, { readonly version?: string; readonly name?: string }>>;
}

export interface PerSide<T> {
  readonly base?: T | null;
  readonly candidate?: T | null;
}

export interface CompareInput {
  readonly candidate: { readonly commit: string };
  readonly base: BaseSelection;
  readonly captures: Partial<Record<string, PerSide<CaptureInput>>>;
  readonly lockfiles: Partial<Record<string, PerSide<LockfileInput>>>;
  /** The evaluation time, `YYYY-MM-DDTHH:MM:SS(.sss)?Z`. */
  readonly evaluatedAt: string;
  /** `git rev-parse <commit>:<path>`, or `null` when the path is absent at the commit. */
  readonly blobAt: (commit: string, path: string) => string | null;
}

export interface PairRef {
  readonly location: string;
  readonly version: string;
}

export interface ClassReason {
  readonly code: string;
  readonly pairs?: readonly PairRef[];
}

export interface SideView {
  readonly locations: readonly CaptureLocation[];
  readonly direct: boolean;
  readonly production: boolean;
}

export interface DispositionEntryResult {
  readonly [key: string]: unknown;
}

export interface FindingDisposition {
  readonly verdict: string;
  readonly entries: readonly DispositionEntryResult[];
}

/** One finding after grouping and classification, in the contract's key order (K3). */
export interface ClassifiedFinding {
  readonly class: string;
  /** Present only on a finding of an incomplete tree: the sides it was read from. */
  readonly sides?: readonly string[];
  readonly tree: string;
  readonly package: string;
  readonly ids: AdvisoryIds;
  readonly severity: { readonly base: string | null; readonly candidate: string | null };
  readonly base: SideView | null;
  readonly candidate: SideView | null;
  readonly reasons: readonly ClassReason[];
  readonly notes: readonly string[];
  readonly title: string;
  readonly dependents: readonly string[];
  readonly disposition: FindingDisposition;
}

/** A capture's subject and provenance, never its findings. */
export interface Provenance {
  readonly commit: string;
  readonly objectFormat: string;
  readonly manifest: { readonly path: string; readonly blob: string | null };
  readonly lockfile: { readonly path: string; readonly blob: string | null };
  readonly tool: string;
  readonly toolVersion: string;
  readonly command: string;
  readonly registryHost: string;
  readonly observedAt: string;
  readonly reportFormat: string;
  readonly outcome: {
    readonly status: string;
    readonly reason?: string;
    readonly statusCode?: number;
    readonly bound?: string;
  };
  readonly limitations: readonly string[];
}

export interface TreeReason {
  readonly code: string;
  readonly side?: string;
  readonly detail?: string;
}

/** A reason in the overall list, with the tree it belongs to, or `null` for one about every tree. */
export interface ResultReason extends TreeReason {
  readonly tree: string | null;
}

/** The count of each class. */
export type Totals = Readonly<Record<string, number>>;

export interface TreeResult {
  readonly tree: string;
  readonly complete: boolean;
  readonly reasons: readonly TreeReason[];
  readonly base: Provenance | null;
  readonly candidate: Provenance | null;
  /** The count per class when complete, otherwise `null`. */
  readonly totals: Totals | null;
  readonly findings: readonly ClassifiedFinding[];
}

export interface ComparisonResult {
  readonly complete: boolean;
  readonly reasons: readonly ResultReason[];
  /** The count per class when every tree is complete, otherwise `null`: not determined, never zero. */
  readonly totals: Totals | null;
  readonly trees: readonly TreeResult[];
}

/**
 * Select the base commit of a candidate. Throws for a candidate or target that is an option or a
 * name git rejects, which the caller refuses first; every way of finding no base is a result.
 */
export declare function selectBase(request: BaseRequest, git: GitSeam): BaseSelection;

/** Compare both trees' base and candidate captures into classified findings, per tree and overall. */
export declare function compareTrees(input: CompareInput): ComparisonResult;
