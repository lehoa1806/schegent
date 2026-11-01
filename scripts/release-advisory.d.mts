// FR-R4-F09 (contract AR1 to AR7; TA5) -- the declaration side of `release-advisory.mjs`, so
// `typecheck:tests` and the release driver can see the evaluation function and its result. Trees,
// severities and verdicts are feature 249's, imported rather than restated.
import type { DispositionVerdict, Severity, TreeName } from './advisory-model.mjs';

/** The freshness budget, in days. Inclusive: a capture exactly this old is accepted. */
export declare const RELEASE_ADVISORY_BUDGET_DAYS: 7;

/** The tracked disposition list, relative to the repository root. */
export declare const DISPOSITIONS_PATH: string;

export type ReleaseAdvisoryReason =
  | 'advisory-capture-missing'
  | 'advisory-incomplete'
  | 'advisory-unavailable'
  | 'advisory-lockfile-mismatch'
  | 'advisory-observed-after-now'
  | 'advisory-stale'
  | 'dispositions-unusable';

/** The seven refusal reasons, in the order they are checked. */
export declare const RELEASE_ADVISORY_REASONS: readonly ReleaseAdvisoryReason[];

export type AdvisoryCompleteness = 'complete' | 'unavailable' | 'incomplete';
export type FindingUsage = 'shipped' | 'build-only' | 'unknown';

/** The packages a tree's module graph says were bundled, and the modules it could not map. */
export interface BundledSet {
  readonly installPaths?: readonly string[];
  readonly unmapped?: readonly string[];
}

export interface ReleaseAdvisoryInput {
  /** The text of each tree's capture file, or `undefined` when none was supplied or readable. */
  readonly captures: Readonly<Partial<Record<TreeName, string | undefined>>>;
  /** The git blob id HEAD holds for each tree's lockfile. */
  readonly lockBlobs: Readonly<Record<TreeName, string>>;
  /** The text of the tracked disposition list, or `null` when it could not be read. */
  readonly dispositionsText: string | null;
  /** The bundled sets of the build being released, or `null` before the build exists. */
  readonly bundledByTree: Readonly<Partial<Record<TreeName, BundledSet>>> | null;
  /** The preparation time in UTC milliseconds. */
  readonly now: number;
}

export interface ReleaseAdvisoryRefusal {
  readonly reason: ReleaseAdvisoryReason;
  readonly tree: TreeName | null;
  /** The reason behind the reason: 249's code, or the disposition list's defect. */
  readonly detail: string | null;
  readonly message: string;
}

/** What the release record keeps of one capture (data-model section 5). */
export interface AdvisoryCaptureRecord {
  readonly tree: TreeName;
  readonly completeness: AdvisoryCompleteness;
  readonly detail: string | null;
  readonly sha256: string | null;
  readonly commit: string | null;
  readonly lockfile: { readonly path: string; readonly blob: string | null } | null;
  readonly toolVersion: string | null;
  readonly observedAt: string | null;
  readonly findings: number;
}

export interface ReleaseFinding {
  readonly tree: TreeName;
  readonly advisory: string;
  readonly url: string;
  readonly package: string;
  readonly severity: Severity;
  readonly usage: FindingUsage;
  readonly disposition: DispositionVerdict;
}

export interface ReleaseAdvisoryResult {
  readonly budgetDays: 7;
  readonly evaluatedAt: string;
  readonly refusal: ReleaseAdvisoryRefusal | null;
  readonly captures: readonly AdvisoryCaptureRecord[];
  readonly dispositions: {
    readonly state: 'read' | 'unusable';
    readonly defect: string | null;
    readonly sha256: string | null;
    readonly entries: number | null;
  };
  readonly findings: readonly ReleaseFinding[];
  readonly verdicts: Readonly<Record<'not-recorded' | 'covers' | 'expired' | 'does-not-cover', number>>;
}

/** Judge the advisory evidence for one release preparation. Reads nothing, runs nothing. */
export declare function evaluateReleaseAdvisory(input: ReleaseAdvisoryInput): ReleaseAdvisoryResult;

/** The evidence as escaped lines for the operator. No line ranks or totals findings. */
export declare function renderAdvisoryLines(result: ReleaseAdvisoryResult): string[];
