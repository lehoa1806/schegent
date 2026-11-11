/**
 * FR-R6-F15 (F15-A; FR-028, FR-029, NFR-006) — a reviewer's report and a fixer's claims, read
 * from the text an agent wrote.
 *
 * The text is parsed by the strict parser, then every field is checked and the artifact is
 * rebuilt in the contract's key order from the checked values only. One fault refuses the whole
 * artifact: a report is never taken in part. A refusal names a fixed detail code and carries
 * none of the text.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  COVERAGES,
  FINDING_ID_PATTERN,
  IDENTIFIER_PATTERN,
  PHASE_CONTEXT_LIMITS,
  REFERENCE_PATTERN,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import {
  DISPOSITION_STATUSES,
  FIX_CLAIM_KINDS,
  FIX_CLAIMS_VERSION,
  REVIEW_REPORT_VERSION,
  SEVERITIES,
  type Disposition,
  type FixClaim,
  type FixClaims,
  type NewFinding,
  type ReviewReport
} from '../../contracts/phase-context/review-loop';
import { hasExactKeys, isOneOf, isWholeNumber, listOf, matchesPattern, plainRecord, refuse, type PlainRecord } from './primitives';
import { parseStrictJson, type StrictJsonLimits, type StrictJsonReason } from './strict-json';
import { textFault, utf8Bytes } from './text-bounds';

export type ReviewReportResult = { readonly ok: true; readonly report: ReviewReport } | Refusal;
export type FixClaimsResult = { readonly ok: true; readonly claims: FixClaims } | Refusal;

type Parsed<T> = { readonly ok: true; readonly value: T } | Refusal;

const ARTIFACT_LIMITS: StrictJsonLimits = {
  maxBytes: PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax,
  maxDepth: PHASE_CONTEXT_LIMITS.jsonDepthMax,
  maxValues: PHASE_CONTEXT_LIMITS.jsonValuesMax
};

const ARTIFACT_DETAILS: Readonly<Record<StrictJsonReason, string>> = {
  oversized: 'artifact-oversized',
  'too-deep': 'artifact-too-deep',
  'too-many-values': 'artifact-too-many-values',
  'duplicate-key': 'artifact-duplicate-key',
  'forbidden-key': 'artifact-forbidden-key',
  malformed: 'artifact-malformed'
};

const REPORT_KEYS: readonly string[] = [
  'reportVersion',
  'loopId',
  'pass',
  'reviewerAttemptId',
  'candidateRef',
  'scopeRevision',
  'criteriaRevision',
  'previousReportRef',
  'coverage',
  'reviewPassed',
  'blockingCount',
  'findings',
  'dispositions'
];
const CLAIMS_KEYS: readonly string[] = ['claimsVersion', 'loopId', 'pass', 'fixerAttemptId', 'basedOnReportRef', 'claims'];
const FINDING_KEYS: readonly string[] = ['id', 'severity', 'title', 'explanation', 'evidence'];
const DISPOSITION_KEYS: readonly string[] = ['findingId', 'status'];
const CLAIM_KEYS: readonly string[] = ['findingId', 'claim'];

function invalid(detail: string): Refusal {
  return refuse('invalid-source', detail);
}

/** The record the text states, or the refusal for a text the strict parser does not accept. */
function readRecord(text: string, shapeDetail: string): Parsed<PlainRecord> {
  const parsed = parseStrictJson(text, ARTIFACT_LIMITS);
  if (!parsed.ok) return invalid(ARTIFACT_DETAILS[parsed.reason]);
  const record = plainRecord(parsed.value);
  return record === null ? invalid(shapeDetail) : { ok: true, value: record };
}

/**
 * A version this build does not know is refused before the keys are read: a newer artifact may
 * have another shape, and it is reported as unsupported, not as malformed.
 */
function versionRefusal(version: unknown, supported: number, detail: string): Refusal | null {
  if (!isWholeNumber(version, 1)) return invalid(detail);
  return version > supported ? refuse('unsupported-version', detail) : null;
}

/** Every item parsed, in order; the first refusal ends the reading. */
function readAll<T>(
  items: readonly unknown[],
  readOne: (item: unknown) => Parsed<T>,
  identityOf: (value: T) => string,
  duplicateDetail: string
): Parsed<readonly T[]> {
  const seen = new Set<string>();
  const values: T[] = [];
  for (const item of items) {
    const parsed = readOne(item);
    if (!parsed.ok) return parsed;
    const identity = identityOf(parsed.value);
    if (seen.has(identity)) return invalid(duplicateDetail);
    seen.add(identity);
    values.push(parsed.value);
  }
  return { ok: true, value: values };
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && textFault(value, maxBytes) === null;
}

function readEvidence(value: unknown): readonly string[] | null {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.evidenceReferencesMax);
  if (items === null) return null;
  const references: string[] = [];
  for (const item of items) {
    if (!matchesPattern(REFERENCE_PATTERN, item)) return null;
    references.push(item);
  }
  return references;
}

function readFinding(item: unknown): Parsed<NewFinding> {
  const record = plainRecord(item);
  if (record === null || !hasExactKeys(record, FINDING_KEYS)) return invalid('finding-shape');
  const { id, severity, title, explanation } = record;
  if (!matchesPattern(FINDING_ID_PATTERN, id)) return invalid('finding-id');
  if (!isOneOf(SEVERITIES, severity)) return invalid('finding-severity');
  if (!isBoundedText(title, PHASE_CONTEXT_LIMITS.findingTitleBytesMax)) return invalid('finding-title');
  // An explanation may be empty; a title may not.
  if (explanation !== '' && !isBoundedText(explanation, PHASE_CONTEXT_LIMITS.findingExplanationBytesMax)) {
    return invalid('finding-explanation');
  }
  const evidence = readEvidence(record.evidence);
  if (evidence === null) return invalid('finding-evidence');
  const finding: NewFinding = { id, severity, title, explanation, evidence };
  if (utf8Bytes(JSON.stringify(finding)) > PHASE_CONTEXT_LIMITS.reviewRecordBytesMax) return invalid('record-bytes');
  return { ok: true, value: finding };
}

function readDisposition(item: unknown): Parsed<Disposition> {
  const record = plainRecord(item);
  if (record === null || !hasExactKeys(record, DISPOSITION_KEYS)) return invalid('disposition-shape');
  const { findingId, status } = record;
  if (!matchesPattern(FINDING_ID_PATTERN, findingId)) return invalid('finding-id');
  if (!isOneOf(DISPOSITION_STATUSES, status)) return invalid('disposition-status');
  return { ok: true, value: { findingId, status } };
}

function readClaim(item: unknown): Parsed<FixClaim> {
  const record = plainRecord(item);
  if (record === null || !hasExactKeys(record, CLAIM_KEYS)) return invalid('claim-shape');
  const { findingId, claim } = record;
  if (!matchesPattern(FINDING_ID_PATTERN, findingId)) return invalid('finding-id');
  if (!isOneOf(FIX_CLAIM_KINDS, claim)) return invalid('claim-kind');
  return { ok: true, value: { findingId, claim } };
}

/**
 * A review report from text (FR-028). The size, depth, value count and key rules are checked
 * first, then the version, the keys, each field and each record. Whether the report agrees with
 * its loop, and whether its verdict is the one the host computes, is the finding ledger's part.
 */
export function parseReviewReport(text: string): ReviewReportResult {
  const read = readRecord(text, 'report-shape');
  if (!read.ok) return read;
  const record = read.value;
  const versionFault = versionRefusal(record.reportVersion, REVIEW_REPORT_VERSION, 'report-version');
  if (versionFault !== null) return versionFault;
  if (!hasExactKeys(record, REPORT_KEYS)) return invalid('report-shape');

  const { loopId, pass, reviewerAttemptId, candidateRef, scopeRevision, criteriaRevision, previousReportRef, coverage, reviewPassed, blockingCount } =
    record;
  const findingItems = listOf(record.findings, Number.MAX_SAFE_INTEGER);
  const dispositionItems = listOf(record.dispositions, Number.MAX_SAFE_INTEGER);
  if (
    !matchesPattern(IDENTIFIER_PATTERN, loopId) ||
    !isWholeNumber(pass, 1) ||
    !matchesPattern(IDENTIFIER_PATTERN, reviewerAttemptId) ||
    !matchesPattern(REFERENCE_PATTERN, candidateRef) ||
    !matchesPattern(REFERENCE_PATTERN, scopeRevision) ||
    !matchesPattern(REFERENCE_PATTERN, criteriaRevision) ||
    (previousReportRef !== null && !matchesPattern(REFERENCE_PATTERN, previousReportRef)) ||
    !isOneOf(COVERAGES, coverage) ||
    typeof reviewPassed !== 'boolean' ||
    !isWholeNumber(blockingCount, 0) ||
    findingItems === null ||
    dispositionItems === null
  ) {
    return invalid('report-field');
  }
  if (findingItems.length + dispositionItems.length > PHASE_CONTEXT_LIMITS.reviewRecordsMax) return invalid('record-count');

  const findings = readAll(findingItems, readFinding, (finding) => finding.id, 'finding-duplicate');
  if (!findings.ok) return findings;
  const dispositions = readAll(dispositionItems, readDisposition, (disposition) => disposition.findingId, 'disposition-duplicate');
  if (!dispositions.ok) return dispositions;

  return {
    ok: true,
    report: {
      reportVersion: REVIEW_REPORT_VERSION,
      loopId,
      pass,
      reviewerAttemptId,
      candidateRef,
      scopeRevision,
      criteriaRevision,
      previousReportRef,
      coverage,
      reviewPassed,
      blockingCount,
      findings: findings.value,
      dispositions: dispositions.value
    }
  };
}

/**
 * A fixer's claims from text (FR-029), under the same rules as a report. A claim states what the
 * fixer says it did; no claim is taken as proof that a finding is resolved.
 */
export function parseFixClaims(text: string): FixClaimsResult {
  const read = readRecord(text, 'claims-shape');
  if (!read.ok) return read;
  const record = read.value;
  const versionFault = versionRefusal(record.claimsVersion, FIX_CLAIMS_VERSION, 'claims-version');
  if (versionFault !== null) return versionFault;
  if (!hasExactKeys(record, CLAIMS_KEYS)) return invalid('claims-shape');

  const { loopId, pass, fixerAttemptId, basedOnReportRef } = record;
  const claimItems = listOf(record.claims, Number.MAX_SAFE_INTEGER);
  if (
    !matchesPattern(IDENTIFIER_PATTERN, loopId) ||
    !isWholeNumber(pass, 1) ||
    !matchesPattern(IDENTIFIER_PATTERN, fixerAttemptId) ||
    !matchesPattern(REFERENCE_PATTERN, basedOnReportRef) ||
    claimItems === null
  ) {
    return invalid('claims-field');
  }
  if (claimItems.length > PHASE_CONTEXT_LIMITS.reviewRecordsMax) return invalid('record-count');

  const claims = readAll(claimItems, readClaim, (claim) => claim.findingId, 'claim-duplicate');
  if (!claims.ok) return claims;

  return { ok: true, claims: { claimsVersion: FIX_CLAIMS_VERSION, loopId, pass, fixerAttemptId, basedOnReportRef, claims: claims.value } };
}
