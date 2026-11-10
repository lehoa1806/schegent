/**
 * FR-R6-F10 (data-model.md): row <-> record mapping for integration requests, verification
 * results, review receipts and the integration journal.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  INTEGRATION_STATES,
  JOURNAL_KINDS,
  JOURNAL_OUTCOMES,
  LANDING_METHODS,
  RECEIPT_OUTCOMES,
  type IntegrationState,
  type JournalKind,
  type JournalOutcome,
  type LandingMethod,
  type ReceiptOutcome
} from '../../contracts/execution-lanes';
import { LaneStoreCorruptError } from './lane-store-rows';

function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new LaneStoreCorruptError(column);
  return match;
}

function nullableOneOf<T extends string>(allowed: readonly T[], value: string | null, column: string): T | null {
  return value === null ? null : oneOf(allowed, value, column);
}

// ---- requests ----

export interface RequestRecord {
  readonly requestId: string;
  readonly laneId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly candidateId: string;
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly expectedTargetCommit: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  /** The whole profile as frozen at request time (data-model, `profile_json`). */
  readonly profileJson: string;
  readonly state: IntegrationState;
  readonly reason: string | null;
  readonly verificationAttempt: number;
  readonly ownerGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RequestRow {
  readonly request_id: string;
  readonly lane_id: string;
  readonly workspace_id: string;
  readonly repository_id: string;
  readonly candidate_id: string;
  readonly candidate_commit: string;
  readonly target_ref: string;
  readonly expected_target_commit: string;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly profile_digest: string;
  readonly profile_json: string;
  readonly state: string;
  readonly reason: string | null;
  readonly verification_attempt: number;
  readonly owner_generation: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const REQUEST_COLUMNS =
  'request_id, lane_id, workspace_id, repository_id, candidate_id, candidate_commit, target_ref, ' +
  'expected_target_commit, profile_id, profile_revision, profile_digest, profile_json, state, reason, ' +
  'verification_attempt, owner_generation, created_at, updated_at';

export function requestFromRow(row: RequestRow): RequestRecord {
  return {
    requestId: row.request_id,
    laneId: row.lane_id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    candidateId: row.candidate_id,
    candidateCommit: row.candidate_commit,
    targetRef: row.target_ref,
    expectedTargetCommit: row.expected_target_commit,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    profileDigest: row.profile_digest,
    profileJson: row.profile_json,
    state: oneOf(INTEGRATION_STATES, row.state, 'state'),
    reason: row.reason,
    verificationAttempt: row.verification_attempt,
    ownerGeneration: row.owner_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function requestInsertParams(record: RequestRecord): (string | number | null)[] {
  return [
    record.requestId,
    record.laneId,
    record.workspaceId,
    record.repositoryId,
    record.candidateId,
    record.candidateCommit,
    record.targetRef,
    record.expectedTargetCommit,
    record.profileId,
    record.profileRevision,
    record.profileDigest,
    record.profileJson,
    record.state,
    record.reason,
    record.verificationAttempt,
    record.ownerGeneration,
    record.createdAt,
    record.updatedAt
  ];
}

// ---- verification results ----

export interface VerificationResultRecord {
  readonly resultId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly checkIndex: number;
  readonly checkName: string;
  readonly candidateCommit: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly recordedAt: string;
}

export interface VerificationResultRow {
  readonly result_id: string;
  readonly request_id: string;
  readonly attempt: number;
  readonly check_index: number;
  readonly check_name: string;
  readonly candidate_commit: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: number;
  readonly duration_ms: number;
  readonly output_bytes: number;
  readonly output_sha256: string;
  readonly recorded_at: string;
}

export const RESULT_COLUMNS =
  'result_id, request_id, attempt, check_index, check_name, candidate_commit, exit_code, signal, ' +
  'timed_out, duration_ms, output_bytes, output_sha256, recorded_at';

export function resultFromRow(row: VerificationResultRow): VerificationResultRecord {
  return {
    resultId: row.result_id,
    requestId: row.request_id,
    attempt: row.attempt,
    checkIndex: row.check_index,
    checkName: row.check_name,
    candidateCommit: row.candidate_commit,
    exitCode: row.exit_code,
    signal: row.signal,
    timedOut: row.timed_out === 1,
    durationMs: row.duration_ms,
    outputBytes: row.output_bytes,
    outputSha256: row.output_sha256,
    recordedAt: row.recorded_at
  };
}

/** A check passes only with exit 0, no signal and no timeout (data-model). */
export function resultPassed(result: VerificationResultRecord): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut;
}

// ---- receipts ----

export interface ReceiptRecord {
  readonly receiptId: string;
  readonly requestId: string;
  readonly laneId: string;
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly approvedAt: string;
  readonly outcome: ReceiptOutcome | null;
  readonly outcomeReason: string | null;
  readonly ownerGeneration: number;
}

export interface ReceiptRow {
  readonly receipt_id: string;
  readonly request_id: string;
  readonly lane_id: string;
  readonly candidate_commit: string;
  readonly target_ref: string;
  readonly target_commit: string;
  readonly profile_revision: number;
  readonly profile_digest: string;
  readonly approved_at: string;
  readonly outcome: string | null;
  readonly outcome_reason: string | null;
  readonly owner_generation: number;
}

export const RECEIPT_COLUMNS =
  'receipt_id, request_id, lane_id, candidate_commit, target_ref, target_commit, profile_revision, ' +
  'profile_digest, approved_at, outcome, outcome_reason, owner_generation';

export function receiptFromRow(row: ReceiptRow): ReceiptRecord {
  return {
    receiptId: row.receipt_id,
    requestId: row.request_id,
    laneId: row.lane_id,
    candidateCommit: row.candidate_commit,
    targetRef: row.target_ref,
    targetCommit: row.target_commit,
    profileRevision: row.profile_revision,
    profileDigest: row.profile_digest,
    approvedAt: row.approved_at,
    outcome: nullableOneOf(RECEIPT_OUTCOMES, row.outcome, 'outcome'),
    outcomeReason: row.outcome_reason,
    ownerGeneration: row.owner_generation
  };
}

// ---- journal ----

export interface JournalRecord {
  readonly entryId: string;
  readonly requestId: string;
  readonly seq: number;
  readonly kind: JournalKind;
  readonly method: LandingMethod | null;
  readonly candidateCommit: string;
  readonly expectedCommit: string;
  readonly observedTip: string | null;
  readonly outcome: JournalOutcome | null;
  readonly reason: string | null;
  readonly ownerGeneration: number;
  readonly recordedAt: string;
}

export interface JournalRow {
  readonly entry_id: string;
  readonly request_id: string;
  readonly entry_seq: number;
  readonly kind: string;
  readonly method: string | null;
  readonly candidate_commit: string;
  readonly expected_commit: string;
  readonly observed_tip: string | null;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly owner_generation: number;
  readonly recorded_at: string;
}

export const JOURNAL_COLUMNS =
  'entry_id, request_id, entry_seq, kind, method, candidate_commit, expected_commit, observed_tip, ' +
  'outcome, reason, owner_generation, recorded_at';

export function journalFromRow(row: JournalRow): JournalRecord {
  return {
    entryId: row.entry_id,
    requestId: row.request_id,
    seq: row.entry_seq,
    kind: oneOf(JOURNAL_KINDS, row.kind, 'kind'),
    method: nullableOneOf(LANDING_METHODS, row.method, 'method'),
    candidateCommit: row.candidate_commit,
    expectedCommit: row.expected_commit,
    observedTip: row.observed_tip,
    outcome: nullableOneOf(JOURNAL_OUTCOMES, row.outcome, 'outcome'),
    reason: row.reason,
    ownerGeneration: row.owner_generation,
    recordedAt: row.recorded_at
  };
}
