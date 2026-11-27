// FR-R6-F12 T011 and T023 (FR-004 to FR-009, FR-015; research R3 and R4) — the change review
// service.
//
// WHAT THIS PINS:
//   - a refusal (unknown request, revision mismatch) makes zero Git calls;
//   - each build failure is `unavailable` with its own reason, and no review is kept;
//   - an empty diff is a current review with no entries;
//   - an entry carries a handle only for a side that exists, and a handle reads its blob;
//   - after the target moves the review is stale, its content still reads the original text, and
//     a refresh builds a new review while the old descriptor stays as it was.

import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SENTENCES, type ReviewOpened, type ReviewResult } from '../../../src/contracts/change-review';
import { createChangeReviewService } from '../../../src/services/change-review/change-review-service';
import { comparisonRevision } from '../../../src/services/change-review/comparison-revision';
import { ABSENT_SIDE } from '../../../src/services/change-review/content-reader';
import {
  BLOB_NEW,
  BLOB_OLD,
  BUFFER,
  CANDIDATE,
  EXIT_1,
  EXIT_128,
  MOVED_TARGET,
  OK,
  REQUEST_ID,
  TARGET,
  TARGET_REF,
  TIMEOUT,
  mutableSource,
  requestRecord,
  scriptedGit,
  type MutableSource,
  type ScriptedGit
} from './fake-review-git';

const FIXED_NOW = new Date('2026-11-11T02:00:00.000Z');

function serviceOver(source: MutableSource, scripted: ScriptedGit) {
  let counter = 0;
  return createChangeReviewService({
    source,
    git: scripted.git,
    cwd: '/repo',
    clock: () => FIXED_NOW,
    random: (size) => {
      counter += 1;
      return new Uint8Array(size).fill(counter);
    }
  });
}

function opened(result: ReviewResult<ReviewOpened>): ReviewOpened {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
}

function built(result: ReviewResult<ReviewOpened>) {
  const value = opened(result);
  if (value.review === null) throw new Error(`unavailable: ${value.reason}`);
  return { review: value.review, firstPage: value.firstPage, state: value.state, reason: value.reason };
}

const CURRENT_REVISION = comparisonRevision({
  candidateCommit: CANDIDATE,
  targetRef: TARGET_REF,
  targetCommit: TARGET,
  profileRevision: 2,
  profileDigest: 'digest-a'
});

describe('openReview refusals', () => {
  it('refuses an unknown request with zero Git calls', async () => {
    const scripted = scriptedGit();
    const service = serviceOver(mutableSource(null), scripted);
    expect(await service.openReview({ requestId: REQUEST_ID })).toEqual({ ok: false, reason: 'request-not-found' });
    expect(scripted.calls).toHaveLength(0);
  });

  it('refuses a stale expected revision with zero Git calls', async () => {
    const scripted = scriptedGit();
    const service = serviceOver(mutableSource(), scripted);
    const result = await service.openReview({ requestId: REQUEST_ID, expectedRevision: `cr1-${'0'.repeat(64)}` });
    expect(result).toEqual({ ok: false, reason: 'revision-mismatch' });
    expect(scripted.calls).toHaveLength(0);
  });

  it('accepts the current expected revision', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    const { review } = built(await service.openReview({ requestId: REQUEST_ID, expectedRevision: CURRENT_REVISION }));
    expect(review.comparisonRevision).toBe(CURRENT_REVISION);
  });

  it('refuses an aborted open and keeps no review', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    const controller = new AbortController();
    controller.abort('canceled');
    expect(await service.openReview({ requestId: REQUEST_ID }, controller.signal)).toEqual({ ok: false, reason: 'canceled' });
    expect(service.liveReviews()).toBe(0);
  });
});

describe('openReview unavailable', () => {
  it.each([
    ['a bad candidate commit', { candidateCommit: 'HEAD' }],
    ['a bad target commit', { expectedTargetCommit: '--all' }],
    ['a bad target ref', { targetRef: 'main' }],
    ['a negative profile revision', { profileRevision: -1 }],
    ['a fractional profile revision', { profileRevision: 1.5 }],
    ['an empty profile digest', { profileDigest: '' }]
  ])('reads %s as record-invalid with zero Git calls', async (_label, overrides) => {
    const scripted = scriptedGit();
    const service = serviceOver(mutableSource(requestRecord(overrides)), scripted);
    expect(opened(await service.openReview({ requestId: REQUEST_ID }))).toEqual({
      state: 'unavailable',
      reason: 'record-invalid',
      review: null,
      firstPage: null
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it('reads a missing commit as commit-missing', async () => {
    const scripted = scriptedGit();
    scripted.answer('rev-parse', (args) => ((args.at(3) ?? '').startsWith(CANDIDATE) ? EXIT_1 : OK(`${TARGET}\n`)));
    const value = opened(await serviceOver(mutableSource(), scripted).openReview({ requestId: REQUEST_ID }));
    expect(value.reason).toBe('commit-missing');
  });

  it('reads an unanswerable commit check as inventory-failed', async () => {
    const scripted = scriptedGit();
    scripted.answer('rev-parse', EXIT_128);
    const value = opened(await serviceOver(mutableSource(), scripted).openReview({ requestId: REQUEST_ID }));
    expect(value.reason).toBe('inventory-failed');
  });

  it('reads a target that is not an ancestor as target-diverged', async () => {
    const scripted = scriptedGit();
    scripted.answer('merge-base', EXIT_1);
    const value = opened(await serviceOver(mutableSource(), scripted).openReview({ requestId: REQUEST_ID }));
    expect(value.reason).toBe('target-diverged');
  });

  it.each([
    ['inventory-deadline', TIMEOUT],
    ['inventory-oversized', BUFFER],
    ['inventory-failed', EXIT_128],
    ['inventory-failed', OK(':garbage\u0000')]
  ] as const)('maps an inventory failure to %s', async (reason, result) => {
    const scripted = scriptedGit();
    scripted.answer('diff-tree', result);
    const service = serviceOver(mutableSource(), scripted);
    expect(opened(await service.openReview({ requestId: REQUEST_ID })).reason).toBe(reason);
    expect(service.liveReviews()).toBe(0);
  });
});

describe('openReview built', () => {
  it('reads an empty diff as a current review with no entries', async () => {
    const service = serviceOver(mutableSource(), scriptedGit(''));
    const { review, firstPage, state } = built(await service.openReview({ requestId: REQUEST_ID }));
    expect(state).toBe('current');
    expect(review).toMatchObject({ total: 0, loaded: 0, truncated: false, state: 'current', reason: null });
    expect(firstPage.entries).toEqual([]);
    expect(firstPage.nextCursor).toBeNull();
  });

  it('binds the descriptor to the request values', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    const { review } = built(await service.openReview({ requestId: REQUEST_ID }));
    expect(review).toMatchObject({
      requestId: REQUEST_ID,
      candidateId: 'cand-1',
      candidateCommit: CANDIDATE,
      targetRef: TARGET_REF,
      targetCommit: TARGET,
      profileRevision: 2,
      profileDigest: 'digest-a',
      total: 3,
      loaded: 3,
      truncated: false,
      createdAt: FIXED_NOW.toISOString()
    });
    expect(review.reviewId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('gives a handle only to an existing side, and each handle reads its own blob', async () => {
    const scripted = scriptedGit();
    const service = serviceOver(mutableSource(), scripted);
    const { firstPage } = built(await service.openReview({ requestId: REQUEST_ID }));
    const [added, deleted, modified] = [firstPage.entries.at(0), firstPage.entries.at(1), firstPage.entries.at(2)];
    expect(added?.oldHandle).toBeNull();
    expect(deleted?.newHandle).toBeNull();
    expect(new Set([added?.newHandle, deleted?.oldHandle, modified?.oldHandle, modified?.newHandle]).size).toBe(4);
    expect(await service.readContent(modified?.oldHandle ?? '')).toEqual({ kind: 'text', text: `text of ${BLOB_OLD}\n` });
    expect(await service.readContent(modified?.newHandle ?? '')).toEqual({ kind: 'text', text: `text of ${BLOB_NEW}\n` });
  });

  it('reads the absent side as empty text and an unknown handle as unavailable', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    expect(await service.readContent(ABSENT_SIDE)).toEqual({ kind: 'text', text: '' });
    expect(await service.readContent('Z'.repeat(22))).toEqual({
      kind: 'placeholder',
      reason: 'unavailable',
      text: PLACEHOLDER_SENTENCES.unavailable
    });
  });

  it('drops the handles of a closed review', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    const { review, firstPage } = built(await service.openReview({ requestId: REQUEST_ID }));
    expect(service.closeReview(review.reviewId)).toEqual({ closed: true });
    expect(service.closeReview(review.reviewId)).toEqual({ closed: false });
    const read = await service.readContent(firstPage.entries.at(0)?.newHandle ?? '');
    expect(read.kind === 'placeholder' && read.reason).toBe('unavailable');
  });
});

describe('classifyReview and refreshReview', () => {
  it('reads a moved target as stale while the old content still reads', async () => {
    const scripted = scriptedGit();
    const service = serviceOver(mutableSource(), scripted);
    const { review, firstPage } = built(await service.openReview({ requestId: REQUEST_ID }));
    scripted.setTip(MOVED_TARGET);
    const classified = await service.classifyReview(review.reviewId);
    expect(classified.ok && classified.value).toMatchObject({
      state: 'stale',
      reason: 'target-advanced',
      landing: { eligible: false, reason: 'review-not-current' }
    });
    const handle = firstPage.entries.at(2)?.oldHandle ?? '';
    expect(await service.readContent(handle)).toEqual({ kind: 'text', text: `text of ${BLOB_OLD}\n` });
  });

  it('builds a new review on refresh and leaves the old descriptor as it was', async () => {
    const source = mutableSource();
    const service = serviceOver(source, scriptedGit());
    const first = built(await service.openReview({ requestId: REQUEST_ID })).review;
    source.request = requestRecord({ expectedTargetCommit: MOVED_TARGET });
    const refreshed = opened(await service.refreshReview(first.reviewId));
    expect(refreshed.review?.reviewId).not.toBe(first.reviewId);
    expect(refreshed.review?.comparisonRevision).not.toBe(first.comparisonRevision);
    expect(refreshed.review?.targetCommit).toBe(MOVED_TARGET);
    const old = await service.classifyReview(first.reviewId);
    expect(old.ok && old.value.targetCommit).toBe(TARGET);
    expect(old.ok && old.value.comparisonRevision).toBe(first.comparisonRevision);
  });

  it('refuses an unknown review', async () => {
    const service = serviceOver(mutableSource(), scriptedGit());
    expect(await service.classifyReview('Q'.repeat(22))).toEqual({ ok: false, reason: 'review-not-found' });
    expect(await service.refreshReview('Q'.repeat(22))).toEqual({ ok: false, reason: 'review-not-found' });
  });
});

describe('a store read that throws (review R-2)', () => {
  const corrupt = (): never => {
    throw new Error('corrupt column');
  };
  const UNREADABLE_ELIGIBILITY = { eligible: false, reason: 'review-not-current' };

  it('reads a request read that throws as unavailable / record-unreadable with zero Git calls', async () => {
    const scripted = scriptedGit();
    const source = mutableSource();
    source.getRequest = corrupt;
    const service = serviceOver(source, scripted);
    expect(await service.openReview({ requestId: REQUEST_ID })).toEqual({
      ok: true,
      value: { state: 'unavailable', reason: 'record-unreadable', review: null, firstPage: null }
    });
    expect(scripted.calls).toHaveLength(0);
    expect(service.liveReviews()).toBe(0);
  });

  it('reads a receipt read that throws while opening as uncertain / record-unreadable', async () => {
    const source = mutableSource();
    source.getReceipt = corrupt;
    const service = serviceOver(source, scriptedGit());
    expect(opened(await service.openReview({ requestId: REQUEST_ID }))).toMatchObject({
      state: 'uncertain',
      reason: 'record-unreadable',
      review: { approval: UNREADABLE_ELIGIBILITY, landing: UNREADABLE_ELIGIBILITY }
    });
  });

  it.each([
    ['request', (source: MutableSource) => (source.getRequest = corrupt)],
    ['receipt', (source: MutableSource) => (source.getReceipt = corrupt)]
  ])('reads a %s read that throws on classify as uncertain with nothing eligible', async (_label, breakRead) => {
    const source = mutableSource();
    const service = serviceOver(source, scriptedGit());
    const { review } = built(await service.openReview({ requestId: REQUEST_ID }));
    breakRead(source);
    const classified = await service.classifyReview(review.reviewId);
    expect(classified.ok && classified.value).toMatchObject({
      state: 'uncertain',
      reason: 'record-unreadable',
      approval: UNREADABLE_ELIGIBILITY,
      landing: UNREADABLE_ELIGIBILITY
    });
  });

  it('reads a request read that throws on refresh as unavailable and keeps the old review', async () => {
    const source = mutableSource();
    const service = serviceOver(source, scriptedGit());
    const { review } = built(await service.openReview({ requestId: REQUEST_ID }));
    source.getRequest = corrupt;
    expect(opened(await service.refreshReview(review.reviewId))).toEqual({
      state: 'unavailable',
      reason: 'record-unreadable',
      review: null,
      firstPage: null
    });
    expect(service.liveReviews()).toBe(1);
  });
});
