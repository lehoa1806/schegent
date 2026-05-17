// Feature 020 T042 — PhaseLogTailRegistry: cap-of-1 enforcement,
// disposeAll idempotency, and the in-flight-task subscription that
// auto-disposes the session when the owning task leaves `in-flight`.
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
import { PhaseLogTailRegistry } from '../../../../src/services/phase-log/phase-log-tail-registry';
import type {
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from '../../../../src/services/phase-log/types';

let tmpDir: string;
const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);

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

interface CapturedPush {
  readonly tailSessionId: string;
  readonly entrySeq: number;
  readonly entry: PhaseLogDisplayEntry;
}

interface RegistryHarness {
  readonly pushes: CapturedPush[];
  readonly audits: Array<{ readonly type: string; readonly payload: unknown }>;
  readonly fireTaskLeftInFlight: (runId: string) => void;
  readonly registry: PhaseLogTailRegistry;
}

function makeHarness(): RegistryHarness {
  const pushes: CapturedPush[] = [];
  const audits: Array<{ readonly type: string; readonly payload: unknown }> = [];
  let onTaskCb: ((runId: string) => void) | null = null;
  const registry = new PhaseLogTailRegistry({
    pushToWebview: (msg) => {
      pushes.push(msg.payload as CapturedPush);
    },
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
  return {
    pushes,
    audits,
    fireTaskLeftInFlight: (runId) => onTaskCb?.(runId),
    registry
  };
}

describe('Feature 020 T042 — PhaseLogTailRegistry lifecycle', () => {
  it('start: returns success with a session id and mechanism', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
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
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    await writeStream('run-2', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    const a = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    expect(a.outcome).toBe('success');
    const sessionIdA = a.outcome === 'success' ? a.sessionId : '';
    const b = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-2')
    });
    expect(b.outcome).toBe('success');
    // The first session must have emitted a `tail-ended` push with
    // reason 'webview-stop'.
    const tailEnded = h.pushes.find(
      (p) => p.tailSessionId === sessionIdA && p.entry.kind === 'tail-ended'
    );
    expect(tailEnded).toBeDefined();
    expect(tailEnded?.entry.body.reason).toBe('webview-stop');
    await h.registry.disposeAll('webview-dispose');
  });

  it('start: emits a `phase-log-tail-started` audit event on success', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    const started = h.audits.find((a) => a.type === 'phase-log-tail-started');
    expect(started).toBeDefined();
    await h.registry.disposeAll('webview-dispose');
  });

  it('stop: disposes the session and returns success', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    const start = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    if (start.outcome !== 'success') throw new Error('start failed');
    const stop = await h.registry.stop(start.sessionId, 'webview-stop');
    expect(stop.outcome).toBe('success');
    const tailEnded = h.pushes.find((p) => p.entry.kind === 'tail-ended');
    expect(tailEnded?.entry.body.reason).toBe('webview-stop');
    await h.registry.disposeAll('webview-dispose');
  });

  it('stop: unknown sessionId returns failure with reason unknown-session', async () => {
    const h = makeHarness();
    const stop = await h.registry.stop('nope', 'webview-stop');
    expect(stop.outcome).toBe('failure');
    expect(stop.reason).toBe('unknown-session');
  });

  it('stop: emits a `phase-log-tail-stopped` audit event', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    const start = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    if (start.outcome !== 'success') throw new Error('start failed');
    await h.registry.stop(start.sessionId, 'webview-stop');
    const stopped = h.audits.find((a) => a.type === 'phase-log-tail-stopped');
    expect(stopped).toBeDefined();
  });

  it('disposeAll is idempotent (no error on second call)', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
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
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    const start = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    if (start.outcome !== 'success') throw new Error('start failed');
    h.fireTaskLeftInFlight('run-1');
    // Allow microtasks for the async dispose.
    await new Promise((r) => setTimeout(r, 0));
    const tailEnded = h.pushes.find(
      (p) => p.tailSessionId === start.sessionId && p.entry.kind === 'tail-ended'
    );
    expect(tailEnded).toBeDefined();
    expect(tailEnded?.entry.body.reason).toBe('phase-complete');
    await h.registry.disposeAll('webview-dispose');
  });

  it('onTaskNoLongerInFlight: leaves unrelated sessions alone', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    const h = makeHarness();
    const start = await h.registry.start({
      workspaceRoot: tmpDir,
      selection: makeSelection('run-1')
    });
    if (start.outcome !== 'success') throw new Error('start failed');
    h.fireTaskLeftInFlight('run-OTHER');
    await new Promise((r) => setTimeout(r, 0));
    const tailEnded = h.pushes.find((p) => p.entry.kind === 'tail-ended');
    expect(tailEnded).toBeUndefined();
    await h.registry.disposeAll('webview-dispose');
  });

  it('cap-of-1: only one tail session is active at a time', async () => {
    await writeStream('run-1', '{"type":"system","subtype":"init"}\n');
    await writeStream('run-2', '{"type":"system","subtype":"init"}\n');
    await writeStream('run-3', '{"type":"system","subtype":"init"}\n');
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
      pushToWebview: () => {},
      sanitize,
      appendAudit: async () => {},
      onTaskNoLongerInFlight: () => ({ dispose: disposeFn }),
      caps: { perFieldBytes: 4096 }
    });
    void registry.disposeAll('webview-dispose');
    expect(disposeFn).toHaveBeenCalled();
  });
});
