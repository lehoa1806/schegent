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
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';

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

const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
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
}

describe('Task Lifecycle Events Integration (072 T025)', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let auditLogPath: string;
  let memento: FakeMemento;
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let auditWriter: AuditLogWriter;
  let controller: SchegentWorkflowController;
  let mockRunner: ClaudeCliRunner;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-lifecycle-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    auditLogPath = path.join(workspaceRoot, '.schegent', 'audit.log');

    memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    queue = new QueueManager(store);

    auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger());
    queue.setLifecycleAuditHook(auditWriter as unknown as any);

    mockRunner = {
      invoke: vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
        return {
          stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(cleanStdout(req.phase)); b.finalize(); return b; })(),
          stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
          exitCode: 0,
          killed: false,
          timedOut: false,
          durationMs: 1
        };
      })
    } as unknown as ClaudeCliRunner;

    const logger = new SanitizedLogger();
    const phaseBreakpointAccessor = createPhaseBreakpointAccessor(() => store.getRun());
    
    const phaseRunner = new PhaseRunner(
      mockRunner,
      new PromptBuilder(),
      auditWriter,
      logger,
      null, null, null, null, null,
      phaseBreakpointAccessor
    );

    controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
      logger,
      makeLock(),
      { cliPath: 'mock', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 10_000, perPhaseRulesEnabled: false },
      { auditWriter }
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('Full startNew → completed run emits exact task lifecycle events with ordered invariants', async () => {
    // 1. Enqueue task
    const task = await queue.enqueue('lifecycle test feature');
    
    // 2. Start the run
    await controller.startNew(task, null, { pipelineId: 'speckit-new-feature' });

    // Wait for the pipeline to finish and the ended event to be logged
    let content = '';
    await new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        try {
          content = await fs.readFile(auditLogPath, 'utf8');
          if (content.includes('task-execution-ended')) {
            clearInterval(interval);
            resolve();
          }
        } catch (e) {
          // file might not exist yet
        }
      }, 50);
    });

    const finalRun = store.getRun()!;
    expect(finalRun.status).toBe('completed');
    expect(finalRun.pipeline).toBeDefined();

    const expectedPhaseCount = finalRun.pipeline!.phases.length;

    // 3. Read audit log
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const events = lines.map((l) => JSON.parse(l));

    // 4. Assert exactly one task-execution-started
    const startedEvents = events.filter((e) => e.eventType === 'task-execution-started');
    if (startedEvents.length !== 1) {
      console.log('AUDIT EVENTS:', JSON.stringify(events, null, 2));
    }
    expect(startedEvents.length).toBe(1);
    const startedEvent = startedEvents[0];
    
    // 5. Assert exactly one task-execution-ended { terminalStatus: 'completed' }
    const endedEvents = events.filter((e) => e.eventType === 'task-execution-ended');
    expect(endedEvents.length).toBe(1);
    const endedEvent = endedEvents[0];
    expect(endedEvent.payload.terminalStatus).toBe('completed');
    expect(endedEvent.payload.phasesTotal).toBe(expectedPhaseCount);
    
    // Assert event ordering: started before ended
    const startedIndex = events.indexOf(startedEvent);
    const endedIndex = events.indexOf(endedEvent);
    expect(startedIndex).toBeLessThan(endedIndex);
  });
});
