// Feature 020 T042 — PhaseLogTailRegistry: cap-of-1 enforcement,
// disposeAll idempotency, and the in-flight-task subscription that
// auto-disposes the session when the owning task leaves `in-flight`.
//
// FR-R6-F07 (T017) — consumer slots, the ready ack, batch envelopes and the
// start response's cursors.
//
// The registry's actual file I/O is exercised by the session test
// (T041). This test focuses on lifecycle wiring — start/stop/replace
// semantics, audit-event emission, and the subscription teardown
// invariant.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  PhaseLogTailRegistry,
  type PhaseLogTailSink
} from '../../../../src/services/phase-log/phase-log-tail-registry';
import { PhaseLogTailSession } from '../../../../src/services/phase-log/phase-log-tail-session';
import type { PhaseLogBatchPushMessage } from '../../../../src/contracts/sidebar-ipc';
import type { PhaseLogSelection } from '../../../../src/services/phase-log/types';

let tmpDir: string;
const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);
const INIT_LINE = '{"type":"system","subtype":"init"}\n';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-registry-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function streamPath(runId: string): string {
  return path.join(
    tmpDir,
    '.schegent',
    'sessions',
    runId,
    'diagnostics',
    'pipe-1',
    'phase-1',
    'iter-1',
    'stream.jsonl'
  );
}

async function writeStream(runId: string, content: string): Promise<void> {
  const p = streamPath(runId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

function makeSelection(runId: string): PhaseLogSelection {
  return {
    queueId: 'q1',
    taskId: runId,
    pipelineId: 'pipe-1',
    phaseId: 'phase-1',
    iterationN: 1
  };
}

interface CapturedEntry {
  readonly tailSessionId: string;
  readonly kind: string;
  readonly body: Readonly<Record<string, unknown>>;
}

interface RegistryHarness {
  readonly batches: PhaseLogBatchPushMessage[];
  readonly sidebarBatches: PhaseLogBatchPushMessage[];
  readonly audits: Array<{ readonly type: string; readonly payload: unknown }>;
  readonly fireTaskLeftInFlight: (runId: string) => void;
  readonly registry: PhaseLogTailRegistry;
}

function capturingSink(into: PhaseLogBatchPushMessage[]): PhaseLogTailSink {
  return (msg) => {
    into.push(msg);
    return true;
  };
}

function makeHarness(options: { readonly bindSidebar?: boolean } = {}): RegistryHarness {
  const batches: PhaseLogBatchPushMessage[] = [];
  const sidebarBatches: PhaseLogBatchPushMessage[] = [];
  const audits: Array<{ readonly type: string; readonly payload: unknown }> = [];
  let onTaskCb: ((runId: string) => void) | null = null;
  const registry = new PhaseLogTailRegistry({
    sanitize,
    appendAudit: async (event) => {
      audits.push({ type: event.type, payload: event.payload });
    },
    onTaskNoLongerInFlight: (cb) => {
      onTaskCb = cb;
      return { dispose: () => { onTaskCb = null; } };
    },
    caps: { perFieldBytes: 4096 }
  });
  registry.bindSink('dashboard', capturingSink(batches));
  if (options.bindSidebar === true) registry.bindSink('sidebar', capturingSink(sidebarBatches));
  return {
    batches,
    sidebarBatches,
    audits,
    fireTaskLeftInFlight: (runId) => onTaskCb?.(runId),
    registry
  };
}

function entriesOf(batches: readonly PhaseLogBatchPushMessage[]): CapturedEntry[] {
  return batches.flatMap((batch) =>
    batch.payload.entries.map((item) => ({
      tailSessionId: batch.payload.tailSessionId,
      kind: item.entry.kind,
      body: item.entry.body
    }))
  );
}

function tailEndedOf(
  batches: readonly PhaseLogBatchPushMessage[],
  sessionId: string
): CapturedEntry | undefined {
  return entriesOf(batches).find((e) => e.tailSessionId === sessionId && e.kind === 'tail-ended');
}

async function startReady(
  h: RegistryHarness,
  runId: string,
  consumer?: string
): Promise<string> {
  const result = await h.registry.start({
    workspaceRoot: tmpDir,
    selection: makeSelection(runId),
    ...(consumer === undefined ? {} : { consumer })
  });
  if (result.outcome !== 'success') throw new Error(`start failed: ${result.reason}`);
  expect(h.registry.ack(result.sessionId, { batchSeq: 0 }).outcome).toBe('success');
  return result.sessionId;
}

describe('Feature 020 T042 — PhaseLogTailRegistry lifecycle', () => {
  it('start: returns success with a session id and mechanism', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(typeof result.sessionId).toBe('string');
      expect(['fs.watch', 'polling']).toContain(result.mechanism);
    }
    await h.registry.disposeAll('webview-dispose');
  });

  it('start: a second concurrent start disposes the first session', async () => {
    await writeStream('run-1', INIT_LINE);
    await writeStream('run-2', INIT_LINE);
    const h = makeHarness();
    const sessionIdA = await startReady(h, 'run-1');
    const b = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-2')
    });
    expect(b.outcome).toBe('success');
    // The first session must have emitted a `tail-ended` entry with
    // reason 'webview-stop'.
    const tailEnded = tailEndedOf(h.batches, sessionIdA);
    expect(tailEnded).toBeDefined();
    expect(tailEnded?.body.reason).toBe('webview-stop');
    await h.registry.disposeAll('webview-dispose');
  });

  it('start: emits a `phase-log-tail-started` audit event on success', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    const started = h.audits.find((a) => a.type === 'phase-log-tail-started');
    expect(started).toBeDefined();
    await h.registry.disposeAll('webview-dispose');
  });

  it('stop: disposes the session and returns success with its counters', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const sessionId = await startReady(h, 'run-1');
    const stop = await h.registry.stop(sessionId, 'webview-stop');
    expect(stop.outcome).toBe('success');
    expect(stop.counters).toEqual({
      omittedBytes: 0,
      omittedRecords: 0,
      duplicateBatches: 0,
      replayAttempts: 0,
      deliveryGaps: 0,
      sourceResets: 0
    });
    expect(tailEndedOf(h.batches, sessionId)?.body.reason).toBe('webview-stop');
    await h.registry.disposeAll('webview-dispose');
  });

  it('stop: unknown sessionId returns failure with reason unknown-session', async () => {
    const h = makeHarness();
    const stop = await h.registry.stop('nope', 'webview-stop');
    expect(stop.outcome).toBe('failure');
    expect(stop.reason).toBe('unknown-session');
  });

  it('stop: emits a `phase-log-tail-stopped` audit event carrying only counts', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const sessionId = await startReady(h, 'run-1');
    h.registry.ack(sessionId, { batchSeq: 0, duplicate: true });
    await h.registry.stop(sessionId, 'webview-stop');
    const stopped = h.audits.find((a) => a.type === 'phase-log-tail-stopped');
    expect(stopped).toBeDefined();
    const counters = (stopped?.payload as { counters?: Record<string, unknown> }).counters;
    expect(counters?.duplicateBatches).toBe(1);
    for (const value of Object.values(counters ?? {})) expect(Number.isInteger(value)).toBe(true);
  });

  it('disposeAll is idempotent (no error on second call)', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    await h.registry.disposeAll('webview-dispose');
    // Second call must not throw or emit duplicate audits.
    await expect(
      h.registry.disposeAll('webview-dispose')
    ).resolves.toBeUndefined();
  });

  it('onTaskNoLongerInFlight: disposes the matching session by runId', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const sessionId = await startReady(h, 'run-1');
    h.fireTaskLeftInFlight('run-1');
    // Allow microtasks for the async dispose.
    await new Promise((r) => setTimeout(r, 0));
    const tailEnded = tailEndedOf(h.batches, sessionId);
    expect(tailEnded).toBeDefined();
    expect(tailEnded?.body.reason).toBe('phase-complete');
    await h.registry.disposeAll('webview-dispose');
  });

  it('onTaskNoLongerInFlight: leaves unrelated sessions alone', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    await startReady(h, 'run-1');
    h.fireTaskLeftInFlight('run-OTHER');
    await new Promise((r) => setTimeout(r, 0));
    expect(entriesOf(h.batches).find((e) => e.kind === 'tail-ended')).toBeUndefined();
    await h.registry.disposeAll('webview-dispose');
  });

  it('cap-of-1: only one tail session is active per slot at a time', async () => {
    await writeStream('run-1', INIT_LINE);
    await writeStream('run-2', INIT_LINE);
    await writeStream('run-3', INIT_LINE);
    const h = makeHarness();
    await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-1') });
    await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-2') });
    await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-3') });
    expect(h.registry.activeSessionCount).toBe(1);
    await h.registry.disposeAll('webview-dispose');
    expect(h.registry.activeSessionCount).toBe(0);
  });

  it('disposeAll tears down the in-flight subscription', () => {
    const disposeFn = vi.fn();
    const registry = new PhaseLogTailRegistry({
      sanitize,
      appendAudit: async () => {},
      onTaskNoLongerInFlight: () => ({ dispose: disposeFn }),
      caps: { perFieldBytes: 4096 }
    });
    void registry.disposeAll('webview-dispose');
    expect(disposeFn).toHaveBeenCalled();
  });

  it('releaseConsumer: stops only a tail owned by the matching consumer and emits webview-dispose (FR-R5-F10)', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const sessionId = await startReady(h, 'run-1', 'dashboard');

    // Releasing a different consumer leaves the dashboard tail active
    const ignored = await h.registry.releaseConsumer('other-panel', 'webview-dispose');
    expect(ignored).toBe(false);
    expect(h.registry.activeSessionCount).toBe(1);

    // Releasing 'dashboard' disposes the tail and emits phase-log-tail-stopped with webview-dispose
    const released = await h.registry.releaseConsumer('dashboard', 'webview-dispose');
    expect(released).toBe(true);
    expect(h.registry.activeSessionCount).toBe(0);
    expect(tailEndedOf(h.batches, sessionId)?.body.reason).toBe('webview-dispose');
    const stoppedAudit = h.audits.find(
      (a) =>
        a.type === 'phase-log-tail-stopped' &&
        (a.payload as { reason?: string }).reason === 'webview-dispose'
    );
    expect(stoppedAudit).toBeDefined();
    await h.registry.disposeAll('webview-dispose');
  });

  it('releaseConsumer: aborts an in-flight start when the owning panel disposes mid-start (FR-R5-F10)', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const startPromise = h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1'),
      consumer: 'dashboard'
    });
    const released = await h.registry.releaseConsumer('dashboard', 'webview-dispose');
    const startResult = await startPromise;
    expect(released).toBe(true);
    expect(startResult.outcome).toBe('failure');
    expect(h.registry.activeSessionCount).toBe(0);
    expect(h.audits.find((a) => a.type === 'phase-log-tail-started')).toBeUndefined();
    await h.registry.disposeAll('webview-dispose');
  });
});

describe('FR-R6-F07 (T017) — slots, the ready ack and batch envelopes', () => {
  it('start returns the snapshot cutoff, the next cursor and the cursor status', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-1') });
    if (result.outcome !== 'success') throw new Error('start failed');
    expect(result.snapshotCutoff.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBe(result.snapshotCutoff);
    expect(result.cursorStatus).toBe('none');
    await h.registry.disposeAll('webview-dispose');
  });

  it('a malformed fromCursor is reported, not trusted', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1'),
      fromCursor: 'not-a-cursor'
    });
    if (result.outcome !== 'success') throw new Error('start failed');
    expect(['reset', 'unknown-version']).toContain(result.cursorStatus);
    await h.registry.disposeAll('webview-dispose');
  });

  it('posts nothing before the ready ack, then posts batch envelopes', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-1') });
    if (result.outcome !== 'success') throw new Error('start failed');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.batches).toHaveLength(0);
    expect(h.registry.ack(result.sessionId, { batchSeq: 0 })).toEqual({
      outcome: 'success',
      sessionId: result.sessionId
    });
    await vi.waitFor(() => expect(h.batches.length).toBeGreaterThan(0));
    const first = h.batches.at(0);
    expect(first?.type).toBe('MSG_PHASE_LOG_BATCH');
    expect(first?.payload.protocol).toBe(1);
    expect(first?.payload.tailSessionId).toBe(result.sessionId);
    expect(first?.payload.batchSeq).toBe(1);
    expect(entriesOf(h.batches).map((e) => e.kind)).toContain('system');
    await h.registry.disposeAll('webview-dispose');
  });

  it('an ack for an unknown session fails with unknown-session', () => {
    const h = makeHarness();
    expect(h.registry.ack('nope', { batchSeq: 0 })).toEqual({
      outcome: 'failure',
      sessionId: 'nope',
      reason: 'unknown-session'
    });
  });

  it('a consumer name other than the two slots is busy', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1'),
      consumer: 'third-panel'
    });
    expect(result).toEqual({ outcome: 'failure', reason: 'busy' });
    expect(h.registry.activeSessionCount).toBe(0);
  });

  it('a slot with no sink is consumer-unavailable', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    const result = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1'),
      consumer: 'sidebar'
    });
    expect(result).toEqual({ outcome: 'failure', reason: 'consumer-unavailable' });
  });

  it('a start supersedes only its own slot', async () => {
    await writeStream('run-1', INIT_LINE);
    await writeStream('run-2', INIT_LINE);
    await writeStream('run-3', INIT_LINE);
    const h = makeHarness({ bindSidebar: true });
    const dashboardId = await startReady(h, 'run-1', 'dashboard');
    const sidebarId = await startReady(h, 'run-2', 'sidebar');
    expect(h.registry.activeSessionCount).toBe(2);
    const replacement = await startReady(h, 'run-3', 'sidebar');
    expect(h.registry.activeSessionCount).toBe(2);
    expect(tailEndedOf(h.sidebarBatches, sidebarId)?.body.reason).toBe('webview-stop');
    expect(tailEndedOf(h.batches, dashboardId)).toBeUndefined();
    expect(h.registry.ack(dashboardId, { batchSeq: 0 }).outcome).toBe('success');
    expect(h.registry.ack(sidebarId, { batchSeq: 0 }).outcome).toBe('failure');
    expect(h.registry.ack(replacement, { batchSeq: 0 }).outcome).toBe('success');
    await h.registry.disposeAll('webview-dispose');
  });

  it('a hidden slot posts nothing until it is revealed', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    h.registry.setConsumerVisible('dashboard', false);
    await startReady(h, 'run-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.batches).toHaveLength(0);
    h.registry.setConsumerVisible('dashboard', true);
    await vi.waitFor(() => expect(h.batches.length).toBeGreaterThan(0));
    await h.registry.disposeAll('webview-dispose');
  });

  it('keeps a slot hidden during its in-flight start hidden once the start lands', async () => {
    await writeStream('run-1', INIT_LINE);
    const h = makeHarness();
    // The slot is hidden after the session is built and before its start resolves.
    const realStart = PhaseLogTailSession.prototype.start;
    const spy = vi
      .spyOn(PhaseLogTailSession.prototype, 'start')
      .mockImplementation(async function (this: PhaseLogTailSession, fromCursor?: string) {
        h.registry.setConsumerVisible('dashboard', false);
        return realStart.call(this, fromCursor);
      });
    const result = await h.registry.start({ workspaceRoot: tmpDir, selection: makeSelection('run-1') });
    spy.mockRestore();
    if (result.outcome !== 'success') throw new Error(`start failed: ${result.reason}`);
    expect(h.registry.ack(result.sessionId, { batchSeq: 0 }).outcome).toBe('success');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.batches).toHaveLength(0);
    h.registry.setConsumerVisible('dashboard', true);
    await vi.waitFor(() => expect(h.batches.length).toBeGreaterThan(0));
    await h.registry.disposeAll('webview-dispose');
  });
});
