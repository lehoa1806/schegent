// Feature 030 T061 (BUG-001 Defect B) — webview unit test for the per-row
// visual contract on `QueueItem.svelte`'s `.label` element (FR-024 / SC-010).
//
// Two layers of verification needed:
//
//   1. The component renders the projected label verbatim and tags the
//      label element with the `.label` class. This is testable in jsdom.
//
//   2. The compiled stylesheet ships the webkit line-clamp cluster on
//      `.label` plus `min-width: 0` on the flex parent `.row-2`. jsdom
//      does not apply <style>-tag CSS rules during `getComputedStyle`,
//      and vite-plugin-svelte under vitest does not inject the scoped
//      stylesheet into the document head. We therefore assert against
//      the `<style>` block in the **authoring file** — the source of
//      truth that vite-plugin-svelte transforms verbatim. If the rules
//      land in `QueueItem.svelte`, they ship to every render surface.
//
// Browser-rendered manual verification of the visible 3-line ceiling
// (clientHeight ≤ 3 × line-height) is captured by T063 in the spec's
// verification gate.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QueueItem from '../QueueItem.svelte';
import type { QueueItem as QueueItemSnapshot } from '../../lib/snapshot-types';

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: vi.fn(),
  postMoveItemUp: vi.fn(),
  postMoveItemDown: vi.fn()
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-stub' }))
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
    phaseByName: () => null,
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

afterEach(() => cleanup());

function pendingItem(label: string, overrides: Partial<QueueItemSnapshot> = {}): QueueItemSnapshot {
  return {
    id: 'task-clamp',
    label,
    enqueuedAt: '2026-05-22T10:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-22T10:00:00.000Z',
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

// A 300-character label long enough to exceed three rendered lines at
// every realistic sidebar width. Sentinel chars at positions 0 / 100 /
// 200 / 297 make it trivial to assert the rendered text matches the
// passed value verbatim (i.e., no test-side truncation).
const LABEL_300 =
  'A'.padEnd(100, 'A') + 'B'.padEnd(100, 'B') + 'C'.padEnd(97, 'C') + '...';

// Read the authoring file once per test file. `import.meta.url` resolves
// to the compiled test file under vitest, but `process.cwd()` is the
// webview-ui package root (vitest is invoked from there), so resolve
// the canonical path explicitly.
const SOURCE_PATH = resolve(__dirname, '..', 'QueueItem.svelte');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// Extract the contents of the first `<style>...</style>` block from the
// Svelte file. The file ships a single block at the bottom; this
// regex captures everything between the tags.
function extractStyleBlock(svelteSource: string): string {
  const match = svelteSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return match ? match[1] : '';
}

// Extract a single CSS rule block for the given bare class (no Svelte
// hash needed at the source level). Returns the declaration body or
// null if the rule is missing.
function findRuleBlock(css: string, bareClass: string): string | null {
  const re = new RegExp(`\\.${bareClass}\\b[^{]*\\{([^}]*)\\}`);
  const match = css.match(re);
  return match ? match[1] : null;
}

const STYLE_BLOCK = extractStyleBlock(SOURCE);

describe('Feature 030 T061 (BUG-001 Defect B) — QueueItem label line-clamp (FR-024 / SC-010)', () => {
  it('the QueueItem.svelte source ships a non-empty <style> block', () => {
    // Guards against accidental deletion of the scoped stylesheet
    // during a future refactor — every downstream assertion in this
    // file depends on the block being present.
    expect(STYLE_BLOCK.length).toBeGreaterThan(0);
  });

  it('emits the webkit line-clamp cluster on .label', () => {
    const labelBlock = findRuleBlock(STYLE_BLOCK, 'label');
    expect(labelBlock, '.label rule must be present in QueueItem.svelte <style>').not.toBeNull();
    if (!labelBlock) return;
    // Core line-clamp cluster (FR-024).
    expect(labelBlock).toMatch(/display:\s*-webkit-box/);
    expect(labelBlock).toMatch(/-webkit-line-clamp:\s*3/);
    expect(labelBlock).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(labelBlock).toMatch(/overflow:\s*hidden/);
    // The label MUST be able to shrink below intrinsic content width
    // for the clamp to engage at narrow viewport widths.
    expect(labelBlock).toMatch(/min-width:\s*0/);
    // Standard line-clamp property for CSS Box Module Level 4 compat.
    expect(labelBlock).toMatch(/(?:^|;|\s)line-clamp:\s*3/);
  });

  it('emits min-width: 0 on the .row-2 flex parent so the clamp can engage', () => {
    const rowBlock = findRuleBlock(STYLE_BLOCK, 'row-2');
    expect(rowBlock, '.row-2 rule must be present in QueueItem.svelte <style>').not.toBeNull();
    if (!rowBlock) return;
    // Without min-width: 0 on the flex parent, the .label cannot
    // shrink below its intrinsic content width and the clamp's
    // overflow: hidden never engages. This declaration is the
    // load-bearing half of FR-024.
    expect(rowBlock).toMatch(/min-width:\s*0/);
    expect(rowBlock).toMatch(/display:\s*flex/);
  });

  it('renders the 300-character label verbatim (no test-side truncation)', () => {
    const { container } = render(QueueItem, {
      props: { item: pendingItem(LABEL_300) }
    });
    const labelEl = container.querySelector('.label') as HTMLElement | null;
    expect(labelEl).not.toBeNull();
    // The visible-3-line ceiling is enforced by the browser at runtime
    // and re-verified manually under T063; this assertion only checks
    // that the template did not pre-truncate the projected string.
    expect(labelEl?.textContent ?? '').toBe(LABEL_300);
  });

  it('renders the .label element for every task status (not pending-only)', () => {
    // FR-024 declares the visual contract applies to every status.
    // Render the row in three terminal states and verify the
    // `.label` element is present — the stylesheet contract (asserted
    // above against the authoring file) applies uniformly.
    for (const status of ['completed', 'failed', 'in-flight'] as const) {
      const { container } = render(QueueItem, {
        props: { item: pendingItem(LABEL_300, { status, currentPhase: status === 'in-flight' ? 'speckit-plan' : null }) }
      });
      const labelEl = container.querySelector('.label') as HTMLElement | null;
      expect(labelEl, `status=${status} label element`).not.toBeNull();
      expect(labelEl?.textContent ?? '', `status=${status} label text`).toBe(LABEL_300);
      cleanup();
    }
  });
});
