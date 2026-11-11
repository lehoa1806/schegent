// FR-R6-F12 T013 (FR-004, FR-014; contracts/change-review.md section 6) — opening a review in the
// editor.
//
// WHAT THIS PINS:
//   - native: one multi-file call holding every loaded entry in index order, with no left side
//     for an added file and no right side for a deleted one;
//   - fallback: a fixed notice that names counts and no path, an inert pick list, and one diff for
//     the picked entry; dismissing the pick opens nothing;
//   - an unavailable review opens nothing.

import { describe, expect, it } from 'vitest';
import type { ChangeEntry, ReviewDescriptor, ReviewOpened } from '../../../src/contracts/change-review';
import { openReviewInEditor, type ChangeTriple, type EditorPort } from '../../../src/ui/change-review/review-opener';
import { ABSENT_SEGMENT } from '../../../src/ui/change-review/review-uri';

const TARGET = '1234567890'.repeat(4);
const CANDIDATE = 'abcdef0123'.repeat(4);

const ENTRIES: readonly ChangeEntry[] = [
  { index: 0, kind: 'added', oldPath: null, newPath: 'a/new.txt', binary: false, oldHandle: null, newHandle: 'N0', similarity: null },
  { index: 1, kind: 'deleted', oldPath: 'gone.txt', newPath: null, binary: false, oldHandle: 'O1', newHandle: null, similarity: null },
  {
    index: 2,
    kind: 'renamed',
    oldPath: 'from.txt',
    newPath: '$(zap)to.txt',
    binary: false,
    oldHandle: 'O2',
    newHandle: 'N2',
    similarity: 90
  }
];

function descriptor(): ReviewDescriptor {
  return {
    reviewId: 'R'.repeat(22),
    requestId: 'f'.repeat(32),
    candidateId: 'cand',
    candidateCommit: CANDIDATE,
    targetRef: 'refs/heads/main',
    targetCommit: TARGET,
    profileRevision: 1,
    profileDigest: 'd',
    comparisonRevision: `cr1-${'0'.repeat(64)}`,
    total: 5,
    loaded: 3,
    truncated: true,
    state: 'current',
    reason: null,
    approval: { eligible: true, reason: null },
    landing: { eligible: false, reason: 'receipt-missing' },
    createdAt: '2026-11-11T00:00:00.000Z'
  };
}

function opened(): ReviewOpened {
  return { state: 'current', reason: null, review: descriptor(), firstPage: { reviewId: 'R'.repeat(22), entries: ENTRIES, nextCursor: null } };
}

interface Recorded {
  changes: Array<{ title: string; triples: readonly ChangeTriple[] }>;
  notices: string[];
  picks: Array<readonly string[]>;
  diffs: Array<{ left: string; right: string; title: string }>;
}

function fakePort(hasChanges: boolean, pickIndex: number | undefined): { readonly port: EditorPort; readonly seen: Recorded } {
  const seen: Recorded = { changes: [], notices: [], picks: [], diffs: [] };
  return {
    seen,
    port: {
      hasCommand: (id) => Promise.resolve(hasChanges && id === 'vscode.changes'),
      openChanges: (title, triples) => {
        seen.changes.push({ title, triples });
        return Promise.resolve();
      },
      showNotice: (text) => {
        seen.notices.push(text);
      },
      pick: (labels) => {
        seen.picks.push(labels);
        return Promise.resolve(pickIndex);
      },
      openDiff: (left, right, title) => {
        seen.diffs.push({ left, right, title });
        return Promise.resolve();
      }
    }
  };
}

describe('openReviewInEditor', () => {
  it('opens every loaded entry in one native call', async () => {
    const { port, seen } = fakePort(true, undefined);
    expect(await openReviewInEditor(port, opened(), ENTRIES)).toEqual({ mode: 'native', opened: 3 });
    expect(seen.changes).toHaveLength(1);
    const call = seen.changes.at(0);
    expect(call?.title).toBe(`Review ${TARGET.slice(0, 8)}..${CANDIDATE.slice(0, 8)}`);
    expect(call?.triples).toEqual([
      { label: '/N0/new.txt', left: undefined, right: '/N0/new.txt' },
      { label: '/O1/gone.txt', left: '/O1/gone.txt', right: undefined },
      { label: '/N2/$(zap)to.txt', left: '/O2/from.txt', right: '/N2/$(zap)to.txt' }
    ]);
    expect(seen.notices).toHaveLength(0);
  });

  it('falls back to a notice, a pick and one diff', async () => {
    const { port, seen } = fakePort(false, 0);
    expect(await openReviewInEditor(port, opened(), ENTRIES)).toEqual({ mode: 'fallback', opened: 1 });
    expect(seen.notices).toEqual([
      "The editor's multi-file review is not available. Pick a file to open its diff (3 of 5 files)."
    ]);
    const labels = seen.picks.at(0) ?? [];
    expect(labels).toHaveLength(3);
    expect(labels.some((label) => label.includes('$('))).toBe(false);
    expect(seen.diffs).toEqual([{ left: `/${ABSENT_SEGMENT}/new.txt`, right: '/N0/new.txt', title: 'new.txt (added)' }]);
  });

  it('opens nothing when the pick is dismissed', async () => {
    const { port, seen } = fakePort(false, undefined);
    expect(await openReviewInEditor(port, opened(), ENTRIES)).toEqual({ mode: 'fallback', opened: 0 });
    expect(seen.diffs).toHaveLength(0);
  });

  it('opens nothing for an unavailable review', async () => {
    const { port, seen } = fakePort(true, 0);
    const unavailable: ReviewOpened = { state: 'unavailable', reason: 'commit-missing', review: null, firstPage: null };
    expect(await openReviewInEditor(port, unavailable, [])).toEqual({ mode: 'none', opened: 0 });
    expect(seen.changes).toHaveLength(0);
    expect(seen.notices).toHaveLength(0);
  });
});
