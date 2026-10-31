// Feature 020 T043 — PhaseLogReadingPane: LIVE indicator + auto-scroll
// suppression + "↓ N new entries" affordance.
//
// Scope split:
//   • LIVE indicator assertions exercise the prop wiring that landed
//     with T038 (the `isLive` prop already toggles the
//     `phase-log-live-indicator` testid in the DOM).
//   • Auto-scroll-suppression and the "↓ N new entries" affordance are
//     specified by T052 and intentionally fail until T052 lands. This
//     test file codifies the contract so the implementation has zero
//     design ambiguity.
//
// Implementation note (T052): the heuristic is
// `scrollTop + clientHeight ≥ scrollHeight - 16` for stickiness. When
// the user scrolls up beyond that threshold, new entries arriving via
// rerender MUST NOT auto-scroll the container; instead, a clickable
// "↓ N new entries" affordance with testid `phase-log-new-entries`
// MUST appear, and clicking it MUST scroll the entry list to the
// bottom and clear the affordance.

import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import PhaseLogReadingPane from '../PhaseLogReadingPane.svelte';
import type { PhaseLogDisplayEntry } from '../../../../../src/services/phase-log/types';

afterEach(() => cleanup());

function makeEntry(seq: number, text: string): PhaseLogDisplayEntry {
  return Object.freeze({
    seq,
    kind: 'assistant-text',
    ts: null,
    body: { text },
    bodyTruncated: null
  });
}

function buildEntries(n: number): readonly PhaseLogDisplayEntry[] {
  const out: PhaseLogDisplayEntry[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(makeEntry(i, `entry-${i}`));
  }
  return Object.freeze(out);
}

describe('Feature 020 T043 — PhaseLogReadingPane LIVE indicator', () => {
  it('renders the LIVE indicator when isLive={true}', () => {
    const { getByTestId } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(1),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    const live = getByTestId('phase-log-live-indicator');
    expect(live).not.toBeNull();
    expect((live.textContent ?? '').toUpperCase()).toContain('LIVE');
  });

  it('omits the LIVE indicator when isLive={false}', () => {
    const { queryByTestId } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(1),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: false
      }
    });
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();
  });

  it('omits the LIVE indicator when isLive prop is not supplied (defaults to false)', () => {
    const { queryByTestId } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(1),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0
      }
    });
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();
  });

  it('LIVE indicator toggles in/out of the DOM when isLive prop flips', async () => {
    const { queryByTestId, rerender } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(1),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: false
      }
    });
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();

    await rerender({
      entries: buildEntries(1),
      loading: false,
      skippedLines: 0,
      truncatedCount: 0,
      isLive: true
    });
    expect(queryByTestId('phase-log-live-indicator')).not.toBeNull();

    await rerender({
      entries: buildEntries(1),
      loading: false,
      skippedLines: 0,
      truncatedCount: 0,
      isLive: false
    });
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();
  });
});

// Auto-scroll-suppression + "↓ N new entries" affordance (T052
// contract). These tests intentionally fail until T052 lands.
describe('Feature 020 T043 — auto-scroll suppression (T052 contract)', () => {
  it('exposes the entry list with a stable testid for scroll-state interaction', () => {
    const { getByTestId } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(5),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    // T052 contract: the scroll container that owns the auto-scroll
    // heuristic MUST expose `data-testid="phase-log-entry-list"`.
    expect(getByTestId('phase-log-entry-list')).not.toBeNull();
  });

  it('does NOT render the "↓ N new entries" affordance when the user is sticky-at-bottom', () => {
    const { queryByTestId, getByTestId } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(3),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    // Default state on initial render: container is sticky-at-bottom
    // (no user scroll yet). Affordance is not shown.
    expect(getByTestId('phase-log-entry-list')).not.toBeNull();
    expect(queryByTestId('phase-log-new-entries')).toBeNull();
  });

  it('renders the "↓ N new entries" affordance after the user scrolls up and new entries arrive', async () => {
    const { getByTestId, queryByTestId, rerender } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(3),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;

    // Simulate the user scrolling up — set the geometry so the
    // sticky-at-bottom heuristic (`scrollTop + clientHeight ≥
    // scrollHeight - 16`) evaluates to false.
    Object.defineProperty(list, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    await fireEvent.scroll(list);

    // Two new entries arrive while the user is scrolled up.
    await rerender({
      entries: buildEntries(5),
      loading: false,
      skippedLines: 0,
      truncatedCount: 0,
      isLive: true
    });

    const affordance = queryByTestId('phase-log-new-entries');
    expect(affordance).not.toBeNull();
    // Affordance count text MUST surface the new-entry delta (2 here).
    expect(affordance?.textContent ?? '').toMatch(/\b2\b/);
  });

  it('clicking the "↓ N new entries" affordance scrolls to bottom and clears the affordance', async () => {
    const { getByTestId, queryByTestId, rerender } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(3),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;

    // Scroll up, then receive new entries to surface the affordance.
    Object.defineProperty(list, 'scrollTop', { value: 0, configurable: true, writable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    await fireEvent.scroll(list);

    await rerender({
      entries: buildEntries(6),
      loading: false,
      skippedLines: 0,
      truncatedCount: 0,
      isLive: true
    });

    const affordance = getByTestId('phase-log-new-entries');
    await fireEvent.click(affordance);

    // After click, the affordance MUST be removed.
    expect(queryByTestId('phase-log-new-entries')).toBeNull();
    // And the scroll-to-bottom intent MUST be reflected: either
    // `scrollTop` advances toward `scrollHeight - clientHeight`, or
    // `scrollTo`/`scrollIntoView` was invoked. We assert the simple
    // observable: scrollTop is no longer 0.
    const newScrollTop = (list as unknown as { scrollTop: number }).scrollTop;
    expect(newScrollTop).toBeGreaterThan(0);
  });

  it('does NOT render the "↓ N new entries" affordance when the user is sticky-at-bottom and new entries arrive', async () => {
    const { getByTestId, queryByTestId, rerender } = render(PhaseLogReadingPane, {
      props: {
        entries: buildEntries(3),
        loading: false,
        skippedLines: 0,
        truncatedCount: 0,
        isLive: true
      }
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;

    // Sticky-at-bottom geometry: scrollTop + clientHeight ≥ scrollHeight - 16.
    Object.defineProperty(list, 'scrollTop', { value: 800, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    await fireEvent.scroll(list);

    await rerender({
      entries: buildEntries(6),
      loading: false,
      skippedLines: 0,
      truncatedCount: 0,
      isLive: true
    });

    expect(queryByTestId('phase-log-new-entries')).toBeNull();
  });
});

// FR-R4-F08 (L-T3; FR-009, US2 AS3) — the pane at the live-tail cap.
//
// At the cap the host's window holds a `truncated-head` marker and 499 entries, and
// every push trims one entry while raising the marker's `droppedEntryCount` by one,
// so `entries.length` stops moving at 500. The "↓ N new entries" count therefore has
// to be taken over what was RECEIVED (the marker's count plus the real entries), or it
// sticks at 0 exactly when a paused reader most needs it. The cases are added to the
// existing file; none of the existing expectations changes.
describe('FR-R4-F08 L-T3 — the pane at the live-tail cap', () => {
  const REAL_ENTRIES_AT_CAP = 499;

  function windowAtCap(firstSeq: number, dropped: number): readonly PhaseLogDisplayEntry[] {
    const marker: PhaseLogDisplayEntry = Object.freeze({
      seq: -1,
      kind: 'truncated-head',
      ts: null,
      body: { droppedEntryCount: dropped },
      bodyTruncated: null
    });
    const real = Array.from({ length: REAL_ENTRIES_AT_CAP }, (_, index) =>
      makeEntry(firstSeq + index, `entry-${firstSeq + index}`)
    );
    return Object.freeze([marker, ...real]);
  }

  const paneProps = (entries: readonly PhaseLogDisplayEntry[]) => ({
    entries,
    loading: false,
    skippedLines: 0,
    truncatedCount: 0,
    isLive: true
  });

  /**
   * Writable geometry, so the pane's assignments to `scrollTop` can be observed.
   *
   * The pane defers one scroll-to-bottom to a microtask when it mounts sticky. That
   * assignment belongs to the mount, not to a push, so it is let through first and the
   * geometry is arranged after it.
   */
  async function giveGeometry(list: HTMLElement, scrollTop: number): Promise<void> {
    await tick();
    await Promise.resolve();
    Object.defineProperty(list, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  }

  it('sticky mode still scrolls to the newest entry after a push that trims', async () => {
    const { getByTestId, rerender } = render(PhaseLogReadingPane, {
      props: paneProps(windowAtCap(1, 10))
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;
    await giveGeometry(list, 800);
    await fireEvent.scroll(list);
    (list as unknown as { scrollTop: number }).scrollTop = 0;

    await rerender(paneProps(windowAtCap(2, 11)));
    await Promise.resolve();
    await Promise.resolve();

    expect((list as unknown as { scrollTop: number }).scrollTop).toBe(1000);
  });

  it('paused mode sets no scrollTop to the bottom when a push trims', async () => {
    const { getByTestId, rerender } = render(PhaseLogReadingPane, {
      props: paneProps(windowAtCap(1, 10))
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;
    await giveGeometry(list, 0);
    await fireEvent.scroll(list);

    await rerender(paneProps(windowAtCap(2, 11)));
    await rerender(paneProps(windowAtCap(3, 12)));
    await Promise.resolve();
    await Promise.resolve();

    expect((list as unknown as { scrollTop: number }).scrollTop).toBe(0);
  });

  it('paused mode counts every push since the baseline, including pushes that trimmed', async () => {
    const { getByTestId, queryByTestId, rerender } = render(PhaseLogReadingPane, {
      props: paneProps(windowAtCap(1, 10))
    });
    const list = getByTestId('phase-log-entry-list') as HTMLElement;
    await giveGeometry(list, 0);
    await fireEvent.scroll(list);
    expect(queryByTestId('phase-log-new-entries'), 'the control: nothing is new yet').toBeNull();

    await rerender(paneProps(windowAtCap(2, 11)));
    await rerender(paneProps(windowAtCap(3, 12)));
    await rerender(paneProps(windowAtCap(4, 13)));

    const affordance = queryByTestId('phase-log-new-entries');
    expect(affordance, 'three trimmed pushes are three new entries').not.toBeNull();
    expect(affordance?.textContent ?? '').toMatch(/\b3\b/);
  });
});
