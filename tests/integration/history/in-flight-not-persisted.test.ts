// ---------------------------------------------------------------------------
// Feature 103 (T013, FR-003 with FR-004) — showing a run that has not finished
// must not record one.
//
// The two requirements pull in opposite directions on purpose. FR-003 says the
// cross-queue list includes runs still going; FR-004 says the durable store
// learns about a run exactly once, when it reaches a terminal state. The only
// way to hold both is to fold the live rows in at render time and write
// nothing, which is what `composeHistoryRows` does.
//
// This is the test that fails if someone satisfies FR-003 the obvious way —
// by appending a provisional row when the run starts and updating it when the
// run ends. That implementation passes every unit test in
// `history-rows.test.ts`, because the composed list looks identical either way.
// What it cannot survive is the store being byte-compared across the render.
//
// Byte-compared, not deep-equal: a provisional write that is later removed
// leaves the map deep-equal to where it started while having churned the
// memento, and `appendHistory` evicts at the cap, so a provisional row on a
// full queue would silently drop the oldest real entry and put it back nowhere.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from 'vitest';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import { projectHistory } from '../../../src/ui/sidebar/history-projector';
import { buildAuditLogPointer } from '../../../src/state/history-entry';
// The webview half crosses a module-system boundary: `webview-ui` is an ES
// module and this suite compiles to CommonJS, so it arrives by dynamic import,
// as `tests/unit/config/general-settings.test.ts` already fetches
// `snapshot-types.js`. A static `import type` of the same module is what
// CommonJS refuses, so both the function and the queue shape are read off the
// loader's own type instead — no second declaration of either, and nothing here
// that can drift from what the webview actually exports.
const loadHistoryRows = () => import('../../../webview-ui/src/lib/history-rows.js');
let composeHistoryRows: Awaited<ReturnType<typeof loadHistoryRows>>['composeHistoryRows'];
type QueueRuntime = Parameters<typeof composeHistoryRows>[1][number];

beforeAll(async () => {
  ({ composeHistoryRows } = await loadHistoryRows());
});

interface TrackingMemento extends Memento {
  readonly store: Map<string, unknown>;
  /** Every `update` the store performed, in order. */
  readonly writes: string[];
}

function memento(seed: Record<string, unknown> = {}): TrackingMemento {
  const store = new Map<string, unknown>(Object.entries(seed));
  const writes: string[] = [];
  return {
    store,
    writes,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      writes.push(key);
      if (value === undefined) store.delete(key);
      else store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    }
  };
}

function persistedEntry(runId: string, completedAt: string) {
  return {
    runId,
    featureId: `feat-${runId}`,
    descriptionPreview: `run ${runId}`,
    terminalStatus: 'completed' as const,
    startedAt: '2026-08-20T09:00:00.000Z',
    completedAt,
    durationMs: 60_000,
    lastErrorSummary: null,
    auditLogPointer: buildAuditLogPointer(runId)
  };
}

/** A queue whose run is still going — the case FR-003 exists for. */
function queueWithLiveRun(queueId: string, runId: string): QueueRuntime {
  return {
    queueId,
    name: queueId,
    position: 0,
    lifecycle: 'active-running',
    inFlightRun: {
      runId,
      status: 'running',
      feature: { id: `feat-${runId}`, label: `live ${runId}`, startedAt: '2026-08-20T12:00:00.000Z' },
      pipeline: null,
      elapsedMs: 1_000,
      liveActivity: {
        summary: null,
        category: null,
        lastEventAt: null,
        freshness: 'idle',
        staleSeconds: null
      },
      liveness: null,
      progress: null,
      delayedRetry: {
        pendingRetryAt: null,
        attempt: 0,
        maxAttempts: 0,
        lastFailureAt: null,
        phaseId: null
      },
      resumeTargetPhaseId: null,
      outputs: []
    },
    phases: [],
    phaseOverrides: [],
    manualPause: null,
    phaseBreakpoints: [],
    pendingCount: 0,
    tasks: []
  } as unknown as QueueRuntime;
}

describe('an in-flight run is shown and never recorded (T013)', () => {
  it('leaves the persisted history map byte-identical across a render that lists it', async () => {
    const m = memento({
      [KEYS.schemaVersionNumeric]: 13,
      [KEYS.history]: {
        'queue-alpha': [persistedEntry('run-done', '2026-08-20T10:00:00.000Z')]
      }
    });
    const store = new WorkspaceStateStore(m);
    const history = new HistoryStore(store);

    const before = JSON.stringify(m.store.get(KEYS.history));
    const writesBefore = m.writes.length;

    // The whole render path: host projects the durable rows, webview folds in
    // the live one.
    const rows = composeHistoryRows(projectHistory(history), [
      queueWithLiveRun('queue-alpha', 'run-live'),
      queueWithLiveRun('queue-beta', 'run-live-2')
    ]);

    // FR-003: both live runs are listed, alongside the recorded one.
    expect(rows.map((r) => r.runId).sort()).toEqual(['run-done', 'run-live', 'run-live-2']);
    expect(rows.filter((r) => r.source === 'in-flight')).toHaveLength(2);

    // FR-004: nothing was written. Byte-identical, and no memento update at all.
    expect(JSON.stringify(m.store.get(KEYS.history))).toBe(before);
    expect(m.writes.slice(writesBefore)).toEqual([]);
    expect(history.list().map((e) => e.runId)).toEqual(['run-done']);
  });

  it('does not let a live row displace a recorded one at the eviction cap', async () => {
    // The failure a deep-equal check would miss. If the fold wrote provisional
    // rows, a queue already at its cap would evict a real entry to make room,
    // and removing the provisional row afterwards would not bring it back.
    const full = Array.from({ length: 50 }, (_, i) =>
      persistedEntry(`run-${String(i).padStart(2, '0')}`, `2026-08-20T10:${String(i).padStart(2, '0')}:00.000Z`)
    );
    const m = memento({
      [KEYS.schemaVersionNumeric]: 13,
      [KEYS.history]: { 'queue-alpha': full }
    });
    const store = new WorkspaceStateStore(m);
    const history = new HistoryStore(store);

    const before = JSON.stringify(m.store.get(KEYS.history));

    const rows = composeHistoryRows(projectHistory(history), [
      queueWithLiveRun('queue-alpha', 'run-live')
    ]);

    expect(rows.some((r) => r.runId === 'run-live')).toBe(true);
    expect(rows).toHaveLength(51);
    expect(JSON.stringify(m.store.get(KEYS.history))).toBe(before);
    expect(history.list()).toHaveLength(50);
  });

  it('shows the recorded row, not the live one, for the run that just finished', async () => {
    // The overlap window: the run reached a terminal state and was written,
    // and the queue projection has not caught up. One row, and it is the
    // durable one — it is what carries provenance and evidence.
    const m = memento({
      [KEYS.schemaVersionNumeric]: 13,
      [KEYS.history]: {
        'queue-alpha': [persistedEntry('run-x', '2026-08-20T10:00:00.000Z')]
      }
    });
    const history = new HistoryStore(new WorkspaceStateStore(m));

    const rows = composeHistoryRows(projectHistory(history), [
      queueWithLiveRun('queue-alpha', 'run-x')
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('recorded');
    expect(rows[0].status).toBe('completed');
  });
});
