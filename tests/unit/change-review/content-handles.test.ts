// FR-R6-F12 T009 (FR-005, FR-008; research R8) — live reviews and their content handles.
//
// WHAT THIS PINS:
//   - a handle and a review id are 22-character base64url values from 16 random bytes;
//   - at most eight reviews stay live, and a ninth evicts the oldest together with its handles;
//   - closing a review drops its handles, and an unknown handle or review is `null`.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS } from '../../../src/contracts/change-review';
import {
  createReviewRegistry,
  opaqueId,
  type ContentResource
} from '../../../src/services/change-review/content-handles';

function resource(handle: string, reviewId: string): ContentResource {
  return { handle, reviewId, blob: 'a'.repeat(40), mode: '100644', binary: false };
}

describe('opaqueId', () => {
  it('is 22 base64url characters and unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => opaqueId(randomBytes)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('draws exactly 16 bytes', () => {
    const sizes: number[] = [];
    opaqueId((size) => {
      sizes.push(size);
      return new Uint8Array(size);
    });
    expect(sizes).toEqual([16]);
  });
});

describe('createReviewRegistry', () => {
  it('keeps a review and resolves its handles', () => {
    const registry = createReviewRegistry<string>(CHANGE_REVIEW_LIMITS.liveReviewsMax);
    registry.add('r1', 'one', [resource('h1', 'r1'), resource('h2', 'r1')]);
    expect(registry.get('r1')).toBe('one');
    expect(registry.resource('h2')?.reviewId).toBe('r1');
    expect(registry.resource('nope')).toBeNull();
    expect(registry.get('nope')).toBeNull();
  });

  it('evicts the oldest review and its handles when a ninth opens', () => {
    const registry = createReviewRegistry<number>(CHANGE_REVIEW_LIMITS.liveReviewsMax);
    for (let i = 0; i < CHANGE_REVIEW_LIMITS.liveReviewsMax; i += 1) {
      expect(registry.add(`r${i}`, i, [resource(`h${i}`, `r${i}`)])).toEqual([]);
    }
    expect(registry.add('r8', 8, [resource('h8', 'r8')])).toEqual(['r0']);
    expect(registry.get('r0')).toBeNull();
    expect(registry.resource('h0')).toBeNull();
    expect(registry.get('r1')).toBe(1);
    expect(registry.resource('h8')?.reviewId).toBe('r8');
    expect(registry.size()).toBe(CHANGE_REVIEW_LIMITS.liveReviewsMax);
  });

  it('drops the handles of a closed review', () => {
    const registry = createReviewRegistry<string>(2);
    registry.add('r1', 'one', [resource('h1', 'r1')]);
    expect(registry.close('r1')).toBe(true);
    expect(registry.close('r1')).toBe(false);
    expect(registry.resource('h1')).toBeNull();
    expect(registry.get('r1')).toBeNull();
  });

  it('replaces the value of a live review only', () => {
    const registry = createReviewRegistry<string>(2);
    registry.add('r1', 'one', []);
    expect(registry.replace('r1', 'uno')).toBe(true);
    expect(registry.get('r1')).toBe('uno');
    expect(registry.replace('r2', 'dos')).toBe(false);
    expect(registry.get('r2')).toBeNull();
  });
});
