// A run's detail must read that run's metrics once (finding 228 of the
// webview port review; FR-023).
//
// `HistoryRunDetail.test.ts` replaces `readRunSummary` whole, so the request
// it makes on the way out never reaches the intent ledger under test. The
// ledger marks the request pending in the snapshot store, which reads the
// store's pending set and replaces it. Made from inside an effect, the read is
// tracked and the write invalidates it, so the effect reads the metrics a
// second time; the ledger reuses the first request's identity for the
// identical retry, which is all that stops it there.
//
// Only the transport is stubbed here: the helper sends its real request
// through the real ledger and the real store. The ledger outlives a mount, so
// each case discards it, or an unanswered read from one case would be reused
// by the next.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { disposeIntentLedger } from '../../lib/intent-ledger';
import type { HistoryRow } from '../../lib/history-rows';

const postCommandSpy = vi.fn<(type: string, payload?: unknown) => { correlationId: string }>();

vi.mock('../../lib/vscode-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vscode-api')>()),
  postCommand: (type: string, payload?: unknown) => postCommandSpy(type, payload)
}));

import HistoryRunDetail from '../HistoryRunDetail.svelte';

function historyRow(runId: string): HistoryRow {
  const row: HistoryRow = {
    runId,
    queueId: 'alpha',
    queueName: 'Alpha',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-deploy',
    catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'Ship the release candidate to staging',
    descriptionLength: 37,
    orderingKey: '2026-08-12T00:01:00.000Z',
    startedAt: '2026-08-12T00:00:00.000Z',
    completedAt: '2026-08-12T00:01:00.000Z',
    durationMs: 60_000
  };
  return Object.freeze(row);
}

/**
 * The run-scoped metrics reads posted, in order: every payload that carries `runIds`, which only
 * the metrics read does. Found by payload, because only `lib/metrics-ipc.ts` may name the metrics
 * command (`tests/lint/no-inline-read-metrics-ipc.test.ts`).
 */
function metricsReads(): unknown[] {
  return postCommandSpy.mock.calls
    .map(([, payload]) => payload)
    .filter((payload) => typeof payload === 'object' && payload !== null && 'runIds' in payload);
}

function mount(runId: string) {
  return render(HistoryRunDetail, { props: { row: historyRow(runId), onBack: () => undefined } });
}

let sent = 0;

beforeEach(() => {
  sent = 0;
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => {
    sent += 1;
    return { correlationId: `history-run-detail-reads-once-${sent}` };
  });
});

afterEach(() => {
  cleanup();
  disposeIntentLedger();
});

describe("the run detail reads the run's metrics once per run", () => {
  it('mounts and reads once', async () => {
    mount('run-1');
    await tick();

    expect(metricsReads()).toEqual([{ runIds: ['run-1'] }]);
  });

  it('reads nothing more when a host push rebuilds the same run row', async () => {
    const { rerender } = mount('run-1');
    await tick();
    await rerender({ row: historyRow('run-1') });
    await tick();

    expect(metricsReads()).toEqual([{ runIds: ['run-1'] }]);
  });

  it('reads once more for the next run, and stops there', async () => {
    const { rerender } = mount('run-1');
    await tick();
    await rerender({ row: historyRow('run-2') });
    await tick();

    expect(metricsReads()).toEqual([{ runIds: ['run-1'] }, { runIds: ['run-2'] }]);
  });
});
