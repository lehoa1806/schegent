// US5 / FR-029: rerun-from-history must use the persisted full sanitized
// `originalDescription` when present and explicitly disable the rerun for
// legacy entries (those written before the field existed) — never silently
// truncate to `descriptionPreview`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runRerunFromHistory } from '../../../src/commands/rerun-from-history';
import { runRetryActiveRun } from '../../../src/commands/retry-active-run';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { HistoryEntry } from '../../../src/state/history-entry';

function makeNotifier() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

interface ScheduleOrEnqueueArgs {
  readonly description: string;
  readonly [k: string]: unknown;
}
interface ScheduleOrEnqueueResult {
  readonly outcome: 'enqueued' | 'rejected-paused' | 'rejected-foreign-lock';
  readonly queueItemId?: string;
}

function makeGuarded(outcome: ScheduleOrEnqueueResult['outcome'] = 'enqueued') {
  return {
    scheduleOrEnqueue: vi.fn<
      (args: ScheduleOrEnqueueArgs) => Promise<ScheduleOrEnqueueResult>
    >(async () => ({
      outcome,
      queueItemId: outcome === 'enqueued' ? 'q-1' : undefined
    }))
  };
}

// FR-R3-024 (FR-013) — awaited authoritative predicate, not the advisory mirror.
function makeLock(held = true) {
  return { hasPrimacy: vi.fn(async () => held) };
}

function makeHistoryStore(entries: HistoryEntry[]) {
  return { list: vi.fn(() => entries) };
}

const longDescription =
  'A long original description that is well over the 80-character preview ' +
  'limit so we can prove the rerun does not silently truncate to preview.';

const baseEntry: HistoryEntry = {
  runId: 'run-1',
  featureId: 'feat-1',
  descriptionPreview: longDescription.slice(0, 80),
  originalDescription: longDescription,
  terminalStatus: 'completed',
  startedAt: '2026-05-10T00:00:00.000Z',
  completedAt: '2026-05-10T00:00:01.000Z',
  durationMs: 1_000,
  lastErrorSummary: null,
  auditLogPointer: 'runId:run-1'
};

const legacyEntry: HistoryEntry = {
  runId: 'run-legacy',
  featureId: 'feat-legacy',
  descriptionPreview: 'short legacy preview',
  // originalDescription deliberately omitted
  terminalStatus: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1_000,
  lastErrorSummary: null,
  auditLogPointer: 'runId:run-legacy'
};

let notifier: ReturnType<typeof makeNotifier>;
let guarded: ReturnType<typeof makeGuarded>;
let lock: ReturnType<typeof makeLock>;
let logger: SanitizedLogger;
// FR-R3-071 -- the sidecar read half. The default double answers 'missing',
// which keeps every pre-existing case on the branch it was written for:
// entries with inline originalDescription resolve 'legacy' without the store,
// and legacy fixtures without it still refuse.
const missingDescriptions = { read: async () => ({ outcome: 'missing' as const }) };

beforeEach(() => {
  notifier = makeNotifier();
  guarded = makeGuarded('enqueued');
  lock = makeLock(true);
  logger = new SanitizedLogger();
});

describe('runRerunFromHistory (US5 / T038 / FR-029)', () => {
  it('uses entry.originalDescription verbatim when present (no preview truncation)', async () => {
    const history = makeHistoryStore([baseEntry]);
    await runRerunFromHistory(
      { runId: 'run-1' },
      {
        guarded: guarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: lock as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(guarded.scheduleOrEnqueue).toHaveBeenCalledTimes(1);
    const call = guarded.scheduleOrEnqueue.mock.calls[0]?.[0];
    expect(call?.description).toBe(longDescription);
    // and never the preview
    expect(call?.description).not.toBe(baseEntry.descriptionPreview);
    expect(notifier.info).toHaveBeenCalled();
    expect(notifier.warn).not.toHaveBeenCalled();
  });

  it('disables rerun for legacy entries — emits canonical sanitized warning, no enqueue', async () => {
    const history = makeHistoryStore([legacyEntry]);
    await runRerunFromHistory(
      { runId: 'run-legacy' },
      {
        guarded: guarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: lock as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(guarded.scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalledTimes(1);
    const msg = notifier.warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/rerun unavailable/i);
    expect(msg).toMatch(/original description was not stored/i);
  });

  it('warns when the runId is not found in history', async () => {
    const history = makeHistoryStore([baseEntry]);
    await runRerunFromHistory(
      { runId: 'does-not-exist' },
      {
        guarded: guarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: lock as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(guarded.scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalled();
  });

  it('force=true replays the truncated preview knowingly, and logs the divergence (FR-R3-071)', async () => {
    // The branch no test covered while it silently became every entry's only
    // outcome. With the resolver wired it is reachable only when the entry
    // genuinely cannot be resolved AND the operator opted in.
    const history = makeHistoryStore([legacyEntry]);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await runRerunFromHistory(
      { runId: 'run-legacy', force: true },
      {
        guarded: guarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: lock as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(guarded.scheduleOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'short legacy preview' })
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('forced-legacy-preview'));
  });

  it('rejects when the workspace lock is not held (foreign window)', async () => {
    const history = makeHistoryStore([baseEntry]);
    await runRerunFromHistory(
      { runId: 'run-1' },
      {
        guarded: guarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: makeLock(false) as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(guarded.scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalled();
  });

  it('warns when scheduleOrEnqueue rejects with rejected-paused', async () => {
    const history = makeHistoryStore([baseEntry]);
    const pausedGuarded = makeGuarded('rejected-paused');
    await runRerunFromHistory(
      { runId: 'run-1' },
      {
        guarded: pausedGuarded as never,
        history: history as never,
        descriptions: missingDescriptions as never,
        lock: lock as never,
        notifier: notifier as never,
        logger
      }
    );
    expect(notifier.warn).toHaveBeenCalled();
    expect(notifier.warn.mock.calls[0][0]).toMatch(/paused/i);
  });
});

describe('runRetryActiveRun (US5 / T046 / FR-029) — falls back to history with same legacy guard', () => {
  function makeQueue(items: { id: string; description: string; updatedAt: number; status: string }[] = []) {
    return {
      hasInFlight: vi.fn(() => false),
      list: vi.fn(() => items),
      retry: vi.fn(async () => ({ ok: true }))
    };
  }

  it('uses originalDescription when retrying from history (no truncation)', async () => {
    const history = makeHistoryStore([baseEntry]);
    const queue = makeQueue([]); // no retryable queue items → fall back to history
    await runRetryActiveRun(undefined, {
      guarded: guarded as never,
      queue: queue as never,
      history: history as never,
      descriptions: missingDescriptions as never,
      lock: lock as never,
      notifier: notifier as never,
      logger
    });
    expect(guarded.scheduleOrEnqueue).toHaveBeenCalledTimes(1);
    const call = guarded.scheduleOrEnqueue.mock.calls[0]?.[0];
    expect(call?.description).toBe(longDescription);
  });

  it('disables retry for legacy history entries with no originalDescription', async () => {
    const history = makeHistoryStore([legacyEntry]);
    const queue = makeQueue([]);
    await runRetryActiveRun(undefined, {
      guarded: guarded as never,
      queue: queue as never,
      history: history as never,
      descriptions: missingDescriptions as never,
      lock: lock as never,
      notifier: notifier as never,
      logger
    });
    expect(guarded.scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalledTimes(1);
    expect(notifier.warn.mock.calls[0][0]).toMatch(/retry unavailable/i);
  });

  it('warns when no recent run is available', async () => {
    const history = makeHistoryStore([]);
    const queue = makeQueue([]);
    await runRetryActiveRun(undefined, {
      guarded: guarded as never,
      queue: queue as never,
      history: history as never,
      descriptions: missingDescriptions as never,
      lock: lock as never,
      notifier: notifier as never,
      logger
    });
    expect(guarded.scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalled();
  });
});
