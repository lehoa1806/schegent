/**
 * FR-R6-F11 (FR-007, FR-008, FR-010) — the rows a report returns.
 *
 * Root, attempt and invocation counts are kept apart; durations carry their basis; usage measures
 * are F06's own values, never recomputed. No row holds a path, a prompt, a transcript or a
 * free-text reason. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AccountingMeasureTotal } from '../usage-accounting/query-contract';
import type { AttemptStatus, ReportDimension, ReportView, RunOutcome } from './report-query';

export type PercentileValue = number | 'unavailable';

/** A duration distribution with nearest-rank percentiles (FR-008). */
export interface Distribution {
  readonly unit: 'ms';
  readonly basis: 'root-wall-clock' | 'attempt-own';
  /** Every member of the population, known or not. */
  readonly samples: number;
  readonly known: number;
  readonly missing: number;
  readonly p50: PercentileValue;
  readonly p90: PercentileValue;
  readonly p99: PercentileValue;
  readonly method: 'nearest-rank';
}

/** The failure-cause view's key value for a root (research R12). */
export type ReportFailureCause = string;

export interface RootRow {
  readonly kind: 'root';
  readonly rootId: string;
  readonly workflowId: string;
  readonly frozenDefinitionId: string | null;
  readonly outcome: RunOutcome;
  readonly createdUtc: string;
  readonly durationMs: number | null;
  readonly attempts: number;
}

export interface AttemptRow {
  readonly kind: 'attempt';
  readonly attemptId: string;
  readonly rootId: string;
  readonly attemptNumber: number;
  readonly stepIndex: number;
  readonly phaseId: string | null;
  readonly status: AttemptStatus;
  readonly exitCode: number | null;
  readonly startedUtc: string;
  readonly completedUtc: string | null;
  readonly durationMs: number | null;
}

export type GroupKey = Readonly<Partial<Record<ReportDimension, string | null>>>;

export interface GroupRow {
  readonly kind: 'group';
  /** The dimension values; null when the view has no dimension (one total row). */
  readonly key: GroupKey | null;
  readonly roots: number;
  readonly attempts: number;
  /** A count per root status, with every status present. */
  readonly outcomes: Readonly<Record<RunOutcome, number>>;
  readonly rootDuration: Distribution;
  /** Present for `workflow-revision` and `time-series`. */
  readonly attemptDuration?: Distribution;
}

export interface UsageRow {
  readonly kind: 'usage';
  readonly key: Readonly<Record<string, string | null>>;
  readonly attempts: number;
  readonly roots: number;
  readonly measures: readonly AccountingMeasureTotal[];
  /** Backends do not record an invocation count (spec Delivery scope). */
  readonly invocations: 'not-recorded';
}

export type ReportRow = RootRow | AttemptRow | GroupRow | UsageRow;

export interface ReportCoverage {
  readonly roots: number;
  readonly attempts: number;
  readonly unknownDurations: number;
  /** Usage view only: F06's unattributed observation count. */
  readonly unattributed?: number;
  /** Usage view only: F06's gap kinds by count. */
  readonly gaps?: readonly { readonly kind: string; readonly count: number }[];
}

export interface ReportOmission {
  readonly what: string;
  readonly reason: string;
}

export type TimeBasis = 'root-created' | 'accounting-event';

export interface LegacyUsageSummary {
  readonly runCount: number;
  readonly costMicros: string;
  readonly detail: 'unavailable';
}

export interface ReportPage {
  readonly reportId: string;
  readonly outcome: 'complete';
  readonly view: ReportView;
  readonly rows: readonly ReportRow[];
  readonly cursor: string | null;
  readonly rowCount: number;
  readonly sourceCutoffUtc: string;
  readonly accountingRevision: number | null;
  readonly calculationVersion: number;
  readonly coverage: ReportCoverage;
  readonly timeBasis: TimeBasis;
  readonly omissions: readonly ReportOmission[];
  /** Usage view only, never merged into the rows. */
  readonly legacy?: LegacyUsageSummary;
  /** Set when the report is a re-run of a saved report. */
  readonly rerunOf?: string;
}

export interface OutcomeLineageEntry {
  readonly source: 'run-store' | 'accounting';
  readonly outcome: string;
}

/** F11-FR-10: metadata-only artifact availability reference without any filesystem path or URI. */
export interface ReportEvidenceReference {
  readonly artifactId: string;
  readonly rootId: string;
  readonly attemptId: string | null;
  readonly storeKind: string;
  readonly availability: string;
  readonly byteSize: number;
  readonly retentionClass: string;
}

/** F11-FR-23: cutoff-pinned ACP profile/attempt attribution; history replay adds no live count. */
export interface AttemptAcpAttribution {
  readonly attemptId: string;
  readonly rootId: string;
  readonly backendKind: string | null;
  readonly modelId: string | null;
  readonly profileId: string | null;
  readonly laneId: string | null;
  readonly liveObservations: number;
}

/** F11-FR-23: cutoff-pinned accepted handoff metadata joined to its source attempt. */
export interface AttemptHandoffSummary {
  readonly handoffId: string;
  readonly rootId: string;
  readonly sourceAttemptId: string;
  readonly targetPhaseId: string;
  readonly revision: number;
  readonly status: string;
  readonly recordBytes: number;
}

/** F11-FR-23: cutoff-pinned review-loop finding counts without prose or paths. */
export interface RootReviewLoopSummary {
  readonly loopId: string;
  readonly rootId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly verdict: string;
  readonly candidateRef: string | null;
  readonly openFindings: number;
  readonly resolvedFindings: number;
  readonly totalFindings: number;
}

export interface RootDrillDown {
  readonly reportId: string;
  readonly root: RootRow;
  readonly attempts: readonly AttemptRow[];
  readonly frozenDefinitionId: string | null;
  readonly outcomeLineage: readonly OutcomeLineageEntry[];
  /** F06 rows for this root at the report's revision; null when accounting is not available. */
  readonly usage: readonly UsageRow[] | null;
  readonly omissions: readonly ReportOmission[];
  readonly evidenceRefs?: readonly ReportEvidenceReference[];
  readonly acpAttributions?: readonly AttemptAcpAttribution[];
  readonly handoffSummaries?: readonly AttemptHandoffSummary[];
  readonly reviewSummaries?: readonly RootReviewLoopSummary[];
}
