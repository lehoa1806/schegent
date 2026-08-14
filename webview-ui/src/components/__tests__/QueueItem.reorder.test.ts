// Feature 030 T029 (US2) — webview unit test for the reorder UX on
// `QueueItem.svelte`.
//
// Assertions:
//   1. Mounting with a pending task renders a drag handle.
//   2. Mounting with a pending task renders up/down arrow buttons.
//   3. Clicking the up arrow dispatches CMD_MOVE_QUEUE_ITEM_UP via the
//      shared helper.
//   4. Mounting with an in-flight task renders NO drag handle and NO
//      up/down arrow buttons.
//
// The component routes through the shared helper at
// `webview-ui/src/lib/reorder-task.ts`; we mock that module so the test
// asserts the function call shape without going through postCommand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QueueItem from '../QueueItem.svelte';
import type { QueueItem as QueueItemSnapshot } from '../../lib/snapshot-types';

const postReorderTaskSpy = vi.fn();
const postMoveItemUpSpy = vi.fn();
const postMoveItemDownSpy = vi.fn();

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: (...args: unknown[]) => postReorderTaskSpy(...args),
  postMoveItemUp: (...args: unknown[]) => postMoveItemUpSpy(...args),
  postMoveItemDown: (...args: unknown[]) => postMoveItemDownSpy(...args)
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-stub' }))
}));

// Feature 063 — destructive remove routes through useConfirm. The
// keyboard focus-order assertions only inspect the DOM tab order, so
// auto-confirm any prompt to keep the test deterministic.
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    isPrimary: true,
    queue: {
      queues: [
        {
          id: 'default',
          name: 'Default queue',
          position: 0,
          state: 'active',
          schedule: null,
          taskCount: 1
        }
      ]
    },
    queues: [
      {
        id: 'default',
        name: 'Default queue',
        position: 0,
        state: 'active',
        schedule: null,
        taskCount: 1
      }
    ],
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

beforeEach(() => {
  postReorderTaskSpy.mockReset();
  postMoveItemUpSpy.mockReset();
  postMoveItemDownSpy.mockReset();
});
afterEach(() => cleanup());

function item(overrides: Partial<QueueItemSnapshot> = {}): QueueItemSnapshot {
  return {
    id: 'task-1',
    label: 'Reorder candidate',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T11:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    queueId: 'default',
    position: 0,
    pauseCause: null,
    ...overrides
  };
}

describe('Feature 030 (US2, T029) — QueueItem reorder affordances', () => {
  it('renders a drag handle for a pending task', () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    expect(getByTestId('queue-item-drag-handle-task-1')).toBeTruthy();
  });

  it('renders up and down arrow buttons for a pending task', () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    const upBtn = getByTestId('queue-item-reorder-up-task-1');
    const downBtn = getByTestId('queue-item-reorder-down-task-1');
    expect(upBtn).toBeTruthy();
    expect(downBtn).toBeTruthy();
    // Real <button> elements — keyboard-accessible by default.
    expect(upBtn.tagName).toBe('BUTTON');
    expect(downBtn.tagName).toBe('BUTTON');
  });

  it('clicking the up arrow dispatches postMoveItemUp via the shared helper', async () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    await fireEvent.click(getByTestId('queue-item-reorder-up-task-1'));
    expect(postMoveItemUpSpy).toHaveBeenCalledTimes(1);
    expect(postMoveItemUpSpy).toHaveBeenCalledWith('task-1');
  });

  it('clicking the down arrow dispatches postMoveItemDown via the shared helper', async () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    await fireEvent.click(getByTestId('queue-item-reorder-down-task-1'));
    expect(postMoveItemDownSpy).toHaveBeenCalledTimes(1);
    expect(postMoveItemDownSpy).toHaveBeenCalledWith('task-1');
  });

  it('does NOT render drag handle / up / down for an in-flight task', () => {
    const { queryByTestId } = render(QueueItem, {
      props: { item: item({ status: 'in-flight' }) }
    });
    expect(queryByTestId('queue-item-drag-handle-task-1')).toBeNull();
    expect(queryByTestId('queue-item-reorder-up-task-1')).toBeNull();
    expect(queryByTestId('queue-item-reorder-down-task-1')).toBeNull();
  });
});

// Feature 065 BUG-005 (FR-025) — reorder affordance discoverability.
// The drag handle MUST be a recognizable icon button (not punctuation
// glyphs), MUST telegraph interactivity via `cursor: grab`, MUST
// advertise its purpose via `aria-label`, and the arrow buttons MUST
// render with non-zero width at every viewport size. Keyboard focus
// order MUST be drag handle → ▲ → ▼ → ✎ → ✖.
//
// The compiled stylesheet's `cursor: grab` cannot be inspected via
// jsdom's `getComputedStyle` (vite-plugin-svelte does not inject the
// scoped stylesheet under vitest); we assert against the `<style>`
// block in the authoring file, mirroring the approach in
// QueueItem.label-clamp.test.ts.
const SOURCE_PATH = resolve(__dirname, '..', 'QueueItem.svelte');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const FOOTER_SOURCE_PATH = resolve(__dirname, '..', 'QueueItemFooter.svelte');
const FOOTER_SOURCE = readFileSync(FOOTER_SOURCE_PATH, 'utf8');
function extractStyleBlock(svelteSource: string): string {
  const match = svelteSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return match ? match[1] : '';
}
function findRuleBlock(css: string, selector: string): string | null {
  const escaped = selector.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`${escaped}\\b[^{]*\\{([^}]*)\\}`);
  const match = css.match(re);
  return match ? match[1] : null;
}
const REORDER_STYLE_BLOCK = extractStyleBlock(SOURCE);
const FOOTER_STYLE_BLOCK = extractStyleBlock(FOOTER_SOURCE);

describe('Feature 065 BUG-005 (FR-025) — reorder affordance discoverability', () => {
  it('renders the drag handle as a real <button> element with an aria-label', () => {
    const { getByTestId } = render(QueueItem, { props: { item: item() } });
    const handle = getByTestId('queue-item-drag-handle-task-1');
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.getAttribute('aria-label')).toBe('Drag to reorder');
  });

  it('drag handle ships a recognizable icon glyph (not punctuation)', () => {
    const { getByTestId } = render(QueueItem, { props: { item: item() } });
    const handle = getByTestId('queue-item-drag-handle-task-1');
    // The handle MUST not render as the literal "⋮⋮" punctuation
    // glyph cluster the operator previously failed to recognize.
    expect(handle.textContent ?? '').not.toContain('⋮');
    // A recognizable icon ships as an <svg> child element with the
    // .drag-handle-icon class (FR-025 — recognizable icon, not
    // punctuation).
    const svg = handle.querySelector('svg.drag-handle-icon');
    expect(svg).not.toBeNull();
  });

  it('drag handle style declares cursor: grab to telegraph interactivity', () => {
    const dragHandleBlock = findRuleBlock(REORDER_STYLE_BLOCK, '.drag-handle');
    expect(
      dragHandleBlock,
      '.drag-handle rule must be present in QueueItem.svelte <style>'
    ).not.toBeNull();
    if (!dragHandleBlock) return;
    expect(dragHandleBlock).toMatch(/cursor:\s*grab/);
  });

  it('reorder buttons and action slot are pinned with flex-shrink: 0 so they cannot collapse', () => {
    // Hypothesis B from BUG-005 — if a flex/overflow rule on the
    // enclosing row clips the cluster, the buttons disappear even
    // though showReorderControls === true. We pin flex-shrink: 0 on
    // both .actions-slot and .reorder-btn so the cluster cannot
    // collapse to zero width at any tested viewport size.
    const actionsSlotBlock = findRuleBlock(FOOTER_STYLE_BLOCK, '.actions-slot');
    expect(actionsSlotBlock).not.toBeNull();
    if (actionsSlotBlock) expect(actionsSlotBlock).toMatch(/flex-shrink:\s*0/);

    const reorderBtnBlock = findRuleBlock(FOOTER_STYLE_BLOCK, '.reorder-btn');
    expect(reorderBtnBlock).not.toBeNull();
    if (reorderBtnBlock) {
      expect(reorderBtnBlock).toMatch(/flex-shrink:\s*0/);
      // Hard minimum width — a guarantee that the rendered button
      // never collapses below 18px regardless of parent constraints.
      expect(reorderBtnBlock).toMatch(/min-width:\s*18px/);
    }
  });

  it('keyboard focus order is drag-handle → ▲ → ▼ → ✎ → ✖', () => {
    const { container } = render(QueueItem, { props: { item: item() } });
    // Collect all focusable controls under the queue item in DOM
    // order. The default keyboard tab traversal follows DOM order
    // when no positive tabindex is set, so DOM order == tab order.
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const ids = focusable.map((el) => el.getAttribute('data-testid'));
    // The handle, the two arrow buttons, the edit button, and the
    // remove button must appear in this exact relative order.
    const orderedIds = [
      'queue-item-drag-handle-task-1',
      'queue-item-reorder-up-task-1',
      'queue-item-reorder-down-task-1',
      'queue-item-edit-task-1',
      'queue-item-remove-task-1'
    ];
    const indices = orderedIds.map((id) => ids.indexOf(id));
    // Every control is present in the focusable set.
    for (let i = 0; i < orderedIds.length; i++) {
      expect(indices[i], `${orderedIds[i]} must be focusable`).toBeGreaterThanOrEqual(
        0
      );
    }
    // Indices are strictly increasing — drag-handle precedes ▲, ▲
    // precedes ▼, ▼ precedes ✎, ✎ precedes ✖.
    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i],
        `${orderedIds[i]} must follow ${orderedIds[i - 1]} in keyboard tab order`
      ).toBeGreaterThan(indices[i - 1]);
    }
  });
});

// Feature 063 BUG-005 (030 FR-028) — armed-drag lifetime.
//
// The row is only `draggable` while the drag is armed, so the arming state
// is what decides whether a drag can start at all. The tests above cover
// handle rendering, arrow dispatch, aria labels, and focus order and never
// touch that state, so re-adding an `onmouseleave` disarm — the original
// defect — would not fail any of them. HTML5 fires `dragstart` only after
// the pointer has moved a few pixels, and on a small handle those pixels
// routinely leave the handle's own box, so a mouseleave disarm races the
// browser and the drag silently never begins.
describe('Feature 063 BUG-005 (030 FR-028) — armed-drag lifecycle', () => {
  function armedRow() {
    const rendered = render(QueueItem, { props: { item: item() } });
    const handle = rendered.getByTestId('queue-item-drag-handle-task-1');
    const row = rendered.getByTestId('queue-item-task-1');
    return { ...rendered, handle, row };
  }

  it('is not draggable before the handle is pressed', () => {
    const { row } = armedRow();
    expect(row.getAttribute('draggable')).toBe('false');
  });

  it('arms on handle mousedown', async () => {
    const { handle, row } = armedRow();
    await fireEvent.mouseDown(handle);
    expect(row.getAttribute('draggable')).toBe('true');
  });

  it('stays armed when the pointer leaves the handle before the drag threshold', async () => {
    const { handle, row } = armedRow();
    await fireEvent.mouseDown(handle);
    await fireEvent.mouseLeave(handle);
    expect(row.getAttribute('draggable')).toBe('true');
    // Also survives leaving the row itself — the arming is owned by the
    // handle press, and only a press release or a finished drag ends it.
    await fireEvent.mouseLeave(row);
    expect(row.getAttribute('draggable')).toBe('true');
  });

  it('disarms on handle mouseup', async () => {
    const { handle, row } = armedRow();
    await fireEvent.mouseDown(handle);
    await fireEvent.mouseUp(handle);
    expect(row.getAttribute('draggable')).toBe('false');
  });

  it('disarms on dragend', async () => {
    const { handle, row } = armedRow();
    await fireEvent.mouseDown(handle);
    await fireEvent.dragEnd(row);
    expect(row.getAttribute('draggable')).toBe('false');
  });
});
