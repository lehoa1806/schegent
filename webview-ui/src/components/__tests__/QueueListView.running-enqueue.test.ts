// Feature 065 (T031, revised per BUG-001 / 2026-05-23) — Component
// coverage asserting that `StartModeChooser` is NEVER rendered at
// submit-time for ANY lifecycle (`running`, `operator-paused`,
// `idle-pending`, `active-empty`).
//
// Under the revised spec (FR-018), the chooser is reached exclusively
// via the queue-level "Start queue" affordance against an
// `idle-pending` queue. Task-submit always dispatches `CMD_START`
// without a `startIntent`. The webview-side `pendingDraft` /
// `showChooser` state in `QueueInputForm.svelte` was deleted.
//
// File name keeps the legacy `running-enqueue` suffix to preserve
// `git blame` continuity, even though it now covers all four
// lifecycles.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueInputForm from '../QueueInputForm.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { STATE_SNAPSHOT } from '../../lib/messages';
import type { WorkflowSnapshot, QueueProjection } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true),
  isModalOpen: () => false
}));

// Stub `postCommand` so submit doesn't emit IPC messages to a missing host.
vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'test-correlation' })),
  acquireVsCodeApi: vi.fn(() => null)
}));

function makeSnapshot(queue: Partial<QueueProjection>): WorkflowSnapshot {
  const base: QueueProjection = {
    inFlight: null,
    pending: [],
    recent: [],
    orderedItems: [],
    paused: false,
    ...queue
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
  } as unknown as WorkflowSnapshot;
}

const pipelineDefault = {
  id: 'standard',
  name: 'Standard',
  defaultPipelineId: 'standard'
};

const availablePipelines = [
  { id: 'standard', name: 'Standard' , phases: []}
];

beforeEach(() => {
  // Reset snapshot before each test.
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot({ lifecycle: 'active-empty' })
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// All four lifecycles MUST suppress the chooser at submit time post-BUG-001.
const LIFECYCLES = [
  'running',
  'operator-paused',
  'idle-pending',
  'active-empty'
] as const;

describe('QueueInputForm — submit never opens the chooser (BUG-001 / FR-018)', () => {
  for (const lifecycle of LIFECYCLES) {
    it(`does NOT render StartModeChooser when lifecycle === "${lifecycle}" after submit`, async () => {
      snapshotStore.apply({
        type: STATE_SNAPSHOT,
        payload: makeSnapshot({ lifecycle })
      } as never);

      const { container, queryByTestId } = render(QueueInputForm, {
        props: {
          availablePipelines,
          defaultPipelineId: pipelineDefault.defaultPipelineId,
          pendingCount: 0
        }
      });

      // Type into the textarea and submit.
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      await fireEvent.input(textarea!, { target: { value: 'silent task' } });
      const submit = queryByTestId('dashboard-queue-input-submit') as HTMLButtonElement | null;
      expect(submit).not.toBeNull();
      await fireEvent.click(submit!);
      await tick();

      // The chooser MUST NOT be rendered at submit time for ANY lifecycle.
      expect(queryByTestId('start-mode-chooser')).toBeNull();
      // No discard affordance either — the chooser surface itself no longer owns one.
      expect(queryByTestId('start-mode-chooser-discard')).toBeNull();
    });

    it(`submit with empty description and lifecycle === "${lifecycle}" does not render the chooser`, async () => {
      snapshotStore.apply({
        type: STATE_SNAPSHOT,
        payload: makeSnapshot({ lifecycle })
      } as never);

      const { queryByTestId } = render(QueueInputForm, {
        props: {
          availablePipelines,
          defaultPipelineId: pipelineDefault.defaultPipelineId,
          pendingCount: 0
        }
      });

      // Don't fill in any description. The submit button is disabled,
      // but the chooser must also not be in the DOM.
      await tick();
      expect(queryByTestId('start-mode-chooser')).toBeNull();
    });
  }
});
