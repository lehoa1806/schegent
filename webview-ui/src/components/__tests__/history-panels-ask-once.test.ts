// Opening a run's details crashed the History page, before and after the
// webview port (decision 1 of the port review, 2026-11-14).
//
// Every other History test replaces `resolveAuditPointer` and
// `resolveHistoryDescription` whole, or swaps the store for a no-op, so the
// call both helpers make on the way out, `snapshotStore.markPending`, never
// happens under test. That call reads the store's pending set and replaces it.
// Made from inside an effect, the read is tracked and the write invalidates it,
// so the effect asks again, about a thousand times, until Svelte stops it with
// `effect_update_depth_exceeded` and the panel never renders. The storm test
// next door quotes a host log of 2,002 description and 1,002 pointer requests
// in one second against one history entry: counts of that size.
//
// Only the transport is stubbed here. Each helper makes its real correlated
// request against the real store, so a request made inside an effect has to
// be made untracked to pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { CMD_RESOLVE_AUDIT_POINTER, CMD_RESOLVE_HISTORY_DESCRIPTION } from '../../lib/messages';
import type { HistoryRow } from '../../lib/history-rows';
import type { RerunTarget } from '../../lib/history-rerun';
import type { PipelineDefinition } from '../../lib/snapshot-types';

const postCommandSpy = vi.fn<(type: string, payload?: unknown) => { correlationId: string }>();

vi.mock('../../lib/vscode-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vscode-api')>()),
  postCommand: (type: string, payload?: unknown) => postCommandSpy(type, payload)
}));

// The form under the re-run panel launches through its own helper; nothing here launches.
vi.mock('../../lib/run-launcher-ipc', () => ({
  launchPipeline: vi.fn(async () => ({ outcome: 'enqueued', requestId: 'q-1' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

import HistoryEvidencePanel from '../HistoryEvidencePanel.svelte';
import HistoryRerunPanel from '../HistoryRerunPanel.svelte';

const PIPELINE: PipelineDefinition = {
  id: 'pipe-a',
  name: 'Pipeline A',
  phases: ['speckit-specify'],
  inputs: [],
  outputs: []
};

const READY: RerunTarget = {
  state: 'ready',
  launchable: { kind: 'pipeline', id: 'pipe-a', name: 'Pipeline A', activeVersionId: 'v1', inputs: [] },
  supersededVersionId: null,
  workflowMemberOf: null,
  queue: { queueId: 'default', name: 'Default', substituted: false }
};

function historyRow(runId: string): HistoryRow {
  const row: HistoryRow = {
    runId,
    queueId: 'default',
    queueName: 'Default',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-a',
    catalogVersion: { kind: 'pipeline', id: 'pipe-a', versionId: 'v1' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'ship the thing',
    descriptionLength: 14,
    orderingKey: '2026-05-10T12:00:42.000Z',
    startedAt: '2026-05-10T12:00:00.000Z',
    completedAt: '2026-05-10T12:00:42.000Z',
    durationMs: 42_000
  };
  return Object.freeze(row);
}

/** The payloads posted for one command, in order. */
function requestsFor(command: string): unknown[] {
  return postCommandSpy.mock.calls.filter(([type]) => type === command).map(([, payload]) => payload);
}

let sent = 0;

beforeEach(() => {
  sent = 0;
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => {
    sent += 1;
    return { correlationId: `history-panels-ask-once-${sent}` };
  });
});

afterEach(() => cleanup());

describe('the evidence panel resolves a run pointer once per run', () => {
  it('mounts and asks once', async () => {
    expect(() => render(HistoryEvidencePanel, { props: { runId: 'run-1' } })).not.toThrow();
    await tick();

    expect(requestsFor(CMD_RESOLVE_AUDIT_POINTER)).toEqual([{ runId: 'run-1' }]);
  });

  it('asks once more for the next run, and stops there', async () => {
    const { rerender } = render(HistoryEvidencePanel, { props: { runId: 'run-1' } });
    await tick();
    await rerender({ runId: 'run-2' });
    await tick();

    expect(requestsFor(CMD_RESOLVE_AUDIT_POINTER)).toEqual([{ runId: 'run-1' }, { runId: 'run-2' }]);
  });
});

describe('the re-run panel asks for the full description once per run', () => {
  function mount(runId: string) {
    return render(HistoryRerunPanel, {
      props: { row: historyRow(runId), target: READY, pipeline: PIPELINE, onClose: () => {} }
    });
  }

  it('mounts and asks once', async () => {
    expect(() => mount('run-1')).not.toThrow();
    await tick();

    expect(requestsFor(CMD_RESOLVE_HISTORY_DESCRIPTION)).toEqual([{ runId: 'run-1' }]);
  });

  it('asks once more for the next run, and stops there', async () => {
    const { rerender } = mount('run-1');
    await tick();
    await rerender({ row: historyRow('run-2') });
    await tick();

    expect(requestsFor(CMD_RESOLVE_HISTORY_DESCRIPTION)).toEqual([{ runId: 'run-1' }, { runId: 'run-2' }]);
  });
});
