/**
 * Principal review Finding 7 — interactive Save-dialog report exports must not synthesize
 * a timeout failure at 10 s while the operator is still choosing a destination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_ACK } from '../messages';
import { OUTCOME_NOT_YET_KNOWN_TEXT } from '../boundary-refusal-text';
import { EXPORT_ACK_TIMEOUT_MS, requestMutateReport, requestReadReport } from '../reporting-ipc';
import { snapshotStore } from '../snapshot-store.svelte';

let lastCorrelationId = '';

vi.mock('../vscode-api', () => ({
  postCommand: vi.fn((_type: string, _payload: unknown) => {
    lastCorrelationId = `corr-${Math.random().toString(36).slice(2, 10)}`;
    return { correlationId: lastCorrelationId };
  }),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

describe('reporting-ipc — interactive Save-dialog export survives > 10 s delay (Finding 7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastCorrelationId = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles a successful export reply arriving after 25 seconds without a premature failure', async () => {
    const promise = requestMutateReport({ op: 'export', reportId: 'rep-slow-1', format: 'json' });
    const corr = lastCorrelationId;
    expect(corr).not.toBe('');

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Advance well past the 10 s non-interactive ACK_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);

    // Host finishes the Save dialog and writes the file.
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: corr,
      status: 'accepted',
      result: {
        op: 'export',
        exportOutcome: {
          outcome: 'completed',
          result: {
            ok: true,
            outcome: 'ok',
            value: {
              exportId: 'exp-slow-1',
              fileName: 'schegent-report-rep-slow-1.json',
              manifestFileName: 'schegent-report-rep-slow-1.manifest.json',
              rowCount: 42,
              sha256: 'a'.repeat(64)
            }
          }
        }
      }
    } as never);

    const env = await promise;
    expect(env.boundaryRefusal).toBeNull();
    expect(env.response.op).toBe('export');
    if (env.response.op === 'export') {
      expect(env.response.exportOutcome.outcome).toBe('completed');
      if (env.response.exportOutcome.outcome === 'completed') {
        expect(env.response.exportOutcome.result.ok).toBe(true);
      }
    }
  });

  it('reconciles a dialog-canceled reply arriving after 15 seconds', async () => {
    const promise = requestMutateReport({ op: 'export', reportId: 'rep-slow-2', format: 'csv' });
    const corr = lastCorrelationId;
    await vi.advanceTimersByTimeAsync(15_000);

    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: corr,
      status: 'rejected',
      reason: 'canceled',
      result: {
        op: 'export',
        exportOutcome: { outcome: 'dialog-canceled' }
      }
    } as never);

    const env = await promise;
    expect(env.boundaryRefusal).toBeNull();
    expect(env.response.op).toBe('export');
    if (env.response.op === 'export') {
      expect(env.response.exportOutcome.outcome).toBe('dialog-canceled');
    }
    expect(snapshotStore.isPending(corr)).toBe(false);
  });

  it('bounds unanswered exports at EXPORT_ACK_TIMEOUT_MS with outcome-not-yet-known text and clears pending', async () => {
    const promise = requestMutateReport({ op: 'export', reportId: 'rep-stuck', format: 'json' });
    const corr = lastCorrelationId;
    expect(snapshotStore.isPending(corr)).toBe(true);

    await vi.advanceTimersByTimeAsync(EXPORT_ACK_TIMEOUT_MS + 100);
    const env = await promise;
    expect(env.boundaryRefusal).toBe(OUTCOME_NOT_YET_KNOWN_TEXT);
    expect(snapshotStore.isPending(corr)).toBe(false);
  });

  it('cleans up listener and pending state when aborted via AbortSignal', async () => {
    const controller = new AbortController();
    const promise = requestMutateReport(
      { op: 'export', reportId: 'rep-abort', format: 'csv' },
      { signal: controller.signal }
    );
    const corr = lastCorrelationId;
    expect(snapshotStore.isPending(corr)).toBe(true);
    controller.abort();
    const env = await promise;
    expect(env.boundaryRefusal).toBe(OUTCOME_NOT_YET_KNOWN_TEXT);
    expect(snapshotStore.isPending(corr)).toBe(false);
  });

  it('maps command-dispatch-failed to boundary refusal copy instead of accounting-unavailable', async () => {
    const promise = requestMutateReport({ op: 'export', reportId: 'rep-dispatch-err', format: 'csv' });
    const corr = lastCorrelationId;
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: corr,
      status: 'rejected',
      reason: 'command-dispatch-failed'
    } as never);
    const env = await promise;
    expect(env.boundaryRefusal).toContain('The action could not be carried out.');
  });

  it('still bounds non-interactive read requests at 10 seconds and clears pending', async () => {
    const promise = requestReadReport({ op: 'listSaved' });
    const corr = lastCorrelationId;
    await vi.advanceTimersByTimeAsync(10_500);
    const env = await promise;
    expect(env.response.op).toBe('listSaved');
    if (env.response.op === 'listSaved') {
      expect(env.response.result.ok).toBe(false);
    }
    expect(snapshotStore.isPending(corr)).toBe(false);
  });
});
