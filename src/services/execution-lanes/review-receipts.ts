/**
 * FR-R6-F10 (contract §5, `approveRequest`): recording an operator's review of a verified request.
 *
 * A receipt binds the approval to exactly what was verified: the candidate commit, the target tip
 * the request expected, and the frozen profile's revision and digest. An approval that names
 * anything else is `review-stale`; landing later refuses a receipt that no longer matches.
 *
 * Authority boundary (`16-22`): `candidateCommit`, `targetCommit`, `profileRevision` and
 * `profileDigest` are all readable on `IntegrationRequestView` — they are freshness bindings, NOT
 * an authentication secret. `approveRequest` and `landRequest` are host-only operator actions and
 * MUST NEVER be exposed to an agent, autonomous Run, or untrusted IPC caller without an explicit
 * host-side human-approval gate (`ReviewContext.authorizeApproval`) that confirms both human
 * provenance and the frozen verification profile's `checks`/`argv` so a proposed `argv` cannot
 * authorize its own landing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneOk, laneRefused, type LaneResult, type VerificationCheck } from '../../contracts/execution-lanes';
import type { IntegrationStore } from './integration-store';
import type { ReceiptRecord, RequestRecord } from './integration-store-rows';
import { parseFrozenProfile } from './lane-input-rules';
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

/**
 * Facts handed to an optional host-side human-approval authority gate (`16-22`), including the
 * parsed frozen `checks` (`argv`) so a human reviewer or policy gate sees exactly what verified
 * the candidate before a receipt can be issued.
 */
export interface ApprovalAuthorizationContext {
  readonly requestId: string;
  readonly laneId: string;
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly checks: readonly VerificationCheck[];
}

export type ApprovalAuthorizer = (approval: ApprovalAuthorizationContext) => boolean;

export interface ReviewContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
  /**
   * Host authority verifier (`16-22`, SR-B9). Fails closed: omitting `authorizeApproval` or
   * returning `false` refuses `review-stale` with zero receipt written.
   */
  readonly authorizeApproval?: ApprovalAuthorizer;
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
    if (ctx.authorizeApproval === undefined) {
      return laneRefused<ReceiptRecord>('review-stale');
    }
    const profile = parseFrozenProfile(request.profileJson);
    if (profile === null) return laneRefused<ReceiptRecord>('review-stale');
    const authorized = ctx.authorizeApproval({
      requestId: request.requestId,
      laneId: request.laneId,
      candidateCommit: request.candidateCommit,
      targetRef: request.targetRef,
      targetCommit: request.expectedTargetCommit,
      profileId: request.profileId,
      profileRevision: request.profileRevision,
      profileDigest: request.profileDigest,
      checks: profile.checks
    });
    if (!authorized) return laneRefused<ReceiptRecord>('review-stale');
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
