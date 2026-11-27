/**
 * FR-R6-F15 (F15-A; FR-027 to FR-031, FR-034, NFR-006, NFR-008) — the artifacts and records of
 * a review, fix and review loop: a reviewer's report, a fixer's claims, the finding history the
 * host keeps and the verdict it computes.
 *
 * A claim is never a disposition, and a producer's own verdict is checked, not trusted.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { Coverage } from './context-policy';

export const REVIEW_REPORT_VERSION = 1;
export const FIX_CLAIMS_VERSION = 1;

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info'] as const);
export type Severity = (typeof SEVERITIES)[number];

/** A reviewer's decision about a finding (FR-029). */
export const DISPOSITION_STATUSES = Object.freeze(['open', 'resolved', 'reopened', 'unresolved'] as const);
export type FindingStatus = (typeof DISPOSITION_STATUSES)[number];

/** A fixer's statement about a finding. It changes no status (FR-029). */
export const FIX_CLAIM_KINDS = Object.freeze(['claimed-fixed', 'not-addressed', 'disputed'] as const);
export type FixClaimKind = (typeof FIX_CLAIM_KINDS)[number];

/** FR-027: separate from completion. `incomplete` is partial coverage with nothing blocking. */
export const VERDICTS = Object.freeze(['passed', 'needs-fixes', 'incomplete'] as const);
export type Verdict = (typeof VERDICTS)[number];

export interface NewFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
}

export interface Disposition {
  readonly findingId: string;
  readonly status: FindingStatus;
}

/** FR-028: bound to its loop, reviewer attempt, candidate, scope and criteria. */
export interface ReviewReport {
  readonly reportVersion: typeof REVIEW_REPORT_VERSION;
  readonly loopId: string;
  readonly pass: number;
  readonly reviewerAttemptId: string;
  readonly candidateRef: string;
  readonly scopeRevision: string;
  readonly criteriaRevision: string;
  readonly previousReportRef: string | null;
  readonly coverage: Coverage;
  /** The producer's own claims; the host compares them with what it computes. */
  readonly reviewPassed: boolean;
  readonly blockingCount: number;
  readonly findings: readonly NewFinding[];
  readonly dispositions: readonly Disposition[];
}

export interface FixClaim {
  readonly findingId: string;
  readonly claim: FixClaimKind;
}

export interface FixClaims {
  readonly claimsVersion: typeof FIX_CLAIMS_VERSION;
  readonly loopId: string;
  readonly pass: number;
  readonly fixerAttemptId: string;
  readonly basedOnReportRef: string;
  readonly claims: readonly FixClaim[];
}

export interface StatusChange {
  readonly pass: number;
  readonly status: FindingStatus;
}

export interface RecordedClaim {
  readonly pass: number;
  readonly claim: FixClaimKind;
}

/** One finding as the host keeps it: metadata and history, no prose. */
export interface Finding {
  readonly id: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly openedInPass: number;
  readonly history: readonly StatusChange[];
  readonly claims: readonly RecordedClaim[];
}

export interface PassOutcome {
  readonly pass: number;
  readonly reportRef: string;
  readonly verdict: Verdict;
  /** Findings of a blocking severity that are not resolved. */
  readonly blockingCount: number;
  /** Findings that are not resolved, whatever their severity. */
  readonly open: number;
  readonly resolved: number;
  readonly newFindings: number;
  /** True only for `needs-fixes` on a pass before the last permitted one. */
  readonly mayDispatchFix: boolean;
}

export interface PassSummary {
  readonly pass: number;
  readonly reportRef: string;
  readonly verdict: Verdict;
  readonly open: number;
  readonly resolved: number;
  readonly newFindings: number;
}

/** FR-031: references and counts of recent passes; never report contents. */
export interface LoopHistory {
  readonly entries: readonly PassSummary[];
  readonly olderPasses: number;
  readonly latestReportRef: string | null;
  readonly blockingCount: number;
}

/** A finding as an explanation shows it: no title, explanation or evidence (FR-034). */
export interface ExplainedFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly openedInPass: number;
  /** The fixer's claim of each pass that made one, oldest first. */
  readonly claims: readonly FixClaimKind[];
}

/** FR-034: the state of a review loop from metadata. */
export interface ReviewLoopExplanation {
  readonly loopId: string;
  readonly passes: number;
  readonly latestVerdict: Verdict | null;
  readonly blockingCount: number;
  readonly open: number;
  readonly resolved: number;
  readonly findings: readonly ExplainedFinding[];
}
