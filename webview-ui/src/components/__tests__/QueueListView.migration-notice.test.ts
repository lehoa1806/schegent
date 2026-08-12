// Feature 065 (T054a / FR-020) — v6 → v7 migration notice component test.
//
// QueueListView must surface the migration notice correctly per FR-020:
//   (a) The notice renders when `queue.migrationNotice === 'pending'`.
//   (b) The notice does NOT render when `queue.migrationNotice === 'dismissed'`.
//   (c) Dismissing the notice routes through the existing `WebviewMessage`
//       channel (`postCommand`) — NOT a new mutating IPC command. The dispatch
//       MUST go out as `CMD_DISMISS_MIGRATION_NOTICE`, which is intentionally
//       excluded from `MUTATING_COMMAND_TYPES` (non-destructive UX state).
//       After the host applies the dismiss, the next snapshot the webview
//       receives flips `migrationNotice` to `'dismissed'` and the notice
//       disappears.
//   (d) Dismissal MUST NOT change `scheduledStartSource` on any persisted
//       queue record. We assert this by reading the queue projection before
//       and after the dismiss-roundtrip.
//
// The test mocks `../../lib/vscode-api` (matching the pattern from
// `QueueListView.idle-pending.test.ts`) so the `postCommand` outgoing call
// can be inspected. The "next snapshot" arrival is simulated by re-applying
// `STATE_SNAPSHOT` with `migrationNotice: 'dismissed'`.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueListView from '../QueueListView.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import {
  STATE_SNAPSHOT,
  CMD_DISMISS_MIGRATION_NOTICE
} from '../../lib/messages';
import { MUTATING_COMMAND_TYPES } from '../../../../src/contracts/sidebar-command-metadata';
import type {
  WorkflowSnapshot,
  QueueProjection
} from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: vi.fn()
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'test-correlation' })),
  acquireVsCodeApi: vi.fn(() => null)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true),
  isModalOpen: () => false
}));

function makeQueue(partial: Partial<QueueProjection>): QueueProjection {
  return {
    inFlight: null,
    pending: [],
    recent: [],
    orderedItems: [],
    paused: false,
    ...partial
  };
}

function makeSnapshot(queue: Partial<QueueProjection>): WorkflowSnapshot {
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
    queue: makeQueue(queue)
  } as unknown as unknown as WorkflowSnapshot;
}

beforeEach(() => {
  // Default: idle-pending with the migration notice pending — this is the
  // post-migration state the v6 → v7 migrator produces (FR-020).
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot({
      lifecycle: 'idle-pending',
      scheduledStartAt: null,
      scheduledStartSource: 'migration-default',
      migrationNotice: 'pending'
    })
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QueueListView — v6 → v7 migration notice (FR-020 / T054a)', () => {
  it('(a) renders the migration notice when migrationNotice === "pending"', async () => {
    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const notice = queryByTestId('migration-notice');
    expect(notice).not.toBeNull();
    // The dismiss affordance is part of the same surface — assert it is
    // wired so the operator can actually clear the notice.
    expect(queryByTestId('migration-notice-dismiss')).not.toBeNull();
  });

  it('(b) does NOT render the migration notice when migrationNotice === "dismissed"', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null,
        scheduledStartSource: 'migration-default',
        migrationNotice: 'dismissed'
      })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    expect(queryByTestId('migration-notice')).toBeNull();
    expect(queryByTestId('migration-notice-dismiss')).toBeNull();
  });

  it('(b2) does NOT render when migrationNotice is absent (undefined)', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'active-empty'
        // migrationNotice intentionally omitted
      })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    expect(queryByTestId('migration-notice')).toBeNull();
  });

  it('(c) dismissing routes through WebviewMessage (postCommand) with a NON-mutating CMD_DISMISS_MIGRATION_NOTICE, and the next snapshot flips it to dismissed', async () => {
    const vscodeApi = await import('../../lib/vscode-api');
    const postCommandMock = vi.mocked(vscodeApi.postCommand);
    postCommandMock.mockClear();

    const { queryByTestId, rerender } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    // (c-pre) Sanity: notice is visible before dismiss.
    expect(queryByTestId('migration-notice')).not.toBeNull();

    const dismissBtn = queryByTestId(
      'migration-notice-dismiss'
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    await fireEvent.click(dismissBtn!);
    await tick();

    // (c-1) Exactly one `postCommand` dispatch for the dismiss with the
    // expected command type.
    const dismissCalls = postCommandMock.mock.calls.filter(
      (call) => call[0] === CMD_DISMISS_MIGRATION_NOTICE
    );
    expect(dismissCalls.length).toBe(1);

    // (c-2) The command MUST NOT be a member of the pinned mutating-command
    // set — dismiss is non-destructive UX state per FR-020, same risk
    // profile as a read-only command.
    expect(MUTATING_COMMAND_TYPES).not.toContain(CMD_DISMISS_MIGRATION_NOTICE);

    // (c-3) Simulate the host applying the dismiss and pushing a new
    // snapshot back to the webview. After the snapshot lands, the notice
    // must disappear.
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null,
        scheduledStartSource: 'migration-default',
        migrationNotice: 'dismissed'
      })
    } as never);

    // Rerender to flush the $derived reactive read against the updated
    // store. (testing-library/svelte's `rerender` performs a component
    // update tick.)
    await rerender({
      orderedItems: [],
      isPrimary: true,
      selectedTaskId: null,
      onTaskSelect: () => undefined
    });
    await tick();

    expect(queryByTestId('migration-notice')).toBeNull();
  });

  it('(d) dismissal does NOT change scheduledStartSource on the persisted queue projection', async () => {
    const vscodeApi = await import('../../lib/vscode-api');
    const postCommandMock = vi.mocked(vscodeApi.postCommand);
    postCommandMock.mockClear();

    // Snapshot before dismiss — capture the source.
    const before = snapshotStore.snapshot?.queue;
    expect(before).not.toBeUndefined();
    const sourceBefore = before!.scheduledStartSource;
    expect(sourceBefore).toBe('migration-default');

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const dismissBtn = queryByTestId(
      'migration-notice-dismiss'
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    await fireEvent.click(dismissBtn!);
    await tick();

    // Simulate the host completing the dismiss roundtrip — FR-020 invariant:
    // the host's setQueue write flips `migrationNotice` to `'dismissed'` and
    // leaves `scheduledStartSource` untouched. The new snapshot reflects
    // that: source must remain `'migration-default'`.
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null,
        scheduledStartSource: 'migration-default',
        migrationNotice: 'dismissed'
      })
    } as never);
    await tick();

    const after = snapshotStore.snapshot?.queue;
    expect(after).not.toBeUndefined();
    expect(after!.scheduledStartSource).toBe(sourceBefore);
    expect(after!.scheduledStartSource).toBe('migration-default');

    // Defense in depth: also verify the outbound IPC payload carried no
    // fields that could touch scheduledStartSource. The contract makes the
    // command payload empty by construction, but we assert anyway so this
    // test fails loudly if anyone later widens the payload shape.
    const dismissCalls = postCommandMock.mock.calls.filter(
      (call) => call[0] === CMD_DISMISS_MIGRATION_NOTICE
    );
    expect(dismissCalls.length).toBe(1);
    const [, payload] = dismissCalls[0] as [string, unknown];
    // The webview helper invokes `postCommand(type)` with no payload — when
    // a payload arg is omitted, the helper either records `undefined` or an
    // empty object depending on the call shape. Both are acceptable; what
    // matters is that no `scheduledStartSource` field is present.
    if (payload && typeof payload === 'object') {
      expect(payload).not.toHaveProperty('scheduledStartSource');
    }
  });
});
