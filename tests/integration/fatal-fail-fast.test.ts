import { ZippedStreamBuffer } from "../../src/runner/zipped-stream-buffer";

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';

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

const FATAL_TEXT = "error: unknown option";

function makeFatalCliRunner(): {
  runner: ClaudeCliRunner;
  invokeCount: { value: number };
} {
  const invokeCount = { value: 0 };
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => {
    invokeCount.value += 1;
    return {
      stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(''); b.finalize(); return b; })(),
      stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(`error: ${FATAL_TEXT}\n`); b.finalize(); return b; })(),
      exitCode: 1,
      killed: false,
      timedOut: false,
      durationMs: 1
    };
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, invokeCount };
}

function makeLock(): { lock: WorkspaceLockManager; releaseSpy: ReturnType<typeof vi.fn> } {
  const releaseSpy = vi.fn();
  releaseSpy.mockResolvedValue(undefined);
  const lock = {
    release: releaseSpy,
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
  return { lock, releaseSpy };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-fatal-fail-fast-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Fatal fail-fast end-to-end (010, T013, US1)', () => {
  it('terminates the run on the first invocation when a fatal signature appears (SC-001, SC-002)', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const { runner, invokeCount } = makeFatalCliRunner();
    const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
    const { lock, releaseSpy } = makeLock();

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      lock,
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 }
    );

    const feature = await queue.enqueue('Add login');
    await controller.startNew(feature, null);

    const run = store.getRun()!;

    // (a) iteration count = 1 — only one CLI invocation happened (SC-002).
    expect(invokeCount.value).toBe(1);

    // (b) Run terminated in a failed state.
    expect(run.status).toBe('failed');

    // (c) sidebar lastError.message contains the redacted fatal text.
    expect(run.lastError?.message).toContain(FATAL_TEXT);

    // (d) Workspace lock released (lockReleased path executed).
    expect(releaseSpy).toHaveBeenCalled();

    // (e) Audit log has exactly one phase-start and one phase-end for the
    // failing phase, and the phase-end carries payload.cause = redacted text.
    const log = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.eventType === 'phase-start');
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome).toBe('failure');
    expect(ends[0].payload.cause).toBe(FATAL_TEXT);
  });
});
