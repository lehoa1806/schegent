// Finding 2 of the 2026-08-30 host-log triage — the webview IPC storm.
//
// A live host log recorded 2,002 `CMD_RESOLVE_HISTORY_DESCRIPTION` messages in
// ONE second against a `.schegent/history/` holding exactly one entry, with the
// metrics-rollup read (1,005) and `CMD_RESOLVE_AUDIT_POINTER` (1,002)
// interleaved one-for-one beside it.
//
// That metrics command constant is spelled out nowhere in this file: an
// allowlist gate in `tests/lint/` reserves it for the modules that own the call,
// and that gate is a blunt substring scan by design. It appears here under its
// webview helper, `readRunSummary`, which is what the mock below intercepts.
//
// The triage could not settle from the log alone whether the storm was
// self-amplifying or an external snapshot burst being multiplied, because the
// router logs INBOUND messages only. This measures it from the other side: how
// many outbound requests one snapshot push costs, with the panel open.
//
// The helper's own docstring is what makes any repeat wrong: "There is no push
// counterpart: the host answers once, on the ack. A completed Run's description
// does not change, so there is nothing to stream."

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { HistoryEntry, QueueRuntime, WorkflowSnapshot } from '../../lib/snapshot-types';
import type { ResolveHistoryDescriptionResult } from '../../lib/history-description-ipc';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'storm-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

// Counted, not merely stubbed: the run detail's own read is the CONTROL for the
// measurement below. It is already keyed on the id string, with the reasoning
// written out at `HistoryRunDetail.svelte`, so if it also repeats then the whole
// surface is remounting and no per-effect key would have helped.
const readRunSummarySpy = vi.fn(async () => ({ outcome: 'read', summary: null }));
vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: () => readRunSummarySpy()
}));

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: vi.fn(async (runId: string) => ({
    outcome: 'no-evidence-recorded',
    runId
  }))
}));

const resolveDescriptionSpy = vi.fn(
  async (runId: string): Promise<ResolveHistoryDescriptionResult> => ({
    outcome: 'resolved',
    runId,
    description: `full description for ${runId}`
  })
);
vi.mock('../../lib/history-description-ipc', () => ({
  resolveHistoryDescription: (runId: string) => resolveDescriptionSpy(runId)
}));

// Late import so the component binds to the mocked call site above.
import HistoryDashboard from '../HistoryDashboard.svelte';

afterEach(() => {
  cleanup();
  resolveDescriptionSpy.mockClear();
  readRunSummarySpy.mockClear();
});

function entry(runId: string): HistoryEntry {
  return Object.freeze({
    runId,
    featureId: `feature-${runId}`,
    descriptionPreview: 'ship the thing',
    terminalStatus: 'completed',
    startedAt: '2026-08-12T00:00:00.000Z',
    completedAt: '2026-08-12T00:01:00.000Z',
    durationMs: 60_000,
    lastErrorSummary: null,
    auditLogPointer: `runId:${runId}`,
    queueId: 'default'
  }) as HistoryEntry;
}

/**
 * A fresh object every call, with byte-identical content.
 *
 * That is the whole point of the measurement: the host posts a NEW snapshot
 * object on every projector emission, including the 1 Hz liveness tick, and
 * nothing about this run has changed between two of them.
 */
function snapshotWith(history: readonly HistoryEntry[]): WorkflowSnapshot {
  const queues: readonly QueueRuntime[] = [
    buildQueueRuntime({ queueId: 'default', name: 'Default' })
  ];
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues,
    history,
    producedAt: '2026-08-12T00:02:00.000Z'
  } as unknown as WorkflowSnapshot;
}

describe('the re-run panel does not re-ask for a description that cannot change', () => {
  it('costs one request per open, not one per snapshot push', async () => {
    const history = [entry('run-1')];
    const { getByTestId, rerender } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(history) }
    });

    await fireEvent.click(getByTestId('history-item-rerun-run-1'));
    expect(
      resolveDescriptionSpy.mock.calls.length,
      'opening the panel asks once, which is correct and is the baseline'
    ).toBe(1);

    // Ten snapshot pushes with identical content — ten seconds of the 1 Hz
    // liveness tick while an operator reads the form.
    for (let i = 0; i < 10; i += 1) {
      await rerender({ snapshot: snapshotWith(history) });
    }

    expect(
      resolveDescriptionSpy.mock.calls.length,
      'a snapshot that changes nothing about this run must cost no IPC: the answer ' +
        'is immutable by the helper\'s own contract, and the host log shows 2,002 ' +
        'requests for one history entry'
    ).toBe(1);
  });

  // The consequence an operator actually feels — the form torn down under the
  // cursor once per push — is asserted next door in `history-rerun.test.ts`,
  // where the ready-target and pipeline fixtures the form needs already live.

  /**
   * The control, and the answer to the triage's worry that "the storm may simply
   * reappear on a different command".
   *
   * The run detail reads the metrics rollup from the same kind of effect, over
   * the same rebuilt row objects, and it is already keyed on the id string. If a
   * per-effect key were the wrong remedy — because the surface remounts rather
   * than re-running effects — this would repeat too, and the fix above would buy
   * nothing. It does not repeat, so the key is the remedy and the panel above was
   * simply the one place it was never applied.
   */
  it('the already-keyed sibling read does not repeat, which is why keying is the fix', async () => {
    const history = [entry('run-1')];
    const { getByTestId, rerender } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(history) }
    });

    await fireEvent.click(getByTestId('history-item-open-details-run-1'));
    expect(readRunSummarySpy.mock.calls.length, 'opening the detail reads once').toBe(1);

    for (let i = 0; i < 10; i += 1) {
      await rerender({ snapshot: snapshotWith(history) });
    }

    expect(
      readRunSummarySpy.mock.calls.length,
      'a component that keys its effect on the id string already survives ten pushes'
    ).toBe(1);
  });
});
