/**
 * FR-R6-F10 (contract §5, `approveRequest`): recording an operator's review of a verified request.
 *
 * A receipt binds the approval to exactly what was verified: the candidate commit, the target tip
 * the request expected, and the frozen profile's revision and digest. An approval that names
 * anything else is `review-stale`; landing later refuses a receipt that no longer matches.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneOk, laneRefused, type LaneResult } from '../../contracts/execution-lanes';
import type { IntegrationStore } from './integration-store';
import type { ReceiptRecord, RequestRecord } from './integration-store-rows';
import type { LaneStore } from './lane-store';

const ID_BYTES = 16;
const REVIEW_STALE = 'review-stale';

export interface ApproveRequestInput {
  readonly requestId: string;
  readonly candidateCommit: string;
  readonly targetCommit: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
}

export interface ReviewContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

/**
 * Whether a refreeze blocked the request (data-model, integration lifecycle). Approving or landing
 * it then refuses `review-stale` rather than `request-state-invalid` (spec US4-2).
 */
export function isStaleByRefreeze(request: RequestRecord): boolean {
  return request.state === 'blocked' && request.reason === REVIEW_STALE;
}

/** Whether a receipt still approves exactly what the request will land. */
export function receiptMatches(receipt: ReceiptRecord, request: RequestRecord): boolean {
  return (
    receipt.candidateCommit === request.candidateCommit &&
    receipt.targetRef === request.targetRef &&
    receipt.targetCommit === request.expectedTargetCommit &&
    receipt.profileRevision === request.profileRevision &&
    receipt.profileDigest === request.profileDigest
  );
}

function approvalMatches(input: ApproveRequestInput, request: RequestRecord): boolean {
  return (
    input.candidateCommit === request.candidateCommit &&
    input.targetCommit === request.expectedTargetCommit &&
    input.profileRevision === request.profileRevision &&
    input.profileDigest === request.profileDigest
  );
}

/** The refusal for a request that cannot take an approval now, or `null`. */
function approvalRefusal(ctx: ReviewContext, request: RequestRecord | null, input: ApproveRequestInput) {
  if (request === null) return laneRefused<ReceiptRecord>('request-not-found');
  if (isStaleByRefreeze(request)) return laneRefused<ReceiptRecord>('review-stale');
  if (request.state !== 'awaiting-review') return laneRefused<ReceiptRecord>('request-state-invalid');
  if (ctx.integrations.getReceipt(request.requestId) !== null) return laneRefused<ReceiptRecord>('request-state-invalid');
  if (!approvalMatches(input, request)) return laneRefused<ReceiptRecord>('review-stale');
  return null;
}

/**
 * Writes the request's one receipt, or the first refusal. The request stays in `awaiting-review`;
 * landing is a separate operation.
 */
export function approveRequest(ctx: ReviewContext, input: ApproveRequestInput): LaneResult<ReceiptRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const request = ctx.integrations.getRequest(ctx.workspaceId, input.requestId);
    const refusal = approvalRefusal(ctx, request, input);
    if (refusal !== null || request === null) return refusal ?? laneRefused<ReceiptRecord>('request-not-found');
    const receipt: ReceiptRecord = {
      receiptId: ctx.random(ID_BYTES).toString('hex'),
      requestId: request.requestId,
      laneId: request.laneId,
      candidateCommit: request.candidateCommit,
      targetRef: request.targetRef,
      targetCommit: request.expectedTargetCommit,
      profileRevision: request.profileRevision,
      profileDigest: request.profileDigest,
      approvedAt: new Date(ctx.clock()).toISOString(),
      outcome: null,
      outcomeReason: null,
      ownerGeneration: ctx.generation
    };
    ctx.integrations.insertReceipt(receipt);
    return laneOk(receipt);
  });
}
