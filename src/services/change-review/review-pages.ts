/**
 * FR-R6-F12 (FR-010, FR-011; research R8) — cursors and pages over a review's loaded entries.
 *
 * A cursor is base64url JSON `{ r, o }`: the review id and the offset of the next page. It is
 * accepted only in its one canonical form, so a tampered or padded cursor never decodes to a
 * neighbouring value. Whether the review is live and the offset in range is the caller's check.
 */

import { CHANGE_REVIEW_LIMITS, type ChangeEntry, type ReviewPage } from '../../contracts/change-review';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CURSOR_KEYS = 'o,r';

export interface CursorValue {
  readonly reviewId: string;
  readonly offset: number;
}

/** The cursor for the page of `reviewId` that starts at `offset`. */
export function encodeCursor(reviewId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ r: reviewId, o: offset })).toString('base64url');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function cursorValueOf(parsed: unknown): CursorValue | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== CURSOR_KEYS) return null;
  const { r, o } = parsed as { r: unknown; o: unknown };
  if (typeof r !== 'string' || !REVIEW_ID_PATTERN.test(r)) return null;
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) return null;
  return { reviewId: r, offset: o };
}

/** The value of a well-formed canonical cursor, or `null`. */
export function decodeCursor(cursor: string): CursorValue | null {
  if (cursor.length === 0 || cursor.length > CHANGE_REVIEW_LIMITS.cursorCharsMax) return null;
  if (!BASE64URL_PATTERN.test(cursor)) return null;
  const value = cursorValueOf(parseJson(Buffer.from(cursor, 'base64url').toString('utf8')));
  if (value === null || encodeCursor(value.reviewId, value.offset) !== cursor) return null;
  return value;
}

/** The page of `entries` starting at `offset`, with the cursor for the next one or `null`. */
export function pageAt(reviewId: string, entries: readonly ChangeEntry[], offset: number): ReviewPage {
  const end = Math.min(offset + CHANGE_REVIEW_LIMITS.pageEntriesMax, entries.length);
  return {
    reviewId,
    entries: entries.slice(offset, end),
    nextCursor: end < entries.length ? encodeCursor(reviewId, end) : null
  };
}
