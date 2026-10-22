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
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';

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

// FR-R3-199 — the token trails the audit block: since feature 107 the parser
// reads it nowhere else. Printed before the block, it left every phase this
// fixture ran `issues_remain`, unseen because the retryCondition transitions on
// its metric before the outcome is consulted.
function clearWithMetrics(phase: string, metricLines: string[]): string {
  return `${block(phase, metricLines)}\n[SCHEGENT_STATUS: CLEAR]`;
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
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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

    // FR-R3-199 — each iteration ends on the fake's token, not on remaining
    // issues. A retryCondition decides the transition whatever the outcome, so
    // nothing above would notice the token going unread.
    const phaseEnds = lines.filter((l) => l.eventType === 'phase-end');
    expect(phaseEnds.map((l) => l.payload.terminationReason)).toEqual(['token', 'token', 'token']);
  });

  it('advances with missingKeys recorded when the metric is absent (FR-012)', async () => {
    // No metric line at all → identifier resolves to 0 → expression falsy → advance.
    const scripts = [() => makeRaw(clearWithMetrics('security-audit', []))];
    const { controller, queue, store, invokeCount } = await makeController(scripts);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    expect(invokeCount.value).toBe(1);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('failed');
    expect(run.lastError?.message).toBe('cap_exhausted');

    const lines = await readAuditLog(tmpRoot);
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    // `.at(-1)` plus a throw, not `ends[ends.length - 1]`: an empty `ends` would
    // otherwise make `.not.toHaveProperty('cause')` below pass on `undefined` — a
    // green assertion about an event nobody wrote. `at` is the read whose type
    // says the miss is possible (FR-R3-110's noUncheckedIndexedAccess ratchet).
    const lastEnd = ends.at(-1);
    if (lastEnd === undefined) throw new Error('no phase-end event was written');
    expect(lastEnd.outcome).toBe('failure');
    expect(lastEnd.payload.terminationReason).toBe('cap-exhausted');
    expect(
      lastEnd.payload.cause,
      'contracts/audit-events.md §"phase-end — new payload.cause field" enumerates ' +
        '"cap_exhausted" for this path (see also specs/194-cap-exhausted-cause-stagnation/' +
        'contracts/audit-payload-deltas.md Delta 1, rule C1.1); the emitter must write it'
    ).toBe('cap_exhausted');
  });

  it('carries no cause on a phase failure that is not a cap exhaustion (FR-003, SC-003)', async () => {
    // A timed-out invocation: a distinct failure class from cap exhaustion, with no
    // fatal signature and therefore no cause value to begin with. Positive control for
    // Delta 1 rule C1.3: cause is absent on this path, so the two failure classes stay
    // distinguishable.
    const scripts = [
      () => {
        const raw = makeRaw('', 0);
        return { ...raw, timedOut: true };
      }
    ];
    const { controller, queue, store, invokeCount } = await makeController(scripts, 2);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    expect(invokeCount.value).toBe(1);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('failed');

    const lines = await readAuditLog(tmpRoot);
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    const lastEnd = ends.at(-1);
    if (lastEnd === undefined) throw new Error('no phase-end event was written');
    expect(lastEnd.outcome).toBe('failure');
    expect(
      lastEnd.payload,
      'Delta 1 rule C1.3: a phase failure that is not a cap exhaustion carries no cause'
    ).not.toHaveProperty('cause');
  });

  it('drops the cause a fatal-signature failure DOES emit, rather than never writing one (C1.3, FR-005)', async () => {
    // The control above is a TIMEOUT, and a timed-out invocation never had a
    // `cause` to lose — so on its own it proved only that a path with no cause
    // records none, which an emitter that had never learned to write `cause` at
    // all would satisfy (2026-09-04 review). This is the failure class that DOES
    // write one: `phase-runner.ts` puts the redacted fatal signature on the raw
    // payload as `cause`, and `projectPhaseEnd()` narrows the field to the single
    // literal `cap_exhausted` on the way to disk. Absence here therefore means
    // the narrowing fired, which is the claim C1.3 actually makes — and FR-005's
    // too, since the value dropped is redacted CLI text.
    const scripts = [() => makeRaw('Autocompact is thrashing\n', 1)];
    const { controller, queue, store, invokeCount } = await makeController(scripts, 2);

    const feature = await queue.enqueue('Audit thing', { pipelineId: 'security' });
    await controller.startNew(feature, 'specs/001-mock', { pipelineId: 'security' });

    // One invocation: a fatal signature halts the run regardless of the cap.
    expect(invokeCount.value).toBe(1);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('failed');

    const lines = await readAuditLog(tmpRoot);
    // The witness that keeps the absence below meaningful: `phase-runner.ts`
    // emits `fatal-signature-matched` from the same `fatalCause` it then puts on
    // the phase-end payload, so this event's presence is proof a `cause` was
    // written and dropped, not that the path produced none.
    expect(lines.map((l) => l.eventType)).toContain('fatal-signature-matched');

    const lastEnd = lines.filter((l) => l.eventType === 'phase-end').at(-1);
    if (lastEnd === undefined) throw new Error('no phase-end event was written');
    expect(lastEnd.outcome).toBe('failure');
    expect(lastEnd.payload).not.toHaveProperty('cause');
    // ...and the text itself is nowhere in the log, under any key. A projection
    // that moved it to a different field would pass the assertion above.
    expect(JSON.stringify(lines)).not.toContain('Autocompact is thrashing');
  });
});
