// FR-R6-F12 T030 (contracts/change-review.md section 1; FR-013, FR-016, SC-005, NFR-005) — the
// headless change review port.

import { describe, expect, it } from 'vitest';
import type { GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { createChangeReviewService } from '../../../src/services/change-review/index';
import { createChangeReviewApi } from '../../../src/headless/change-review-api';
import { REQUEST_ID, mutableSource, scriptedGit } from '../change-review/fake-review-git';

const REVISION = `cr1-${'0'.repeat(64)}`;
const REVIEW_ID = 'A'.repeat(22);

interface Harness {
  readonly api: ReturnType<typeof createChangeReviewApi>;
  readonly source: ReturnType<typeof mutableSource>;
  readonly calls: string[][];
  trusted: boolean;
  hold(): () => void;
}

function harness(): Harness {
  const scripted = scriptedGit();
  const source = mutableSource();
  let gate: Promise<void> | null = null;
  const git: LaneGitRunner = {
    run: async (args, options): Promise<GitRunResult> => {
      if (gate !== null) await gate;
      return scripted.git.run(args, options);
    }
  };
  const service = createChangeReviewService({ source, git, cwd: '/repo' });
  const state: Harness = {
    api: createChangeReviewApi(service, { isWorkspaceTrusted: () => state.trusted }),
    source,
    calls: scripted.calls,
    trusted: true,
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    }
  };
  return state;
}

const INVALID = { ok: false, reason: 'invalid-input' };
const UNTRUSTED = { ok: false, reason: 'workspace-untrusted' };

const HOSTILE_IDS: readonly unknown[] = [
  '../../etc/passwd',
  '/etc/passwd',
  'file:///etc/passwd',
  'command:workbench.action.terminal.new',
  '<img src=x onerror=alert(1)>',
  '[x](command:evil)',
  'F'.repeat(32),
  'f'.repeat(31),
  'f'.repeat(33),
  `${'f'.repeat(32)}\n`,
  '',
  42,
  null,
  ['f'.repeat(32)],
  { requestId: 'f'.repeat(32) }
];

describe('headless change review port: input shape (SC-005)', () => {
  it('refuses every malformed open request invalid-input with zero source and Git reads', async () => {
    const h = harness();
    const malformed: readonly unknown[] = [
      undefined,
      null,
      'f'.repeat(32),
      [],
      {},
      { requestId: REQUEST_ID, extra: 1 },
      { requestId: REQUEST_ID, expectedRevision: 'cr1-short' },
      { requestId: REQUEST_ID, expectedRevision: `cr2-${'0'.repeat(64)}` },
      { requestId: REQUEST_ID, expectedRevision: 7 },
      ...HOSTILE_IDS.map((requestId) => ({ requestId }))
    ];
    for (const input of malformed) {
      await expect(h.api.openReview(input)).resolves.toEqual(INVALID);
    }
    expect(h.source.reads).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('refuses malformed review ids and cursors on every other operation', async () => {
    const h = harness();
    const badIds: readonly unknown[] = [
      {},
      { reviewId: 'A'.repeat(21) },
      { reviewId: 'A'.repeat(23) },
      { reviewId: `${'A'.repeat(21)}/` },
      { reviewId: `${'A'.repeat(21)}=` },
      { reviewId: REVIEW_ID, extra: true },
      { reviewId: 5 }
    ];
    for (const input of badIds) {
      await expect(h.api.classifyReview(input)).resolves.toEqual(INVALID);
      await expect(h.api.refreshReview(input)).resolves.toEqual(INVALID);
      expect(h.api.closeReview(input)).toEqual(INVALID);
    }
    const badCursors: readonly unknown[] = [{}, { cursor: '' }, { cursor: 'a'.repeat(129) }, { cursor: 'abc+/' }, { cursor: 1 }, { cursor: 'abc', extra: 1 }];
    for (const input of badCursors) {
      expect(h.api.readPage(input)).toEqual(INVALID);
    }
    expect(h.api.cancelOpen({ extra: 1 })).toEqual(INVALID);
    expect(h.api.cancelOpen(null)).toEqual(INVALID);
    expect(h.source.reads).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('accepts the exact shapes', async () => {
    const h = harness();
    const opened = await h.api.openReview({ requestId: REQUEST_ID });
    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.value.review === null) return;
    const reviewId = opened.value.review.reviewId;
    const revision = opened.value.review.comparisonRevision;
    await expect(h.api.openReview({ requestId: REQUEST_ID, expectedRevision: revision })).resolves.toMatchObject({ ok: true });
    await expect(h.api.openReview({ requestId: REQUEST_ID, expectedRevision: REVISION })).resolves.toEqual({
      ok: false,
      reason: 'revision-mismatch'
    });
    await expect(h.api.classifyReview({ reviewId })).resolves.toMatchObject({ ok: true });
    await expect(h.api.refreshReview({ reviewId })).resolves.toMatchObject({ ok: true });
    expect(h.api.readPage({ cursor: 'AAAA' })).toEqual({ ok: false, reason: 'cursor-invalid' });
    expect(h.api.closeReview({ reviewId })).toEqual({ ok: true, value: { closed: true } });
    expect(h.api.cancelOpen({})).toEqual({ ok: true, value: { canceled: false } });
  });
});

describe('headless change review port: workspace trust', () => {
  it('refuses reads while untrusted, before any read', async () => {
    const h = harness();
    h.trusted = false;
    await expect(h.api.openReview({ requestId: REQUEST_ID })).resolves.toEqual(UNTRUSTED);
    await expect(h.api.classifyReview({ reviewId: REVIEW_ID })).resolves.toEqual(UNTRUSTED);
    await expect(h.api.refreshReview({ reviewId: REVIEW_ID })).resolves.toEqual(UNTRUSTED);
    expect(h.api.readPage({ cursor: 'AAAA' })).toEqual(UNTRUSTED);
    expect(h.source.reads).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('shape is checked before trust', async () => {
    const h = harness();
    h.trusted = false;
    await expect(h.api.openReview({ requestId: 'x' })).resolves.toEqual(INVALID);
  });

  it('closeReview and cancelOpen work while untrusted', async () => {
    const h = harness();
    const opened = await h.api.openReview({ requestId: REQUEST_ID });
    if (!opened.ok || opened.value.review === null) throw new Error('open failed');
    h.trusted = false;
    expect(h.api.closeReview({ reviewId: opened.value.review.reviewId })).toEqual({ ok: true, value: { closed: true } });
    expect(h.api.cancelOpen({})).toEqual({ ok: true, value: { canceled: false } });
  });

  it('reads trust at each call', async () => {
    const h = harness();
    h.trusted = false;
    await expect(h.api.openReview({ requestId: REQUEST_ID })).resolves.toEqual(UNTRUSTED);
    h.trusted = true;
    await expect(h.api.openReview({ requestId: REQUEST_ID })).resolves.toMatchObject({ ok: true });
  });
});

describe('headless change review port: one view (FR-016, NFR-002)', () => {
  it('two openReview calls give superseded, then the result', async () => {
    const h = harness();
    const release = h.hold();
    const first = h.api.openReview({ requestId: REQUEST_ID });
    const second = h.api.openReview({ requestId: REQUEST_ID });
    await expect(first).resolves.toEqual({ ok: false, reason: 'superseded' });
    release();
    await expect(second).resolves.toMatchObject({ ok: true, value: { state: 'current' } });
  });

  it('a refresh supersedes a pending open', async () => {
    const h = harness();
    const opened = await h.api.openReview({ requestId: REQUEST_ID });
    if (!opened.ok || opened.value.review === null) throw new Error('open failed');
    const release = h.hold();
    const pendingOpen = h.api.openReview({ requestId: REQUEST_ID });
    const refresh = h.api.refreshReview({ reviewId: opened.value.review.reviewId });
    await expect(pendingOpen).resolves.toEqual({ ok: false, reason: 'superseded' });
    release();
    await expect(refresh).resolves.toMatchObject({ ok: true });
  });

  it('cancelOpen answers while a Git read is pending', async () => {
    const h = harness();
    const release = h.hold();
    const pendingOpen = h.api.openReview({ requestId: REQUEST_ID });
    expect(h.api.cancelOpen({})).toEqual({ ok: true, value: { canceled: true } });
    await expect(pendingOpen).resolves.toEqual({ ok: false, reason: 'canceled' });
    release();
    expect(h.api.cancelOpen({})).toEqual({ ok: true, value: { canceled: false } });
  });
});
