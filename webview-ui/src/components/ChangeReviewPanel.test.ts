/**
 * CR-311-4 — focused regression tests for ChangeReviewPanel lifecycle gating and cancelOpen
 * stale-response protection (zero gated IPC on secondary/untrusted or idle primary unmount/nav,
 * active-open cancelOpen on unmount/nav, and late cancelOpen response not clobbering newer open).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

import { buildIdleSnapshot } from '../../../src/ui/sidebar/snapshot';
import type { ChangeEntry, ReviewDescriptor, ReviewOpened } from '../../../src/contracts/change-review';
import {
  STATE_SNAPSHOT,
  type ExecutionLaneCandidateVisibility,
  type OpenChangeReviewRequest,
  type OpenChangeReviewResponse
} from '../lib/messages';
import type { VisibilityCallEnvelope } from '../lib/execution-visibility-ipc';
import { resetHostTransport, setHostTransport } from '../lib/host-transport';
import { snapshotStore } from '../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../lib/snapshot-types';
import { sanitizeReviewDisplayPath } from '../lib/visibility-panel-labels';
import ChangeReviewPanel from './ChangeReviewPanel.svelte';

const mockChangeReview =
  vi.fn<
    (req: OpenChangeReviewRequest) => Promise<VisibilityCallEnvelope<OpenChangeReviewResponse>>
  >();

vi.mock('../lib/execution-visibility-ipc', () => ({
  requestChangeReview: (req: OpenChangeReviewRequest) => mockChangeReview(req)
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeLane(
  overrides: Partial<ExecutionLaneCandidateVisibility> = {}
): ExecutionLaneCandidateVisibility {
  return {
    mode: 'isolated-lane',
    laneId: '1'.repeat(32),
    laneState: 'completed',
    candidateId: '3'.repeat(32),
    integrationRequestId: '4'.repeat(32),
    integrationState: 'awaiting-review',
    targetRef: 'refs/heads/main',
    comparisonRevision: `cr1-${'a'.repeat(64)}`,
    ...overrides
  };
}

function makeDescriptor(overrides: Partial<ReviewDescriptor> = {}): ReviewDescriptor {
  return {
    reviewId: 'rev_cr311_4',
    requestId: '4'.repeat(32),
    candidateId: '3'.repeat(32),
    candidateCommit: 'c'.repeat(40),
    targetRef: 'refs/heads/main',
    targetCommit: 'a'.repeat(40),
    profileRevision: 1,
    profileDigest: 'd'.repeat(64),
    comparisonRevision: `cr1-${'a'.repeat(64)}`,
    state: 'current',
    reason: null,
    total: 1,
    loaded: 1,
    truncated: false,
    approval: { eligible: true, reason: null },
    landing: { eligible: true, reason: null },
    createdAt: '2026-11-23T00:00:00.000Z',
    ...overrides
  };
}

function makeOpenedReview(
  overrides: Partial<ReviewDescriptor> = {},
  filePath = 'src/changed.ts'
): ReviewOpened {
  const review = makeDescriptor(overrides);
  return {
    state: review.state === 'stale' ? 'stale' : review.state === 'uncertain' ? 'uncertain' : 'current',
    reason: review.reason,
    review,
    firstPage: {
      reviewId: review.reviewId,
      entries: [
        {
          index: 0,
          kind: 'modified',
          oldPath: filePath,
          newPath: filePath,
          binary: false,
          oldHandle: 'h-old',
          newHandle: 'h-new',
          similarity: null
        }
      ],
      nextCursor: null
    }
  };
}

const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function restoreDocumentVisibility(): void {
  if (originalVisibilityDescriptor !== undefined) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
}

function makeSnapshot(revision: number, isPrimary = true): WorkflowSnapshot {
  return buildIdleSnapshot({
    isPrimary,
    producedAt: `2026-11-23T00:00:${String(revision).padStart(2, '0')}.000Z`
  }) as unknown as WorkflowSnapshot;
}

function applyFullSnapshot(revision: number, isPrimary = true): void {
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot(revision, isPrimary),
    sync: { mode: 'full', revision }
  });
  flushSync();
}

function triggerSnapshotResync(nextRevision: number, isPrimary = true): void {
  const prevResync = snapshotStore.resyncCount;
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot(nextRevision, isPrimary),
    sync: {
      mode: 'routine',
      revision: nextRevision,
      baseRevision: nextRevision - 1,
      omittedSlices: []
    }
  });
  expect(snapshotStore.resyncCount).toBe(prevResync + 1);
  applyFullSnapshot(nextRevision + 1, isPrimary);
}

describe('ChangeReviewPanel lifecycle & stale cancelOpen guards (CR-311-4)', () => {
  beforeEach(() => {
    mockChangeReview.mockReset();
    snapshotStore.resetSyncState();
    resetHostTransport();
    setHostTransport({
      postMessage() {},
      onMessage() {
        return () => {};
      },
      getState() {
        return undefined;
      },
      setState() {}
    });
  });

  afterEach(() => {
    cleanup();
    restoreDocumentVisibility();
    snapshotStore.resetSyncState();
    resetHostTransport();
  });

  it('sends zero IPC commands on lane switch or unmount in secondary/untrusted windows', async () => {
    const laneA = makeLane({ integrationRequestId: '4'.repeat(32) });
    const laneB = makeLane({ integrationRequestId: '5'.repeat(32) });

    const { rerender, unmount } = render(ChangeReviewPanel, {
      props: { lane: laneA, isPrimary: false }
    });

    await rerender({ lane: laneB, isPrimary: false });
    await tick();
    unmount();
    await tick();

    expect(mockChangeReview).not.toHaveBeenCalled();
  });

  it('sends zero cancelOpen or close on unmount or lane switch in an idle primary window', async () => {
    const laneA = makeLane({ integrationRequestId: '4'.repeat(32) });
    const laneB = makeLane({ integrationRequestId: '5'.repeat(32) });

    const { rerender, unmount } = render(ChangeReviewPanel, {
      props: { lane: laneA, isPrimary: true }
    });

    await rerender({ lane: laneB, isPrimary: true });
    await tick();
    unmount();
    await tick();

    expect(mockChangeReview).not.toHaveBeenCalled();
  });

  it('sends cancelOpen on unmount when a primary open is actively in flight', async () => {
    const pendingOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    mockChangeReview.mockImplementation((req) => {
      if (req.op === 'open') return pendingOpen.promise;
      if (req.op === 'cancelOpen') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'cancelOpen', canceled: true }
        });
      }
      return Promise.resolve({
        boundaryRefusal: null,
        response: { op: 'close', closed: true }
      });
    });

    const { getByTestId, unmount } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    expect(mockChangeReview).toHaveBeenCalledTimes(1);
    expect(mockChangeReview).toHaveBeenCalledWith(expect.objectContaining({ op: 'open' }));

    unmount();
    await tick();

    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'cancelOpen' });

    // Resolving the canceled open late still closes the orphaned handle
    pendingOpen.resolve({
      boundaryRefusal: null,
      response: {
        op: 'open',
        editor: { mode: 'none', opened: 0 },
        result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_late_unmount' }) }
      }
    });
    await vi.waitFor(() => {
      expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_late_unmount' });
    });
  });

  it('sends close without cancelOpen on unmount when a primary review has already settled', async () => {
    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_settled_1' }) }
          }
        };
      }
      return { boundaryRefusal: null, response: { op: 'close', closed: true } };
    });

    const { getByTestId, findByTestId, unmount } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await findByTestId('change-review-file-list');
    mockChangeReview.mockClear();

    unmount();
    await tick();

    expect(mockChangeReview).toHaveBeenCalledTimes(1);
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_settled_1' });
  });

  it('ignores a late cancelOpen response so it cannot overwrite a newer openReview statusNotice', async () => {
    const firstOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    const slowCancel = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    const secondOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    let openCalls = 0;

    mockChangeReview.mockImplementation((req) => {
      if (req.op === 'open') {
        openCalls += 1;
        return openCalls === 1 ? firstOpen.promise : secondOpen.promise;
      }
      if (req.op === 'cancelOpen') {
        return slowCancel.promise;
      }
      return Promise.resolve({
        boundaryRefusal: null,
        response: { op: 'close', closed: true }
      });
    });

    const { getByTestId, findByTestId } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    // 1. Start first open, then click Cancel open (slowCancel stays pending)
    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await fireEvent.click(await findByTestId('change-review-cancel-btn'));

    // 2. Immediately start a second openReview and resolve it cleanly
    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    secondOpen.resolve({
      boundaryRefusal: null,
      response: {
        op: 'open',
        editor: { mode: 'none', opened: 0 },
        result: {
          ok: true,
          value: makeOpenedReview({ reviewId: 'rev_newer_2' }, 'src/newer.ts')
        }
      }
    });

    await findByTestId('change-review-file-list');
    const loadedNotice = getByTestId('change-review-status').textContent;
    expect(loadedNotice).toContain('Loaded 1 of 1 changed file(s)');

    // 3. Now resolve the stale cancelOpen response AFTER the newer openReview finished
    slowCancel.resolve({
      boundaryRefusal: null,
      response: { op: 'cancelOpen', canceled: true }
    });
    await tick();

    // Newer openReview statusNotice and file inventory MUST remain untouched
    expect(getByTestId('change-review-status').textContent).toBe(loadedNotice);
    expect(getByTestId('change-review-file-list').textContent).toContain('src/newer.ts');
  });

  it('does not abort an in-flight refreshReview or leak openInFlight on visibilitychange / snapshotStore resync (CR-311-5)', async () => {
    applyFullSnapshot(1, true);
    const pendingRefresh = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();

    mockChangeReview.mockImplementation((req) => {
      if (req.op === 'open') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_initial_1' }, 'src/initial.ts') }
          }
        });
      }
      if (req.op === 'refresh') {
        return pendingRefresh.promise;
      }
      if (req.op === 'classify') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'classify',
            result: { ok: true, value: makeDescriptor({ reviewId: 'rev_initial_1' }) }
          }
        });
      }
      if (req.op === 'cancelOpen') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'cancelOpen', canceled: true }
        });
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', closed: true } });
    });

    const { getByTestId, findByTestId, unmount } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await findByTestId('change-review-file-list');

    // Start refreshReview (loading === true, openInFlight === true)
    await fireEvent.click(getByTestId('change-review-refresh-btn'));
    expect(mockChangeReview).toHaveBeenCalledWith({
      op: 'refresh',
      reviewId: 'rev_initial_1',
      openInEditor: false
    });

    // Fire hide/reveal visibilitychange AND snapshotStore resync while refresh is still in flight
    setDocumentVisibility('hidden');
    setDocumentVisibility('visible');
    triggerSnapshotResync(3, true);
    await tick();

    // Neither resync path may preempt the in-flight refresh with a classify request
    expect(mockChangeReview).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'classify' }));

    // Resolve the refresh cleanly
    pendingRefresh.resolve({
      boundaryRefusal: null,
      response: {
        op: 'refresh',
        editor: { mode: 'none', opened: 0 },
        result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_refreshed_2' }, 'src/refreshed.ts') }
      }
    });

    await vi.waitFor(() => {
      expect(getByTestId('change-review-file-list').textContent).toContain('src/refreshed.ts');
      expect(getByTestId('change-review-status').textContent).toContain('Refreshed 1 of 1');
    });
    // Old review closed; refreshed review kept live
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_initial_1' });
    expect(mockChangeReview).not.toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_refreshed_2' });

    // Unmounting afterward MUST send only close (proving openInFlight was reset to false)
    mockChangeReview.mockClear();
    unmount();
    await tick();

    expect(mockChangeReview).toHaveBeenCalledTimes(1);
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_refreshed_2' });
    expect(mockChangeReview).not.toHaveBeenCalledWith({ op: 'cancelOpen' });
  });

  it('closes the previously live review when Inspect changed files (open) returns unavailable (CR-311-6)', async () => {
    let openCalls = 0;
    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        openCalls += 1;
        if (openCalls === 1) {
          return {
            boundaryRefusal: null,
            response: {
              op: 'open',
              editor: { mode: 'none', opened: 0 },
              result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_live_old' }, 'src/live.ts') }
            }
          };
        }
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: {
              ok: true,
              value: {
                state: 'unavailable',
                reason: 'commit-missing',
                review: null,
                firstPage: null
              }
            }
          }
        };
      }
      return { boundaryRefusal: null, response: { op: 'close', closed: true } };
    });

    const { getByTestId, findByTestId, unmount } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await findByTestId('change-review-file-list');
    mockChangeReview.mockClear();

    // Click Inspect changed files again over the live review; host reports unavailable
    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await findByTestId('change-review-unavailable');

    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_live_old' });

    // Unmount afterward sends zero additional IPC because oldReviewId was already closed
    mockChangeReview.mockClear();
    unmount();
    await tick();
    expect(mockChangeReview).not.toHaveBeenCalled();
  });

  it('sanitizes bidi overrides, isolates, directional marks, and control characters in rendered filenames (SR-A2 #4)', async () => {
    const hostileEntries: readonly ChangeEntry[] = [
      {
        index: 0,
        kind: 'modified',
        oldPath: 'src/ok.ts',
        newPath: 'src/\u202Egpj.exe\u2066/\u200Fbad\x07.ts',
        binary: false,
        oldHandle: 'h-old-0',
        newHandle: 'h-new-0',
        similarity: null
      },
      {
        index: 1,
        kind: 'renamed',
        oldPath: 'old/\u202Efrom\u2066\u200F\x07.ts',
        newPath: 'new/clean.ts',
        binary: false,
        oldHandle: 'h-old-1',
        newHandle: 'h-new-1',
        similarity: 90
      }
    ];

    const review = makeDescriptor({ reviewId: 'rev_bidi_1', total: 2, loaded: 2 });
    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: {
              ok: true,
              value: {
                state: 'current',
                reason: null,
                review,
                firstPage: {
                  reviewId: review.reviewId,
                  entries: hostileEntries,
                  nextCursor: null
                }
              }
            }
          }
        };
      }
      return { boundaryRefusal: null, response: { op: 'close', closed: true } };
    });

    const { getByTestId, findByTestId } = render(ChangeReviewPanel, {
      props: { lane: makeLane(), isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    const fileList = await findByTestId('change-review-file-list');
    const rendered = fileList.textContent;

    expect(rendered).toContain('src/\uFFFDgpj.exe\uFFFD/\uFFFDbad\uFFFD.ts');
    expect(rendered).toContain('(from old/\uFFFDfrom\uFFFD\uFFFD\uFFFD.ts, 90% match)');
    for (const forbidden of ['\u202E', '\u2066', '\u200F', '\x07']) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(rendered).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);

    // Direct helper checks for null/undefined, line/paragraph separators, lone surrogates, and valid emoji
    expect(sanitizeReviewDisplayPath(null)).toBe('');
    expect(sanitizeReviewDisplayPath(undefined)).toBe('');
    expect(sanitizeReviewDisplayPath('a\u2028b\u2029c\uD800d\uD83D\uDE00')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uD83D\uDE00');
  });

  it('sanitizes Trojan Source bidi overrides and isolates in lane.targetRef (SR-A3 #5)', async () => {
    const getIntegrationValue = (container: HTMLElement): string => {
      const dt = Array.from(container.querySelectorAll('dt')).find(
        (el) => el.textContent.trim() === 'Integration'
      );
      const dd = dt?.nextElementSibling;
      if (!dd) throw new Error('expected Integration <dd>');
      return dd.textContent;
    };

    const { container, rerender } = render(ChangeReviewPanel, {
      props: {
        lane: makeLane({ targetRef: 'main\u202Egpj.exe' }),
        isPrimary: true
      }
    });

    const renderedRlo = getIntegrationValue(container);
    expect(renderedRlo).toContain('→ main\uFFFDgpj.exe');
    expect(renderedRlo).not.toContain('\u202E');
    expect(renderedRlo).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);

    await rerender({
      lane: makeLane({ targetRef: 'release/\u2066fake\u2069main' }),
      isPrimary: true
    });
    await tick();

    const renderedIsolate = getIntegrationValue(container);
    expect(renderedIsolate).toContain('→ release/\uFFFDfake\uFFFDmain');
    expect(renderedIsolate).not.toContain('\u2066');
    expect(renderedIsolate).not.toContain('\u2069');
    expect(renderedIsolate).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
  });
});
