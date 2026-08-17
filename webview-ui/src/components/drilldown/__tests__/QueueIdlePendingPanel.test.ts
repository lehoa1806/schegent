// Feature 097 (T012a) — `QueueIdlePendingPanel.svelte` was split out of
// `QueueDetailTier.svelte` to keep that file under the SC-008 500-line
// budget. Its idle-pending start/chooser behavior is Mechanism A, relocated
// unmodified in logic from the deleted `QueueListView.svelte` (feature 065);
// this file restores the coverage lost when `QueueListView.idle-pending.test.ts`
// was deleted alongside `QueueListView.svelte` (T013), adapted for this
// component's direct `{snapshot}` prop-mounting rather than the old
// global-store-driven mounting.
//
// Out of scope here (pre-existing, not newly exposed by this feature — see
// CLAUDE.md scope discipline): the "queue state changed elsewhere" notice
// render/dismiss path. It was not covered by the deleted test file either.
//
// The migration-notice render/dismiss path below WAS covered, by the sibling
// file `QueueListView.migration-notice.test.ts` (also deleted alongside
// `QueueListView.svelte`) — restored here against this component's direct
// `{snapshot}` prop-mounting rather than that file's global-store-driven one.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueueIdlePendingPanel from '../QueueIdlePendingPanel.svelte';
import { CMD_DISMISS_MIGRATION_NOTICE, CMD_START_QUEUE } from '../../../lib/messages';
import { MUTATING_COMMAND_TYPES } from '../../../../../src/contracts/sidebar-command-metadata';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type { WorkflowSnapshot } from '../../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

function snapshot(
  queueOverrides: {
    readonly lifecycle?: 'running' | 'operator-paused' | 'idle-pending' | 'active-empty';
    readonly scheduledStartAt?: number | null;
    readonly migrationNotice?: 'pending' | 'dismissed';
  } = {}
): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([]),
    queue: {
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      queues: Object.freeze([]),
      paused: false,
      lifecycle: queueOverrides.lifecycle,
      scheduledStartAt: queueOverrides.scheduledStartAt ?? null,
      ...(queueOverrides.migrationNotice !== undefined
        ? { migrationNotice: queueOverrides.migrationNotice }
        : {})
    },
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-12T00:00:30.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude']),
    generalSettings: IDLE_GENERAL_SETTINGS
  } as unknown as WorkflowSnapshot;
}

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('QueueIdlePendingPanel — idle-pending affordance (T012a, relocated from QueueListView)', () => {
  it('renders nothing when the default queue is not idle-pending', () => {
    const { queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'running' }) }
    });

    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
    expect(queryByTestId('idle-pending-scheduled-host')).toBeNull();
    expect(queryByTestId('idle-pending-chooser-host')).toBeNull();
  });

  it('renders the ScheduledStartIndicator, not the Start-queue button, once a start is scheduled', () => {
    const { getByTestId, queryByTestId } = render(QueueIdlePendingPanel, {
      props: {
        snapshot: snapshot({
          lifecycle: 'idle-pending',
          scheduledStartAt: Date.parse('2026-08-12T03:00:00.000Z')
        })
      }
    });

    expect(getByTestId('idle-pending-scheduled-host')).not.toBeNull();
    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
  });

  it('renders the Start-queue button, not the indicator, when no start is scheduled', () => {
    const { getByTestId, queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'idle-pending', scheduledStartAt: null }) }
    });

    expect(getByTestId('idle-pending-start-queue-button')).not.toBeNull();
    expect(queryByTestId('idle-pending-scheduled-host')).toBeNull();
  });

  it('opens the restart chooser on Start-queue click', async () => {
    const { getByTestId, queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'idle-pending', scheduledStartAt: null }) }
    });

    await fireEvent.click(getByTestId('idle-pending-start-queue-button'));

    expect(getByTestId('idle-pending-chooser-host')).not.toBeNull();
    expect(getByTestId('start-mode-chooser')).not.toBeNull();
    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
  });

  it('dispatches exactly one CMD_START_QUEUE for the whole queue on "Start now"', async () => {
    const { getByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'idle-pending', scheduledStartAt: null }) }
    });

    await fireEvent.click(getByTestId('idle-pending-start-queue-button'));
    await fireEvent.click(getByTestId('start-mode-chooser-now'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_START_QUEUE, {
      startIntent: { startMode: 'now', source: 'operator-restart' }
    });
  });

  it('closes the chooser without posting when the operator dismisses it', async () => {
    const { getByTestId, queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'idle-pending', scheduledStartAt: null }) }
    });

    await fireEvent.click(getByTestId('idle-pending-start-queue-button'));
    await fireEvent.click(getByTestId('start-mode-chooser-restart-dismiss'));

    expect(queryByTestId('idle-pending-chooser-host')).toBeNull();
    expect(getByTestId('idle-pending-start-queue-button')).not.toBeNull();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

describe('QueueIdlePendingPanel — v6 → v7 migration notice (FR-020, relocated from QueueListView)', () => {
  it('renders the migration notice and its dismiss affordance when migrationNotice === "pending"', () => {
    const { queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ migrationNotice: 'pending' }) }
    });

    expect(queryByTestId('migration-notice')).not.toBeNull();
    expect(queryByTestId('migration-notice-dismiss')).not.toBeNull();
  });

  it('does NOT render the migration notice when migrationNotice === "dismissed"', () => {
    const { queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ migrationNotice: 'dismissed' }) }
    });

    expect(queryByTestId('migration-notice')).toBeNull();
  });

  it('does NOT render the migration notice when migrationNotice is absent', () => {
    const { queryByTestId } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ lifecycle: 'active-empty' }) }
    });

    expect(queryByTestId('migration-notice')).toBeNull();
  });

  it('dismissing posts exactly one non-mutating CMD_DISMISS_MIGRATION_NOTICE, and the notice clears once the host applies it', async () => {
    const { getByTestId, queryByTestId, rerender } = render(QueueIdlePendingPanel, {
      props: { snapshot: snapshot({ migrationNotice: 'pending' }) }
    });

    await fireEvent.click(getByTestId('migration-notice-dismiss'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_DISMISS_MIGRATION_NOTICE);
    // Dismiss is non-destructive UX state, not a mutation of queue work.
    expect(MUTATING_COMMAND_TYPES).not.toContain(CMD_DISMISS_MIGRATION_NOTICE);

    // The host applies the dismiss and pushes the next snapshot back down;
    // simulated here as a prop update, matching this component's direct
    // `{snapshot}` mounting.
    await rerender({ snapshot: snapshot({ migrationNotice: 'dismissed' }) });

    expect(queryByTestId('migration-notice')).toBeNull();
  });
});
