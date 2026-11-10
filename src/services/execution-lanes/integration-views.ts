/**
 * FR-R6-F10 (contract §4): the views of integration records the service returns. The frozen
 * profile JSON, the workspace and repository ids and the owner generation stay internal.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { IntegrationRequestView, ReceiptView, VerificationCheckView } from '../../contracts/execution-lanes';
import type { ReceiptRecord, RequestRecord, VerificationResultRecord } from './integration-store-rows';

export function receiptViewOf(receipt: ReceiptRecord): ReceiptView {
  return {
    receiptId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    targetCommit: receipt.targetCommit,
    profileRevision: receipt.profileRevision,
    profileDigest: receipt.profileDigest,
    approvedAt: receipt.approvedAt,
    outcome: receipt.outcome,
    outcomeReason: receipt.outcomeReason
  };
}

export function requestViewOf(request: RequestRecord, receipt: ReceiptRecord | null): IntegrationRequestView {
  return {
    requestId: request.requestId,
    laneId: request.laneId,
    candidateId: request.candidateId,
    candidateCommit: request.candidateCommit,
    targetRef: request.targetRef,
    expectedTargetCommit: request.expectedTargetCommit,
    profile: { profileId: request.profileId, revision: request.profileRevision, digest: request.profileDigest },
    state: request.state,
    reason: request.reason,
    verificationAttempt: request.verificationAttempt,
    receipt: receipt === null ? null : receiptViewOf(receipt),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
  };
}

export function checkViewOf(result: VerificationResultRecord): VerificationCheckView {
  return {
    checkIndex: result.checkIndex,
    name: result.checkName,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputBytes: result.outputBytes,
    outputSha256: result.outputSha256,
    passed: result.exitCode === 0 && result.signal === null && !result.timedOut
  };
}
