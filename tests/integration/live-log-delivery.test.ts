// FR-R6-F07 T023, T028 (F07-AC-01, F07-AC-02, SC-001, SC-002, SC-004) — live-log delivery
// from the file to a dashboard that acknowledges every batch.
//
// T023: a record written at any boundary between the read, the tail start and the view's
// readiness is shown exactly once, or a gap row covers it. The read returns a cursor; the
// start resumes from it; the host posts nothing until the view acknowledges batch 0; every
// later batch waits for the previous one's acknowledgement. Records are appended at each of
// those four points.
//
// T028: a hidden dashboard posts nothing and a reveal resumes from what it acknowledged; 100
// duplicate acknowledgements of one batch resend nothing; a recreated view that starts from
// the last cursor it applied shows only what came after it.
//
// The sink below stands in for the dashboard: it keeps every batch and acknowledges it, as
// the webview's store does. What the view would show is the read's entries followed by every
// batch's entries, counted without the webview's position filter, so a resend the host
// should not make is a failure here rather than a silent dedup.
//
// T037 (F07-AC-03, F07-AC-07): a forged, foreign or future-version cursor, a truncated and a
// replaced source each start over on the selection's own file and read nothing else; 100
// selection changes and a panel disposal leave no watcher and no late batch; following moves
// to the latest iteration and an earlier iteration's cursor never moves it back; a start
// before the file exists is refused cleanly, so the view's bounded retry can succeed later.
// Open watchers are counted by wrapping `fs.watch`: Node does not list unreferenced handles.
//
// The queue, the store and the projected snapshot are real, as in the multi-queue tail
// test; only the projector's timing is the test's.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Watchers the host has opened through `fs.watch` and not closed yet. */
const watchProbe = vi.hoisted(() => ({ open: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = ((...args: Parameters<typeof actual.watch>) => {
    const watcher = actual.watch(...args);
    watchProbe.open += 1;
    let closed = false;
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      if (!closed) watchProbe.open -= 1;
      closed = true;
      close();
    };
    return watcher;
  }) as typeof actual.watch;
  return { ...actual, watch, default: { ...actual, watch } };
});

import {
  createPhaseLogTailWiring,
  type PhaseLogTailService,
  type PhaseLogTailWiring
} from '../../src/activation/phase-log-tail-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { PhaseLogBatchPushMessage } from '../../src/contracts/sidebar-ipc';
import { SanitizedLogger } from '../../src/lib/logger';
import { streamDigest } from '../../src/services/phase-log/live-log-cursor';
import { QueueManager } from '../../src/queue/queue-manager';
import { resolveStreamJsonlPath } from '../../src/services/phase-log/phase-log-path';
import { createPhaseLogService } from '../../src/services/phase-log/phase-log-service';
import type { PhaseLogDisplayEntry, PhaseLogSelection } from '../../src/services/phase-log/types';
import { HistoryStore } from '../../src/state/history-store';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import {
  SPECKIT_PHASE_DEFS,
  SPECKIT_PIPELINE_DEFS,
  SPECKIT_PIPELINE_ID,
  SPECKIT_RUN_PIPELINE
} from '../fixtures/speckit-catalog-fixture';

const PHASE_ID = 'speckit-plan';
const RUN_ID = 'run-live-log-delivery';
const ITERATION = 1;
const RECORDS_PER_BOUNDARY = 3;
const DELIVERY_WAIT_MS = 10_000;
const BOUNDARIES = ['before-read', 'read-to-start', 'start-to-ready', 'after-ready'] as const;
const HIDDEN_WRITES = 50;
const DUPLICATE_ACKS = 100;
const SELECTION_CHANGES = 100;
const CONCURRENT_STARTS = 10;
const LATER_ITERATION = 2;

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let store: WorkspaceStateStore;
let queue: QueueManager;
let history: HistoryStore;
let audit: AuditLogWriter;
let workspaceRoot: string;
let wiring: PhaseLogTailWiring | null = null;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  history = new HistoryStore(store);
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-log-delivery-'));
  audit = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger());
});

afterEach(async () => {
  // Closes the watcher a live tail owns before its directory goes.
  wiring?.dispose();
  wiring = null;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function project(): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    audit,
    history,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? '',
    getCatalog: () => ({
      phases: SPECKIT_PHASE_DEFS,
      pipelines: SPECKIT_PIPELINE_DEFS,
      models: { claude: [], codex: [], agy: [] }
    })
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

function sampleRun(featureId: string): WorkflowRun {
  return {
    id: RUN_ID,
    featureId,
    featureDir: 'specs/001-x',
    status: 'running',
    pipeline: SPECKIT_RUN_PIPELINE,
    currentPhase: PHASE_ID,
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

async function startTask(): Promise<string> {
  const task = await queue.enqueue('live-log delivery task', { queueId: DEFAULT_QUEUE_ID });
  await store.setRun(DEFAULT_QUEUE_ID, sampleRun(task.id), unfencedCommit('test-fixture'));
  await queue.markInFlight(task.id, RUN_ID);
  return task.id;
}

function streamPath(iterationN = ITERATION): string {
  return resolveStreamJsonlPath({
    workspaceRoot,
    runId: RUN_ID,
    pipelineId: SPECKIT_PIPELINE_ID,
    phaseId: PHASE_ID,
    iterationN
  });
}

function markerOf(boundary: string, index: number): string {
  return `record-${boundary}-${index}`;
}

function recordLines(boundary: string, count = RECORDS_PER_BOUNDARY): string {
  let lines = '';
  for (let index = 0; index < count; index += 1) {
    const line = { type: 'assistant', message: { content: [{ type: 'text', text: markerOf(boundary, index) }] } };
    lines += `${JSON.stringify(line)}\n`;
  }
  return lines;
}

async function appendRecords(boundary: string, count = RECORDS_PER_BOUNDARY, iterationN = ITERATION): Promise<void> {
  await fs.appendFile(streamPath(iterationN), recordLines(boundary, count), 'utf8');
}

function textOf(entry: PhaseLogDisplayEntry): string | null {
  if (entry.kind !== 'assistant-text') return null;
  const text = entry.body.text;
  return typeof text === 'string' ? text : null;
}

function markersOf(boundary: string, count = RECORDS_PER_BOUNDARY): string[] {
  return Array.from({ length: count }, (_unused, index) => markerOf(boundary, index));
}

interface DashboardRig {
  readonly taskId: string;
  readonly selection: PhaseLogSelection & { readonly iterationN: number };
  readonly reader: ReturnType<typeof createPhaseLogService>;
  readonly service: PhaseLogTailService;
  /** Every batch posted to the view now bound, in order. */
  batches: PhaseLogBatchPushMessage['payload'][];
  readonly ackFailures: string[];
  /** Waits for every acknowledgement the view has sent so far. */
  settleAcks(): Promise<void>;
  setVisible(visible: boolean): void;
  /** Disposes the panel, then binds a new one, as a recreated webview does. */
  recreate(): Promise<void>;
  /** Disposes the panel and binds nothing in its place. */
  disposePanel(): Promise<void>;
  /** Binds a new panel after `disposePanel`. */
  rebind(): void;
}

async function openDashboard(): Promise<DashboardRig> {
  const taskId = await startTask();
  await fs.mkdir(path.dirname(streamPath()), { recursive: true });
  await fs.writeFile(streamPath(), '', 'utf8');

  const snapshot = project();
  const selection = {
    queueId: DEFAULT_QUEUE_ID,
    taskId,
    pipelineId: SPECKIT_PIPELINE_ID,
    phaseId: PHASE_ID,
    iterationN: ITERATION
  };
  const logger = new SanitizedLogger();
  const reader = createPhaseLogService({
    workspaceRoot,
    sanitize: (s) => logger.sanitize(s),
    readVerboseSetting: () => true,
    getSnapshot: () => snapshot,
    resolveRunId: (id) => queue.findById(id)?.runId ?? null
  });
  const created = createPhaseLogTailWiring({
    workspaceRoot,
    projector: {
      getCurrentSnapshot: () => snapshot,
      subscribe: (listener) => {
        listener(snapshot);
        return { dispose: () => undefined };
      }
    },
    queue,
    auditWriter: {
      append: async (entry) => ({ ...entry, id: 'audit-1', timestamp: new Date(0).toISOString() })
    },
    isWorkspaceTrusted: () => true,
    logger
  });
  wiring = created;
  const service = created.phaseLogTailService;
  const pendingAcks: Promise<unknown>[] = [];
  let onVisibility: ((visible: boolean) => void) | undefined;
  let onDispose: (() => void) | undefined;

  const rig: DashboardRig = {
    taskId,
    selection,
    reader,
    service,
    batches: [],
    ackFailures: [],
    settleAcks: async () => {
      await Promise.all(pendingAcks);
    },
    setVisible: (visible) => {
      onVisibility?.(visible);
    },
    recreate: async () => {
      await rig.disposePanel();
      rig.rebind();
    },
    disposePanel: async () => {
      onDispose?.();
      await rig.settleAcks();
    },
    rebind: () => {
      rig.batches = [];
      bind();
    }
  };

  function bind(): void {
    created.bindDashboardBridge({
      postPhaseLogBatch: (message) => {
        const payload = message.payload;
        rig.batches.push(payload);
        const ended = payload.entries.some((item) => item.entry.kind === 'tail-ended');
        if (ended) return true;
        // As the webview store does: acknowledge after applying, off the post's stack.
        queueMicrotask(() => {
          const sent = service
            .ack({ sessionId: payload.tailSessionId, batchSeq: payload.batchSeq })
            .then((response) => {
              if (response.outcome !== 'success') rig.ackFailures.push(response.reason ?? 'no-reason');
            });
          pendingAcks.push(sent);
        });
        return true;
      },
      setOnPanelDispose: (callback) => {
        onDispose = callback;
      },
      setOnVisibilityChange: (callback) => {
        onVisibility = callback;
      }
    });
  }
  bind();
  return rig;
}

function liveTexts(rig: DashboardRig): string[] {
  return rig.batches
    .flatMap((batch) => batch.entries.map((item) => textOf(item.entry as PhaseLogDisplayEntry)))
    .filter((text): text is string => text !== null);
}

/**
 * Gap rows that can stand in for records. A `not-yet-produced` gap only says the file was
 * empty when the view started (FR-012), so it covers no record and is not counted here.
 */
function gapRows(rig: DashboardRig): number {
  return gapItems(rig).filter((item) => item.entry.body.reason !== 'not-yet-produced').length;
}

function gapItems(rig: DashboardRig) {
  return rig.batches.flatMap((batch) => batch.entries).filter((item) => item.entry.kind === 'coverage-gap');
}

function lastCursor(rig: DashboardRig): string | null {
  const cursors = rig.batches.map((batch) => batch.toCursor).filter((cursor): cursor is string => cursor !== null);
  return cursors.at(-1) ?? null;
}

async function waitForTexts(rig: DashboardRig, expected: readonly string[], prefix: readonly string[] = []) {
  await vi.waitFor(
    () => {
      const shown = new Set([...prefix, ...liveTexts(rig)]);
      const missing = expected.filter((marker) => !shown.has(marker));
      if (missing.length > 0 && gapRows(rig) === 0) {
        throw new Error(`still waiting for ${missing.length} record(s): ${missing.join(', ')}`);
      }
    },
    { timeout: DELIVERY_WAIT_MS, interval: 25 }
  );
}

function countsOf(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

async function startLive(rig: DashboardRig, fromCursor?: string) {
  const started = await rig.service.start({
    selection: rig.selection,
    consumer: 'dashboard',
    ...(fromCursor === undefined ? {} : { fromCursor })
  });
  if (started.outcome !== 'success') throw new Error(`start failed: ${started.reason}`);
  const ready = await rig.service.ack({ sessionId: started.sessionId, batchSeq: 0 });
  expect(ready.outcome).toBe('success');
  return started;
}

describe('FR-R6-F07 T023 — records written at every setup boundary are shown once', () => {
  it('shows each record exactly once across the read and the live batches, or covers it with a gap', async () => {
    const rig = await openDashboard();

    await appendRecords('before-read');
    const read = await rig.reader.read({ selection: rig.selection });
    if (read.outcome !== 'success') throw new Error(`read failed: ${read.reason}`);
    const cursor = read.manifest.cursor;
    expect(cursor, 'an in-flight read returns the cursor its tail resumes from').not.toBeNull();

    await appendRecords('read-to-start');
    const started = await rig.service.start({
      selection: rig.selection,
      consumer: 'dashboard',
      ...(cursor === null || cursor === undefined ? {} : { fromCursor: cursor })
    });
    if (started.outcome !== 'success') throw new Error(`start failed: ${started.reason}`);
    expect(started.cursorStatus).toBe('accepted');
    expect(rig.batches, 'the host posts nothing before the view is ready').toHaveLength(0);

    await appendRecords('start-to-ready');
    const ready = await rig.service.ack({ sessionId: started.sessionId, batchSeq: 0 });
    expect(ready.outcome).toBe('success');

    await appendRecords('after-ready');

    const expected = BOUNDARIES.flatMap((boundary) => markersOf(boundary));
    const readTexts = read.manifest.entries.map(textOf).filter((text): text is string => text !== null);
    await waitForTexts(rig, expected, readTexts);

    const counts = countsOf([...readTexts, ...liveTexts(rig)]);
    const shownTwice = expected.filter((marker) => (counts.get(marker) ?? 0) > 1);
    const notShown = expected.filter((marker) => (counts.get(marker) ?? 0) === 0);
    expect(shownTwice, 'no record is shown twice').toEqual([]);
    // SC-001: shown once, or covered by a gap row. This fixture is small enough that
    // nothing should need the gap, so both must hold.
    expect(notShown, 'every record is shown').toEqual([]);
    expect(gapRows(rig), 'nothing was skipped').toBe(0);
    expect(rig.ackFailures).toEqual([]);

    const first = rig.batches.at(0);
    expect(first?.batchSeq).toBe(1);
    expect(first?.mode).toBe('resume');
    const sequence = rig.batches.map((batch) => batch.batchSeq);
    expect(sequence, 'batch numbers increase by one').toEqual(sequence.map((_seq, index) => index + 1));
  });
});

describe('FR-R6-F07 T028 — hide, duplicate delivery and recreation reconcile', () => {
  it('shows the 50 records written while hidden once each, in file order, after the reveal (SC-002)', async () => {
    const rig = await openDashboard();
    await startLive(rig);
    await appendRecords('before-hide');
    await waitForTexts(rig, markersOf('before-hide'));
    await rig.settleAcks();

    rig.setVisible(false);
    await appendRecords('while-hidden', HIDDEN_WRITES);
    rig.setVisible(true);

    const expected = [...markersOf('before-hide'), ...markersOf('while-hidden', HIDDEN_WRITES)];
    await waitForTexts(rig, expected);
    expect(liveTexts(rig), 'every record once, in the order of the file').toEqual(expected);
    expect(gapRows(rig)).toBe(0);
    // The file was empty at the start: one leading gap says so, and nothing else.
    expect(gapItems(rig).map((item) => item.entry.body.reason)).toEqual(['not-yet-produced']);
    expect(rig.ackFailures).toEqual([]);
  });

  it('resends nothing for 100 duplicate acknowledgements of one batch and counts them (SC-004)', async () => {
    const rig = await openDashboard();
    const started = await startLive(rig);
    await appendRecords('first');
    await waitForTexts(rig, markersOf('first'));
    await rig.settleAcks();
    const repeated = rig.batches.at(-1)?.batchSeq ?? 0;
    const duplicateAcks = await Promise.all(
      Array.from({ length: DUPLICATE_ACKS }, () =>
        rig.service.ack({ sessionId: started.sessionId, batchSeq: repeated, duplicate: true })
      )
    );
    expect(duplicateAcks.filter((response) => response.outcome !== 'success')).toEqual([]);

    await appendRecords('after-duplicates');
    const expected = [...markersOf('first'), ...markersOf('after-duplicates')];
    await waitForTexts(rig, expected);
    expect(liveTexts(rig)).toEqual(expected);

    await rig.settleAcks();
    const stopped = await rig.service.stop({ sessionId: started.sessionId });
    expect(stopped.outcome).toBe('success');
    expect(stopped.counters?.duplicateBatches).toBe(DUPLICATE_ACKS);
  });

  it('resumes a recreated view from the last cursor it applied, showing only what came after', async () => {
    const rig = await openDashboard();
    await startLive(rig);
    await appendRecords('first-view');
    await waitForTexts(rig, markersOf('first-view'));
    await rig.settleAcks();
    const persisted = lastCursor(rig);
    expect(persisted, 'the first view applied a cursor').not.toBeNull();

    await rig.recreate();
    await appendRecords('while-recreating');
    const started = await startLive(rig, persisted ?? undefined);
    expect(started.cursorStatus).toBe('accepted');
    await appendRecords('second-view');

    const expected = [...markersOf('while-recreating'), ...markersOf('second-view')];
    await waitForTexts(rig, expected);
    expect(liveTexts(rig), 'nothing from before the cursor, everything after it once').toEqual(expected);
    expect(rig.batches.at(0)?.mode).toBe('resume');
    expect(gapRows(rig)).toBe(0);
    expect(rig.ackFailures).toEqual([]);
  });
});

function gapReasons(rig: DashboardRig): unknown[] {
  return gapItems(rig).map((item) => item.entry.body.reason);
}

/** Swaps one dot-separated field of a cursor (0 version, 1 digest, 2 generation, 3 offset, 4 fingerprint). */
function withField(cursor: string, index: number, value: string): string {
  const fields = cursor.split('.');
  fields[index] = value;
  return fields.join('.');
}

/** Starts live with `fromCursor` and waits until the expected records are shown. */
async function startFrom(rig: DashboardRig, fromCursor: string, expected: readonly string[]) {
  const started = await startLive(rig, fromCursor);
  await waitForTexts(rig, expected);
  return started;
}

describe('FR-R6-F07 T037 — a cursor or a changed source never reads an unintended file (F07-AC-03)', () => {
  async function liveCursor(rig: DashboardRig, boundary: string): Promise<string> {
    await startLive(rig);
    await appendRecords(boundary);
    await waitForTexts(rig, markersOf(boundary));
    await rig.settleAcks();
    const cursor = lastCursor(rig);
    if (cursor === null) throw new Error('the live view applied no cursor');
    await rig.recreate();
    return cursor;
  }

  it('resets on a forged cursor and shows only the selection\'s own records', async () => {
    const rig = await openDashboard();
    const valid = await liveCursor(rig, 'own');
    const forgeries = [
      withField(valid, 4, 'f'.repeat(16)),
      withField(valid, 3, String(Number.MAX_SAFE_INTEGER)),
      '../../../../etc/passwd',
      'plc1....'
    ];
    for (const forged of forgeries) {
      const started = await startFrom(rig, forged, markersOf('own'));
      expect(started.cursorStatus, forged).toBe('reset');
      expect(liveTexts(rig), forged).toEqual(markersOf('own'));
      expect(rig.batches.at(0)?.mode, forged).toBe('reset');
      await rig.recreate();
    }
    expect(rig.ackFailures).toEqual([]);
  });

  it('resets on a cursor from another workspace and never reads that workspace\'s file', async () => {
    const rig = await openDashboard();
    const valid = await liveCursor(rig, 'own');
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'live-log-foreign-'));
    try {
      const foreignPath = resolveStreamJsonlPath({
        workspaceRoot: elsewhere,
        runId: RUN_ID,
        pipelineId: SPECKIT_PIPELINE_ID,
        phaseId: PHASE_ID,
        iterationN: ITERATION
      });
      await fs.mkdir(path.dirname(foreignPath), { recursive: true });
      await fs.writeFile(foreignPath, recordLines('foreign'), 'utf8');
      const foreign = withField(valid, 1, streamDigest(elsewhere, rig.selection));

      const started = await startFrom(rig, foreign, markersOf('own'));
      expect(started.cursorStatus).toBe('reset');
      expect(liveTexts(rig)).toEqual(markersOf('own'));
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('gives an unknown cursor version a bounded reset to the current snapshot', async () => {
    const rig = await openDashboard();
    const valid = await liveCursor(rig, 'own');
    const started = await startFrom(rig, withField(valid, 0, 'plc9'), markersOf('own'));
    expect(started.cursorStatus).toBe('unknown-version');
    expect(liveTexts(rig)).toEqual(markersOf('own'));
    expect(rig.batches.at(0)?.mode).toBe('reset');
  });

  it('shows a truncated source behind one source-replaced gap and reads only what is written after it', async () => {
    const rig = await openDashboard();
    await startLive(rig);
    await appendRecords('before-truncate');
    await waitForTexts(rig, markersOf('before-truncate'));
    await rig.settleAcks();

    await fs.truncate(streamPath(), 0);
    await vi.waitFor(
      () => {
        if (!gapReasons(rig).includes('source-replaced')) throw new Error('no source-replaced gap yet');
      },
      { timeout: DELIVERY_WAIT_MS, interval: 25 }
    );
    await appendRecords('after-truncate');
    const expected = [...markersOf('before-truncate'), ...markersOf('after-truncate')];
    await vi.waitFor(
      () => {
        if (liveTexts(rig).length < expected.length) throw new Error('waiting for the regrown records');
      },
      { timeout: DELIVERY_WAIT_MS, interval: 25 }
    );
    expect(liveTexts(rig)).toEqual(expected);
    expect(gapReasons(rig).filter((reason) => reason === 'source-replaced')).toHaveLength(1);
  });

  it('resets a cursor whose bytes were truncated and regrown while no view was open', async () => {
    const rig = await openDashboard();
    const valid = await liveCursor(rig, 'first-life');
    // Longer than before, so the old offset is inside the file but the bytes before it differ.
    await fs.writeFile(streamPath(), recordLines('second-life', RECORDS_PER_BOUNDARY * 2), 'utf8');
    const expected = markersOf('second-life', RECORDS_PER_BOUNDARY * 2);
    const started = await startFrom(rig, valid, expected);
    expect(started.cursorStatus).toBe('reset');
    expect(liveTexts(rig)).toEqual(expected);
  });

  it('starts a replaced source over behind one source-replaced gap', async () => {
    const rig = await openDashboard();
    const valid = await liveCursor(rig, 'old-file');
    const next = `${streamPath()}.next`;
    await fs.writeFile(next, recordLines('new-file'), 'utf8');
    await fs.rename(next, streamPath());
    const started = await startFrom(rig, valid, markersOf('new-file'));
    expect(started.cursorStatus).toBe('reset');
    expect(liveTexts(rig)).toEqual(markersOf('new-file'));
    expect(gapReasons(rig)).toEqual(['source-replaced']);
  });
});

describe('FR-R6-F07 T037 — selection changes, disposal and following (F07-AC-07)', () => {
  it('holds one watcher through 100 selection changes, and none and no late batch after disposal', async () => {
    const rig = await openDashboard();
    await appendRecords('first-iteration');
    await fs.mkdir(path.dirname(streamPath(LATER_ITERATION)), { recursive: true });
    await appendRecords('later-iteration', RECORDS_PER_BOUNDARY, LATER_ITERATION);
    const baseline = watchProbe.open;
    const sessionIds: string[] = [];

    for (let change = 0; change < SELECTION_CHANGES; change += 1) {
      const iterationN = change % 2 === 0 ? ITERATION : LATER_ITERATION;
      const started = await rig.service.start({ selection: { ...rig.selection, iterationN }, consumer: 'dashboard' });
      if (started.outcome !== 'success') throw new Error(`start ${change} failed: ${started.reason}`);
      expect(started.mechanism).toBe('fs.watch');
      sessionIds.push(started.sessionId);
      expect(watchProbe.open - baseline, `watchers after change ${change}`).toBe(1);
    }

    // A burst that does not wait: only the last start survives.
    const burst = await Promise.all(
      Array.from({ length: CONCURRENT_STARTS }, () =>
        rig.service.start({ selection: rig.selection, consumer: 'dashboard' })
      )
    );
    const survivors = burst.filter((result) => result.outcome === 'success');
    expect(survivors).toHaveLength(1);
    expect(burst.at(-1)?.outcome).toBe('success');
    sessionIds.push(...survivors.map((result) => result.sessionId));
    expect(watchProbe.open - baseline).toBe(1);

    await rig.disposePanel();
    expect(watchProbe.open, 'no watcher outlives the panel').toBe(baseline);
    const lateAcks = await Promise.all(sessionIds.map((sessionId) => rig.service.ack({ sessionId, batchSeq: 1 })));
    expect(lateAcks.every((response) => response.outcome === 'failure')).toBe(true);

    await appendRecords('after-disposal');
    // A fresh panel sees the new records, so any event the old watchers could act on has fired.
    rig.rebind();
    const fresh = await startLive(rig);
    await waitForTexts(rig, markersOf('after-disposal'));
    const stale = new Set(sessionIds);
    expect(rig.batches.filter((batch) => stale.has(batch.tailSessionId)), 'no late batch').toEqual([]);
    expect(watchProbe.open - baseline).toBe(1);
    await rig.service.stop({ sessionId: fresh.sessionId });
    expect(watchProbe.open).toBe(baseline);
  });

  it('follows the latest iteration, and a cursor from an earlier one never moves it back', async () => {
    const rig = await openDashboard();
    await startLive(rig);
    await appendRecords('iteration-one');
    await waitForTexts(rig, markersOf('iteration-one'));
    await rig.settleAcks();
    const earlier = lastCursor(rig);
    if (earlier === null) throw new Error('the first iteration applied no cursor');
    await rig.recreate();

    await fs.mkdir(path.dirname(streamPath(LATER_ITERATION)), { recursive: true });
    await appendRecords('iteration-two', RECORDS_PER_BOUNDARY, LATER_ITERATION);
    const read = await rig.reader.read({ selection: { ...rig.selection, iterationN: null } });
    if (read.outcome !== 'success') throw new Error(`read failed: ${read.reason}`);
    expect(read.manifest.selectedIteration).toBe(LATER_ITERATION);

    const started = await rig.service.start({
      selection: { ...rig.selection, iterationN: LATER_ITERATION },
      consumer: 'dashboard',
      fromCursor: earlier
    });
    if (started.outcome !== 'success') throw new Error(`start failed: ${started.reason}`);
    expect(started.cursorStatus).toBe('reset');
    expect((await rig.service.ack({ sessionId: started.sessionId, batchSeq: 0 })).outcome).toBe('success');
    await waitForTexts(rig, markersOf('iteration-two'));
    expect(liveTexts(rig)).toEqual(markersOf('iteration-two'));
  });

  it('refuses a start before the file exists without opening a watcher, and the retry succeeds once it does', async () => {
    const rig = await openDashboard();
    const pending = { ...rig.selection, iterationN: LATER_ITERATION };
    const baseline = watchProbe.open;
    const refused = await rig.service.start({ selection: pending, consumer: 'dashboard' });
    expect(refused.outcome).toBe('failure');
    expect(watchProbe.open).toBe(baseline);

    await fs.mkdir(path.dirname(streamPath(LATER_ITERATION)), { recursive: true });
    await appendRecords('appeared', RECORDS_PER_BOUNDARY, LATER_ITERATION);
    const retried = await rig.service.start({ selection: pending, consumer: 'dashboard' });
    if (retried.outcome !== 'success') throw new Error(`retry failed: ${retried.reason}`);
    expect((await rig.service.ack({ sessionId: retried.sessionId, batchSeq: 0 })).outcome).toBe('success');
    await waitForTexts(rig, markersOf('appeared'));
    expect(liveTexts(rig)).toEqual(markersOf('appeared'));
  });
});
