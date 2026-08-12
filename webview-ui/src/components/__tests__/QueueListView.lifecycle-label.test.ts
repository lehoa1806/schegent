// Feature 065 (T049d / FR-016 / SC-001) — operator-facing label visibility.
//
// QueueListView surfaces a distinct label for each of the four canonical
// `QueueLifecycle` values (`running`, `operator-paused`, `idle-pending`,
// `active-empty`). At-a-glance discrimination is required by FR-016 /
// SC-001 — the same DOM node must change its text (or aria-label) for
// each value. We assert the label is a deterministic function of the
// snapshot's lifecycle field and that no two values collide.
//
// This test complements `QueueListView.idle-pending.test.ts` (T051),
// which only covers the `idle-pending` surface.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import QueueListView from '../QueueListView.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { STATE_SNAPSHOT } from '../../lib/messages';
import type {
  WorkflowSnapshot,
  QueueProjection,
  QueueLifecycle
} from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: vi.fn()
}));

function makeSnapshot(lifecycle: QueueLifecycle): WorkflowSnapshot {
  const base: QueueProjection = {
    orderedItems: [],
    inFlight: null,
    pending: [],
    recent: [],
    paused: lifecycle === 'operator-paused',
    lifecycle
  };
  return {
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: []
    }),
    queue: base
  } as unknown as unknown as WorkflowSnapshot;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QueueListView — lifecycle label visibility (FR-016 / SC-001)', () => {
  const lifecycles: readonly QueueLifecycle[] = [
    'running',
    'operator-paused',
    'idle-pending',
    'active-empty'
  ];

  // Capture the rendered label text for each lifecycle so we can assert
  // pairwise distinctness in the final test below.
  const observedLabels = new Map<QueueLifecycle, string>();

  for (const lifecycle of lifecycles) {
    it(`renders a distinct operator-facing label when lifecycle === '${lifecycle}'`, async () => {
      snapshotStore.apply({
        type: STATE_SNAPSHOT,
        payload: makeSnapshot(lifecycle)
      } as never);

      const { queryByTestId } = render(QueueListView, {
        props: {
          orderedItems: [],
          isPrimary: true,
          selectedTaskId: null,
          onTaskSelect: () => undefined
        }
      });

      const labelEl = queryByTestId('queue-lifecycle-label');
      expect(labelEl, `lifecycle label missing for ${lifecycle}`).not.toBeNull();

      // The `data-lifecycle` attribute carries the canonical literal so
      // tests can assert the wiring is correct.
      expect(labelEl!.getAttribute('data-lifecycle')).toBe(lifecycle);

      const text = labelEl!.textContent?.trim() ?? '';
      expect(text.length, `lifecycle label is empty for ${lifecycle}`).toBeGreaterThan(0);

      const ariaLabel = labelEl!.getAttribute('aria-label');
      expect(ariaLabel, `aria-label missing for ${lifecycle}`).not.toBeNull();

      observedLabels.set(lifecycle, text);
    });
  }

  // This guard test only runs if all four labels were observed. Using a
  // beforeEach to make the failure mode obvious (and to keep iteration
  // ordering independent).
  it('all four lifecycle labels are pairwise distinct (at-a-glance discrimination)', () => {
    expect(observedLabels.size).toBe(4);
    const texts = Array.from(observedLabels.values());
    const unique = new Set(texts);
    expect(unique.size).toBe(4);
  });
});
