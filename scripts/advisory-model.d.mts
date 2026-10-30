// Feature 249 (FR-R4-F21) — the declaration side of `advisory-model.mjs`, so `typecheck:tests` can
// see the vocabulary and the capture types without the script becoming TypeScript. Same arrangement
// as `gate-distance.d.mts`.
//
// The capture types are the shapes of `contracts/capture.md` (P1) in the feature's spec folder.
// Every other module's declaration imports them from here rather than restating them, because a
// second copy of a shape is the split the model exists to prevent.

export type TreeName = 'root' | 'webview-ui';
export type Side = 'base' | 'candidate';
export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
export type ClassName =
  | 'introduced'
  | 'worsened'
  | 'uncertain'
  | 'pre-existing'
  | 'resolved'
  | 'not-determined';
export type FailedReason =
  | 'tool-unavailable'
  | 'audit-timeout'
  | 'no-report'
  | 'report-unparseable'
  | 'audit-error'
  | 'registry-unknown';
export type RejectedReason = 'unsupported-format' | 'over-bound' | 'malformed' | 'tree-missing';
export type BoundName =
  | 'report-bytes'
  | 'manifest-bytes'
  | 'lockfile-bytes'
  | 'findings'
  | 'locations-per-finding'
  | 'capture-bytes';
export type FindingNote = 'range-not-evaluated' | 'attributed-by-package' | 'merged-duplicate';
export type ClassReasonCode =
  | 'disclosed-between-captures'
  | 'still-installed-on-candidate'
  | 'severity-revised'
  | 'severity-not-comparable'
  | 'new-on-candidate'
  | 'partly-in-base-lockfile'
  | 'severity-raised'
  | 'new-pair'
  | 'newly-direct'
  | 'newly-production'
  | 'severity-lowered'
  | 'fewer-pairs'
  | 'no-longer-direct'
  | 'no-longer-production'
  | 'absent-on-candidate';
export type CompletenessReason =
  | 'base-not-selected'
  | 'missing-baseline'
  | 'missing-candidate'
  | 'tree-missing'
  | 'mismatch'
  | 'missing-provenance'
  | 'malformed'
  | 'unsupported-format'
  | 'over-bound'
  | 'audit-failure'
  | 'not-comparable'
  | 'observation-skew'
  | 'stale';
export type DispositionStatus = 'actionable' | 'accepted' | 'inapplicable';
export type DispositionVerdict = 'unknown' | 'not-recorded' | 'covers' | 'expired' | 'does-not-cover';

export interface AdvisoryIds {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

/** One lockfile location an advisory affects, with the version installed there. */
export interface CaptureLocation {
  readonly location: string;
  readonly version: string;
  readonly direct: boolean;
  readonly production: boolean;
}

/** One advisory affecting one package in one tree, as a capture records it. */
export interface CaptureFinding {
  readonly package: string;
  readonly ids: AdvisoryIds;
  readonly severity: Severity;
  readonly range: string;
  readonly title: string;
  readonly url: string;
  readonly locations: readonly CaptureLocation[];
  readonly direct: boolean;
  readonly production: boolean;
  readonly dependents: readonly string[];
  readonly notes: readonly FindingNote[];
}

export type CaptureOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly reason: FailedReason; readonly statusCode?: number }
  | { readonly status: 'rejected'; readonly reason: RejectedReason; readonly bound?: BoundName };

/** A manifest or lockfile as the capture names it. `blob` is `null` only when the file is absent. */
export interface CaptureFileEntry {
  readonly path: string;
  readonly blob: string | null;
}

/** The capture file, version 1, in the order its keys are written. */
export interface CaptureFile {
  readonly captureVersion: 1;
  readonly tree: TreeName;
  readonly ecosystem: 'npm';
  readonly commit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly manifest: CaptureFileEntry;
  readonly lockfile: CaptureFileEntry;
  readonly tool: string;
  readonly toolVersion: string;
  readonly command: string;
  readonly registryHost: string;
  readonly observedAt: string;
  readonly reportFormat: string;
  readonly outcome: CaptureOutcome;
  readonly limitations: readonly string[];
  readonly findings: readonly CaptureFinding[];
}

export type CheckCaptureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported-format' | 'missing-provenance' };

export interface TreeFiles {
  readonly manifest: string;
  readonly lockfile: string;
}

export declare const TREES: Readonly<Record<TreeName, TreeFiles>>;
export declare const TREE_NAMES: readonly TreeName[];
export declare const SIDES: readonly Side[];
export declare const SEVERITIES: readonly Exclude<Severity, 'unknown'>[];
export declare const UNKNOWN_SEVERITY: 'unknown';
export declare function normalizeSeverity(value: unknown): Severity;
export declare function severityRank(severity: Severity): number;
export declare const CLASSES: readonly ClassName[];

export declare const CAPTURE_VERSION: 1;
export declare const RECORD_VERSION: 1;
export declare const DISPOSITION_LIST_VERSION: 1;
export declare const REPORT_FORMAT: 'npm-audit-report-2';
export declare const TOOL: 'npm';
export declare const ECOSYSTEM: 'npm';
export declare const AUDIT_ARGV: readonly string[];
export declare const AUDIT_COMMAND: string;

export declare const BOUNDS: {
  readonly reportBytes: number;
  readonly manifestBytes: number;
  readonly lockfileBytes: number;
  readonly findings: number;
  readonly locationsPerFinding: number;
  readonly captureBytes: number;
  readonly dispositionBytes: number;
  readonly dispositionEntries: number;
  readonly auditTimeoutMs: number;
};
export declare const BOUND_NAMES: readonly BoundName[];
export declare const BUDGETS: { readonly pairingMinutes: number; readonly freshnessHours: number };
export declare const PAIRING_BUDGET_MS: number;
export declare const FRESHNESS_BUDGET_MS: number;
export declare const SEMVER_OPTIONS: { readonly includePrerelease: true; readonly loose: true };

export declare const CAPTURE_STATUSES: readonly ('succeeded' | 'failed' | 'rejected')[];
export declare const FAILED_REASONS: readonly FailedReason[];
export declare const REJECTED_REASONS: readonly RejectedReason[];
export declare const FINDING_NOTES: readonly FindingNote[];
export declare const CLASS_REASON_CODES: readonly ClassReasonCode[];
export declare const COMPLETENESS_REASONS: readonly CompletenessReason[];
export declare const DISPOSITION_STATUSES: readonly DispositionStatus[];
export declare const DISPOSITION_VERDICTS: readonly DispositionVerdict[];

/** True for a full git object id, SHA-1 or SHA-256. */
export declare function isObjectId(value: unknown): value is string;
/** The instant in milliseconds, or `NaN` when `text` is not `YYYY-MM-DDTHH:MM:SS(.sss)?Z`. */
export declare function parseInstant(text: unknown): number;
/** The one comparator every sort uses: UTF-16 code units, never the locale. */
export declare function byCodeUnit(a: string, b: string): number;
/** The identity of one advisory object, or `null` when it carries neither a GHSA id nor a source. */
export declare function advisoryIds(
  advisory: { readonly source?: unknown; readonly url?: unknown } | null | undefined
): { canonical: string; aliases: string[] } | null;
export declare function identifierSet(ids: AdvisoryIds): string[];
export declare function idsIntersect(a: AdvisoryIds, b: AdvisoryIds): boolean;
/** One `ids` object for several naming the same advisory: smallest GHSA id canonical, the rest aliases. */
export declare function mergeIds(idsList: readonly AdvisoryIds[]): { canonical: string; aliases: string[] };
/** The highest known severity of several, or `unknown` when none is known. */
export declare function highestSeverity(severities: readonly Severity[]): Severity;
/** The order a classified finding takes in a record and a report: class, tree, package, canonical id. */
export declare function compareFindings(
  a: { readonly class: string; readonly tree: string; readonly package: string; readonly ids: AdvisoryIds },
  b: { readonly class: string; readonly tree: string; readonly package: string; readonly ids: AdvisoryIds }
): number;
/** Whether a parsed capture file has the shape version 1 defines. */
export declare function checkCapture(value: unknown): CheckCaptureResult;
