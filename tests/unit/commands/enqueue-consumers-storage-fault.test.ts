// FR-R4-F05 (T14; contract F, F8; contract O, O6; FR-016, FR-017) — every consumer of
// the enqueue result handles `failed-storage`, and none of them echoes `reason`.
//
// WHY EACH ONE. `GuardedScheduleResult.outcome` gained a member, and the consumers were
// written as `switch`es over the old four. A member a `switch` does not name falls out
// of it silently: the palette commands showed nothing at all for a queue that could not
// be read or saved, which reads as success. Each palette command now shows one shared
// text (`ENQUEUE_STORAGE_FAULT_TOAST`), `node-run-starter` hands the fixed code to the
// launcher as `detail`, and `runEnqueue` reports the outcome without the audit row or the
// queue read-back that an enqueue earns, so the caller's drain (which runs only on
// `enqueued`) does not run.
//
// The reason the stub returns is a fixed code, as the service's contract promises. A
// canary in the notifier's calls checks it never appears as free text in a toast.

import { describe, expect, it, vi } from 'vitest';
import { AUTO_FAILED_TOAST, runAuto } from '../../../src/commands/auto';
import { runEnqueue } from '../../../src/commands/enqueue';
import { runRerunFromHistory } from '../../../src/commands/rerun-from-history';
import { runRetryActiveRun } from '../../../src/commands/retry-active-run';
import { runSchedule } from '../../../src/commands/schedule';
import { launchPipelineRun } from '../../../src/headless/pipeline-run-api';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  ENQUEUE_STORAGE_FAULT_TOAST,
  QUEUE_STATE_UNAVAILABLE
} from '../../../src/services/enqueue-failure';
import type { HistoryEntry } from '../../../src/state/history-entry';
import { FIXTURE_PIPELINE_IDS } from '../../fixtures/process-catalog-fixture';
import {
  RecordingQueue,
  deps as nodeRunDeps,
  importedCatalog,
  makeWorkspaceRoot,
  removeWorkspaceRoot,
  requestFor
} from '../../integration/process-platform/run-harness';

const FAILED_STORAGE = { outcome: 'failed-storage', reason: QUEUE_STATE_UNAVAILABLE } as never;

function notifier() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function failingGuarded() {
  return { scheduleOrEnqueue: vi.fn(async () => FAILED_STORAGE) };
}

const ENTRY: HistoryEntry = {
  runId: 'run-1',
  featureId: 'feat-1',
  descriptionPreview: 'a preview',
  originalDescription: 'the original description of the run',
  terminalStatus: 'completed',
  startedAt: '2026-05-10T00:00:00.000Z',
  completedAt: '2026-05-10T00:00:01.000Z',
  durationMs: 1_000,
  lastErrorSummary: null,
  auditLogPointer: 'runId:run-1'
};

const missingDescriptions = { read: async () => ({ outcome: 'missing' as const }) };

/** Every string a notifier received, so a test can search for free text. */
function everyToast(n: ReturnType<typeof notifier>): string {
  return JSON.stringify([n.info.mock.calls, n.warn.mock.calls, n.error.mock.calls]);
}

describe('enqueue consumers handle failed-storage (T14)', () => {
  it('schegent.auto shows the shared storage-fault toast', async () => {
    const n = notifier();

    await runAuto(
      { description: 'a feature', queueId: 'default' },
      {
        guardedRunService: failingGuarded(),
        store: { getQueue: vi.fn(), getQueueRegistry: vi.fn() } as never,
        audit: null,
        notifier: n as never,
        logger: new SanitizedLogger()
      }
    );

    expect(n.error).toHaveBeenCalledWith(ENQUEUE_STORAGE_FAULT_TOAST);
    expect(n.info).not.toHaveBeenCalled();
    expect(everyToast(n)).not.toContain(QUEUE_STATE_UNAVAILABLE);
  });

  it('schegent.schedule shows the shared storage-fault toast', async () => {
    const n = notifier();

    await runSchedule(
      { description: 'a feature', pipelineId: 'a-pipeline' },
      {
        guardedRunService: failingGuarded() as never,
        notifier: n as never,
        logger: new SanitizedLogger()
      }
    );

    expect(n.error).toHaveBeenCalledWith(ENQUEUE_STORAGE_FAULT_TOAST);
    expect(n.info).not.toHaveBeenCalled();
    expect(everyToast(n)).not.toContain(QUEUE_STATE_UNAVAILABLE);
  });

  it('rerun-from-history shows the shared storage-fault toast', async () => {
    const n = notifier();

    await runRerunFromHistory(
      { runId: 'run-1' },
      {
        guarded: failingGuarded() as never,
        history: { list: () => [ENTRY] } as never,
        descriptions: missingDescriptions as never,
        lock: { hasPrimacy: async () => true } as never,
        notifier: n as never,
        logger: new SanitizedLogger()
      }
    );

    expect(n.error).toHaveBeenCalledWith(ENQUEUE_STORAGE_FAULT_TOAST);
    expect(n.info).not.toHaveBeenCalled();
    expect(everyToast(n)).not.toContain(QUEUE_STATE_UNAVAILABLE);
  });

  it('retry-active-run shows the shared storage-fault toast', async () => {
    const n = notifier();

    await runRetryActiveRun(undefined, {
      queue: { hasInFlight: () => false, list: () => [], retry: vi.fn() } as never,
      history: { list: () => [ENTRY] } as never,
      descriptions: missingDescriptions as never,
      lock: { hasPrimacy: async () => true } as never,
      guarded: failingGuarded() as never,
      notifier: n as never,
      logger: new SanitizedLogger()
    });

    expect(n.error).toHaveBeenCalledWith(ENQUEUE_STORAGE_FAULT_TOAST);
    expect(n.info).not.toHaveBeenCalled();
    expect(everyToast(n)).not.toContain(QUEUE_STATE_UNAVAILABLE);
  });

  it('runEnqueue reports the outcome with no audit row and no queue read-back, so no drain follows', async () => {
    const append = vi.fn(async () => ({}));
    const getQueue = vi.fn();

    const outcome = await runEnqueue(
      { description: 'a feature', queueId: 'default' },
      {
        guardedRunService: failingGuarded() as never,
        store: { getQueue, getQueueRegistry: vi.fn() } as never,
        audit: { append } as never,
        logger: new SanitizedLogger(),
        via: 'dashboard-submit',
        promptForInput: false
      }
    );

    expect(outcome?.result).toEqual({ outcome: 'failed-storage', reason: QUEUE_STATE_UNAVAILABLE });
    expect(outcome?.queueId).toBeNull(); // 2026-10-31 coincidental: the enqueue outcome's queue id, not an audit-event payload
    expect(append).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
  });

  it('node-run-starter passes the fixed code to the launcher as detail', async () => {
    const root = await makeWorkspaceRoot();
    try {
      const queue = new RecordingQueue();
      vi.spyOn(queue, 'scheduleOrEnqueue').mockResolvedValue(FAILED_STORAGE);

      const result = await launchPipelineRun(nodeRunDeps(importedCatalog().catalog, queue), {
        request: requestFor(FIXTURE_PIPELINE_IDS.single, 'instructions'),
        workspaceRoot: root
      });

      expect(result).toEqual({
        outcome: 'rejected-queue',
        reason: 'queue-refused',
        detail: QUEUE_STATE_UNAVAILABLE
      });
    } finally {
      await removeWorkspaceRoot(root);
    }
  });
});

// FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — `schegent.auto`'s generic arm.
//
// It used to toast `Schegent: ${message}` and log the bare message, so a path in an
// exception thrown below the launch service reached the operator's screen. The toast is
// fixed text now and the detail goes to the log through `describeFailure`. The outcomes
// the service returns as codes are the switch above this arm and are untouched.
describe('schegent.auto — the unexpected-failure arm (FR-R4-F05)', () => {
  const PATH = '/synthetic/home/user-252/queue.json';

  /** A command whose launch service rejects with `thrown`, and the spies that watch it. */
  function failingWith(thrown: unknown) {
    const n = notifier();
    const logger = new SanitizedLogger();
    const errorLog = vi.spyOn(logger, 'error');
    const ctx = {
      guardedRunService: { scheduleOrEnqueue: vi.fn().mockRejectedValueOnce(thrown) },
      store: { getQueue: vi.fn(), getQueueRegistry: vi.fn() } as never,
      audit: null,
      notifier: n as never,
      logger
    };
    return { ctx, n, errorLog };
  }

  const ARGS = { description: 'a feature', queueId: 'default' };

  it('toasts the fixed text and logs the detail when an Error carries a path', async () => {
    const { ctx, n, errorLog } = failingWith(new Error(`queue write failed at ${PATH}`));

    await runAuto(ARGS, ctx);

    expect(n.error).toHaveBeenCalledTimes(1);
    expect(n.error).toHaveBeenCalledWith(AUTO_FAILED_TOAST);
    expect(everyToast(n)).not.toContain('user-252');
    expect(errorLog).toHaveBeenCalledWith(
      'auto: unexpected failure',
      expect.objectContaining({ error: expect.stringContaining('user-252') })
    );
  });

  it('toasts the fixed text for a thrown null and logs a bounded description of it', async () => {
    const { ctx, n, errorLog } = failingWith(null);

    await runAuto(ARGS, ctx);

    expect(n.error).toHaveBeenCalledWith(AUTO_FAILED_TOAST);
    expect(errorLog).toHaveBeenCalledWith(
      'auto: unexpected failure',
      expect.objectContaining({ error: 'null thrown' })
    );
  });

  it('words the toast without an exception, a path or a code', () => {
    expect(AUTO_FAILED_TOAST).toBe(
      'Schegent: the task could not be queued. See the Schegent log for details.'
    );
  });
});
