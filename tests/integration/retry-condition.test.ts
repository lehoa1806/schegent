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
import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../src/config/pipeline-config';
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

function makeStubRunner(scripts: Array<() => RawInvocationOutput>): {
  runner: ClaudeCliRunner;
  invokeCount: { value: number };
} {
  const invokeCount = { value: 0 };
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => {
    const idx = invokeCount.value;
    invokeCount.value += 1;
    const fn = scripts[idx] ?? scripts[scripts.length - 1];
    return fn();
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, invokeCount };
}

function makeRaw(stdout: string, exitCode = 0): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdout);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();

  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

function block(phase: string, body: readonly string[]): string {
  return [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["audit"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    ...body,
    '=== END AUDIT LOG ==='
  ].join('\n');
}

function clearWithMetrics(phase: string, metricLines: string[]): string {
  return `[SCHEGENT_STATUS: CLEAR]\n${block(phase, metricLines)}`;
}

const SECURITY_AUDIT_PHASE: PhaseDef = {
  id: 'security-audit',
  name: 'Security Audit',
  instruction: 'Audit the project for security issues.',
  
  retryCondition: 'open_questions > 0'
};

const DONE_PHASE: PhaseDef = {
  id: 'done',
  name: 'Done',
  instruction: '(no-op)',
  
};

const SECURITY_PIPELINE: PipelineDef = {
  id: 'security',
  name: 'Security Audit Pipeline',
  phases: ['security-audit', 'done']
};

function makeCustomCatalog() {
  return buildCatalog([SECURITY_AUDIT_PHASE, DONE_PHASE], [SECURITY_PIPELINE], { claude: [], codex: [], agy: [] }, 'security');
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-retry-condition-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readAuditLog(workspaceRoot: string): Promise<Array<Record<string, any>>> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return log.trim().split('\n').map((l) => JSON.parse(l));
}

async function makeController(
  scripts: Array<() => RawInvocationOutput>,
  iterationCap = 5
): Promise<{
  controller: SchegentWorkflowController;
  queue: QueueManager;
  store: WorkspaceStateStore;
  invokeCount: { value: number };
}> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const { runner, invokeCount } = makeStubRunner(scripts);
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const { lock } = makeLock();

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: tmpRoot, iterationCap, timeoutMs: 1000 },
    { catalog: makeCustomCatalog() }
  );
  return { controller, queue, store, invokeCount };
}

describe('Retry-condition end-to-end (010, T025, US2)', () => {
  it('loops while the expression is truthy and advances when it goes falsy (SC-003)', async () => {
    // Script: iter 1 → open_questions=2 (loop), iter 2 → open_questions=1 (loop),
    // iter 3 → open_questions=0 (advance to done).
    const scripts = [
      () => makeRaw(clearWithMetrics('security-audit', ['open_questions: 2'])),
      () => makeRaw(clearWithMetrics('security-audit', ['open_questions: 1'])),
      () => makeRaw(clearWithMetrics('security-audit', ['open_questions: 0']))
    ];
    const { controller, queue, store, invokeCount } = await makeController(scripts);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    expect(invokeCount.value).toBe(3);
    const run = store.getRun()!;
    expect(run.status).toBe('completed');

    // SC-004 — every consulted decision is recorded.
    const lines = await readAuditLog(tmpRoot);
    const retryEvts = lines.filter((l) => l.eventType === 'phase.retry_evaluated');
    expect(retryEvts).toHaveLength(3);
    expect(retryEvts[0].payload.metrics).toEqual({ open_questions: 2 });
    expect(retryEvts[0].payload.decision).toBe(true);
    expect(retryEvts[1].payload.metrics).toEqual({ open_questions: 1 });
    expect(retryEvts[1].payload.decision).toBe(true);
    expect(retryEvts[2].payload.metrics).toEqual({ open_questions: 0 });
    expect(retryEvts[2].payload.decision).toBe(false);
    for (const evt of retryEvts) {
      expect(evt.outcome).toBe('info');
      expect(evt.payload).not.toHaveProperty('expression');
      expect(evt.payload.pipelineId).toBe('security');
      expect(evt.payload.phaseId).toBe('security-audit');
    }
  });

  it('advances with missingKeys recorded when the metric is absent (FR-012)', async () => {
    // No metric line at all → identifier resolves to 0 → expression falsy → advance.
    const scripts = [() => makeRaw(clearWithMetrics('security-audit', []))];
    const { controller, queue, store, invokeCount } = await makeController(scripts);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    expect(invokeCount.value).toBe(1);
    const run = store.getRun()!;
    expect(run.status).toBe('completed');

    const lines = await readAuditLog(tmpRoot);
    const retryEvts = lines.filter((l) => l.eventType === 'phase.retry_evaluated');
    expect(retryEvts).toHaveLength(1);
    expect(retryEvts[0].payload.decision).toBe(false);
    expect(retryEvts[0].payload.missingKeys).toContain('open_questions');
  });

  it('terminates with cause: cap_exhausted when truthy at cap (SC-009)', async () => {
    // Every iteration: open_questions stays at 1 → never goes falsy.
    // With iterationCap=2, expect 2 invocations then a halt(failed, cap_exhausted).
    const scripts = [
      () => makeRaw(clearWithMetrics('security-audit', ['open_questions: 1'])),
      () => makeRaw(clearWithMetrics('security-audit', ['open_questions: 1']))
    ];
    const { controller, queue, store, invokeCount } = await makeController(scripts, 2);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    expect(invokeCount.value).toBe(2);
    const run = store.getRun()!;
    expect(run.status).toBe('failed');
    expect(run.lastError?.message).toBe('cap_exhausted');

    const lines = await readAuditLog(tmpRoot);
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    const lastEnd = ends[ends.length - 1];
    expect(lastEnd.outcome).toBe('failure');
    expect(lastEnd.payload.terminationReason).toBe('cap-exhausted');
    expect(lastEnd.payload).not.toHaveProperty('cause');
  });
});
