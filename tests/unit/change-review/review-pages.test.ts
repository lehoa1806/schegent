// FR-R6-F12 T026 (FR-010, FR-011; research R8) — paging a review's loaded entries.
//
// WHAT THIS PINS:
//   - 1,000 loaded entries give five pages of 200, and the last has `nextCursor: null`;
//   - a cursor for another or closed review, a tampered cursor, an offset outside the loaded range
//     and a cursor over 128 characters are each refused `cursor-invalid`.

import { describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS } from '../../../src/contracts/change-review';
import { createChangeReviewService } from '../../../src/services/change-review/change-review-service';
import { decodeCursor, encodeCursor } from '../../../src/services/change-review/review-pages';
import { NULL_SHA, REQUEST_ID, mutableSource, scriptedGit } from './fake-review-git';

const Z = '\u0000';
const REVIEW_ID = 'A'.repeat(22);

function addedFiles(count: number): string {
  const raw: string[] = [];
  const numstat: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const blob = i.toString(16).padStart(40, '0');
    raw.push(`:000000 100644 ${NULL_SHA} ${blob} A${Z}f${i}.txt${Z}`);
    numstat.push(`1\t0\tf${i}.txt${Z}`);
  }
  return raw.join('') + numstat.join('');
}

async function openedOver(count: number) {
  let counter = 0;
  const service = createChangeReviewService({
    source: mutableSource(),
    git: scriptedGit(addedFiles(count)).git,
    cwd: '/repo',
    random: (size) => {
      counter += 1;
      const bytes = new Uint8Array(size);
      new DataView(bytes.buffer).setUint32(0, counter);
      return bytes;
    }
  });
  const result = await service.openReview({ requestId: REQUEST_ID });
  if (!result.ok || result.value.review === null) throw new Error('not built');
  return { service, review: result.value.review, firstPage: result.value.firstPage };
}

describe('cursor encoding', () => {
  it('round-trips a review and an offset', () => {
    const cursor = encodeCursor(REVIEW_ID, 400);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThanOrEqual(CHANGE_REVIEW_LIMITS.cursorCharsMax);
    expect(decodeCursor(cursor)).toEqual({ reviewId: REVIEW_ID, offset: 400 });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a+b/c='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an array', Buffer.from('[1]').toString('base64url')],
    ['an extra key', Buffer.from(JSON.stringify({ r: REVIEW_ID, o: 0, x: 1 })).toString('base64url')],
    ['a short review id', Buffer.from(JSON.stringify({ r: 'A', o: 0 })).toString('base64url')],
    ['a negative offset', Buffer.from(JSON.stringify({ r: REVIEW_ID, o: -1 })).toString('base64url')],
    ['a fractional offset', Buffer.from(JSON.stringify({ r: REVIEW_ID, o: 1.5 })).toString('base64url')],
    ['a string offset', Buffer.from(JSON.stringify({ r: REVIEW_ID, o: '1' })).toString('base64url')],
    ['an over-long cursor', 'A'.repeat(CHANGE_REVIEW_LIMITS.cursorCharsMax + 1)]
  ])('refuses %s', (_label, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});

describe('readPage', () => {
  it('pages 1,000 loaded entries in five pages of 200', async () => {
    const { service, review, firstPage } = await openedOver(1050);
    expect(review).toMatchObject({ total: 1050, loaded: 1000, truncated: true });
    expect(firstPage.entries).toHaveLength(CHANGE_REVIEW_LIMITS.pageEntriesMax);
    let cursor = firstPage.nextCursor;
    const sizes = [firstPage.entries.length];
    let lastIndex = firstPage.entries.at(-1)?.index;
    while (cursor !== null) {
      const page = service.readPage(cursor);
      if (!page.ok) throw new Error(page.reason);
      expect(page.value.entries.at(0)?.index).toBe((lastIndex ?? -1) + 1);
      lastIndex = page.value.entries.at(-1)?.index;
      sizes.push(page.value.entries.length);
      cursor = page.value.nextCursor;
    }
    expect(sizes).toEqual([200, 200, 200, 200, 200]);
    expect(lastIndex).toBe(999);
  });

  it('refuses a cursor for another review, a closed review or an offset past the loaded range', async () => {
    const { service, review, firstPage } = await openedOver(250);
    const next = firstPage.nextCursor ?? '';
    expect(service.readPage(next).ok).toBe(true);
    expect(service.readPage(encodeCursor(REVIEW_ID, 200))).toEqual({ ok: false, reason: 'cursor-invalid' });
    expect(service.readPage(encodeCursor(review.reviewId, 250))).toEqual({ ok: false, reason: 'cursor-invalid' });
    expect(service.readPage(`${next}x`)).toEqual({ ok: false, reason: 'cursor-invalid' });
    service.closeReview(review.reviewId);
    expect(service.readPage(next)).toEqual({ ok: false, reason: 'cursor-invalid' });
  });
});
