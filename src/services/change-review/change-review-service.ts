/**
 * FR-R6-F12 (FR-004 to FR-011, FR-015; NFR-003) — the change review service.
 *
 * Opens a read-only review of one F10 integration request, pages its entries, reads each side by
 * opaque handle, and re-classifies it against the request on demand. Reviews live in host memory
 * only: nothing is written to the integration store, the workspace or disk. Every outcome is a
 * value. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { randomBytes } from 'node:crypto';
import {
  CHANGE_REVIEW_LIMITS,
  reviewOk,
  reviewRefused,
  type ChangeEntry,
  type ContentRead,
  type ReviewDescriptor,
  type ReviewOpened,
  type ReviewPage,
  type ReviewRefusalReason,
  type ReviewResult,
  type UnavailableReason
} from '../../contracts/change-review';
import type { LaneGitRunner } from '../execution-lanes/git-runner';
import type { ReceiptRecord, RequestRecord } from '../execution-lanes/integration-store-rows';
import { comparisonRevision, type BoundValues } from './comparison-revision';
import { createReviewRegistry, opaqueId, type RandomBytes } from './content-handles';
import { ABSENT_SIDE, readContentResource } from './content-reader';
import { boundValuesValid, buildInventory, issueEntries, rawBoundValues, type InventoryBuild } from './review-builder';
import { RECORD_UNREADABLE, classifyReview as classify, type Classified, type TipRead } from './review-classifier';
import { targetTip, type ReviewGitContext } from './review-git';
import { decodeCursor, pageAt } from './review-pages';
import type { ChangeReviewSource } from './review-source';

const CANCELED = 'canceled';

/** A store read that threw: a corrupt row or a database error (review R-2). */
const UNREADABLE = Symbol('unreadable');
type Guarded<T> = T | typeof UNREADABLE;

/** Runs one store read so that a throw becomes a value; the error itself is never logged or kept. */
function guarded<T>(read: () => T): Guarded<T> {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

export interface OpenReviewInput {
  readonly requestId: string;
  readonly expectedRevision?: string;
}

export interface ChangeReviewServiceOptions {
  readonly source: ChangeReviewSource;
  readonly git: LaneGitRunner;
  readonly cwd: string;
  readonly clock?: () => Date;
  readonly random?: RandomBytes;
  readonly timeoutMs?: number;
}

export interface ChangeReviewService {
  openReview(input: OpenReviewInput, signal?: AbortSignal): Promise<ReviewResult<ReviewOpened>>;
  refreshReview(reviewId: string, signal?: AbortSignal): Promise<ReviewResult<ReviewOpened>>;
  classifyReview(reviewId: string): Promise<ReviewResult<ReviewDescriptor>>;
  readPage(cursor: string): ReviewResult<ReviewPage>;
  readContent(handle: string): Promise<ContentRead>;
  closeReview(reviewId: string): { readonly closed: boolean };
  /** Every loaded entry of a live review, for the host's editor opener only. */
  entriesOf(reviewId: string): readonly ChangeEntry[] | null;
  liveReviews(): number;
}

interface LiveReview {
  readonly descriptor: ReviewDescriptor;
  readonly entries: readonly ChangeEntry[];
  readonly bound: BoundValues;
}

function abortReason(signal: AbortSignal | undefined): ReviewRefusalReason | null {
  if (signal === undefined || !signal.aborted) return null;
  return signal.reason === CANCELED ? 'canceled' : 'superseded';
}

/** No review could be built; no partial inventory is ever shown. */
function unavailable(reason: UnavailableReason): ReviewResult<ReviewOpened> {
  return reviewOk({ state: 'unavailable', reason, review: null, firstPage: null });
}

function withClassification(descriptor: ReviewDescriptor, classified: Classified): ReviewDescriptor {
  return { ...descriptor, ...classified };
}

/** A change review service over one workspace's requests and repository. */
export function createChangeReviewService(options: ChangeReviewServiceOptions): ChangeReviewService {
  const ctx: ReviewGitContext = {
    git: options.git,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? CHANGE_REVIEW_LIMITS.gitTimeoutMs
  };
  const clock = options.clock ?? (() => new Date());
  const random: RandomBytes = options.random ?? ((size) => randomBytes(size));
  const registry = createReviewRegistry<LiveReview>(CHANGE_REVIEW_LIMITS.liveReviewsMax);

  const readTip = async (bound: BoundValues): Promise<TipRead> => {
    const tip = await targetTip(ctx, bound.targetRef);
    return tip.ok ? { ok: true, value: tip.value } : { ok: false };
  };

  const classifyNow = async (bound: BoundValues, requestId: string): Promise<Classified> => {
    const tip = await readTip(bound);
    const request: Guarded<RequestRecord | null> = guarded(() => options.source.getRequest(requestId));
    const receipt: Guarded<ReceiptRecord | null> = guarded(() => options.source.getReceipt(requestId));
    if (request === UNREADABLE || receipt === UNREADABLE) return RECORD_UNREADABLE;
    return classify({ bound, request, receipt, tip });
  };

  const register = (
    request: RequestRecord,
    bound: BoundValues,
    built: Extract<InventoryBuild, { ok: true }>,
    classified: Classified
  ): ReviewOpened => {
    const reviewId = opaqueId(random);
    const { entries, resources } = issueEntries(reviewId, built.records, random);
    const descriptor: ReviewDescriptor = {
      reviewId,
      requestId: request.requestId,
      candidateId: request.candidateId,
      candidateCommit: bound.candidateCommit,
      targetRef: bound.targetRef,
      targetCommit: bound.targetCommit,
      profileRevision: bound.profileRevision,
      profileDigest: bound.profileDigest,
      comparisonRevision: comparisonRevision(bound),
      total: built.total,
      loaded: entries.length,
      truncated: built.total > entries.length,
      createdAt: clock().toISOString(),
      ...classified
    };
    registry.add(reviewId, { descriptor, entries, bound }, resources);
    return { state: classified.state, reason: classified.reason, review: descriptor, firstPage: pageAt(reviewId, entries, 0) };
  };

  const openReview = async (input: OpenReviewInput, signal?: AbortSignal): Promise<ReviewResult<ReviewOpened>> => {
    const early = abortReason(signal);
    if (early !== null) return reviewRefused(early);
    const request = guarded(() => options.source.getRequest(input.requestId));
    if (request === UNREADABLE) return unavailable('record-unreadable');
    if (request === null) return reviewRefused('request-not-found');
    const bound = rawBoundValues(request);
    if (input.expectedRevision !== undefined && input.expectedRevision !== comparisonRevision(bound)) {
      return reviewRefused('revision-mismatch');
    }
    if (!boundValuesValid(bound)) return unavailable('record-invalid');
    const built = await buildInventory(ctx, bound);
    const afterBuild = abortReason(signal);
    if (afterBuild !== null) return reviewRefused(afterBuild);
    if (!built.ok) return unavailable(built.reason);
    const classified = await classifyNow(bound, request.requestId);
    const late = abortReason(signal);
    if (late !== null) return reviewRefused(late);
    return reviewOk(register(request, bound, built, classified));
  };

  return {
    openReview,
    refreshReview: async (reviewId, signal) => {
      const live = registry.get(reviewId);
      if (live === null) return reviewRefused('review-not-found');
      return openReview({ requestId: live.descriptor.requestId }, signal);
    },
    classifyReview: async (reviewId) => {
      const live = registry.get(reviewId);
      if (live === null) return reviewRefused('review-not-found');
      const classified = await classifyNow(live.bound, live.descriptor.requestId);
      const descriptor = withClassification(live.descriptor, classified);
      registry.replace(reviewId, { ...live, descriptor });
      return reviewOk(descriptor);
    },
    readPage: (cursor) => {
      const value = decodeCursor(cursor);
      const live = value === null ? null : registry.get(value.reviewId);
      if (value === null || live === null || value.offset >= live.entries.length) return reviewRefused('cursor-invalid');
      return reviewOk(pageAt(value.reviewId, live.entries, value.offset));
    },
    readContent: async (handle) => {
      if (handle === ABSENT_SIDE) return { kind: 'text', text: '' };
      return readContentResource(ctx, registry.resource(handle));
    },
    closeReview: (reviewId) => ({ closed: registry.close(reviewId) }),
    entriesOf: (reviewId) => registry.get(reviewId)?.entries ?? null,
    liveReviews: () => registry.size()
  };
}
