import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
// Feature 098 (T080) — the controller no longer carries a compiled-in catalog,
// so a test that drives Phases supplies one. See the fixture header for why the
// ids here are the real Spec Kit ones.
import { buildSpeckitCatalog, EXAMPLE_MODEL } from '../fixtures/speckit-catalog-fixture';
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
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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
    'open_questions: 0',
    'critical_issues: 0',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

const issuesStdout = (phase: string): string =>
  [
    'Remaining issues:',
    '- one outstanding item',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_questions: 1',
    'critical_issues: 1',
    'notes: looping',
    '=== END AUDIT LOG ==='
  ].join('\n');

function makeCliRunner(): { runner: ClaudeCliRunner; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    const prev = counts.get(req.phase) ?? 0;
    counts.set(req.phase, prev + 1);
    const loopOnce = (req.phase === 'speckit-clarify' || req.phase === 'speckit-analyze' || req.phase === 'speckit-review') && prev === 0;
    return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(loopOnce ? issuesStdout(req.phase) : cleanStdout(req.phase)); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
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
  return { runner, counts };
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-standard-pipeline-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Spec-kit New Feature Pipeline end-to-end (T026, US1)', () => {
  it('drives 9 phases with clarify+analyze+review loops and emits audit entries tagged pipelineId="speckit-new-feature"', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const { runner } = makeCliRunner();
    const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
      { catalog: buildSpeckitCatalog() }
    );

    const feature = await queue.enqueue('Add login');
    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('completed');
    expect(run.currentPhase).toBe('done');
    expect(run.pipeline?.id).toBe('speckit-new-feature');

    const log = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));

    const starts = lines.filter((l) => l.eventType === 'phase-start');
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    expect(starts.length).toBe(ends.length);
    expect(starts.length).toBeGreaterThanOrEqual(9);
    for (const entry of starts) {
      expect(entry.payload.pipelineId).toBe('speckit-new-feature');
      expect(typeof entry.payload.phaseId).toBe('string');
      // Feature 098 (T080) — the assertion is that the audit payload reports the
      // Phase's declared model, so it reads the value off the same fixture the
      // catalog was built from rather than repeating a literal. The literal was
      // `claude-opus-5`, which is what the deleted built-ins declared;
      // `repo/examples/` declares `claude-sonnet-5`, and the examples are now
      // where the process content lives.
      expect(entry.payload).toHaveProperty('model', EXAMPLE_MODEL);
      expect(entry.payload).not.toHaveProperty('effort');
      expect(entry.payload).not.toHaveProperty('timeoutMs');
    }
    for (const entry of ends) {
      expect(entry.payload).not.toHaveProperty('pipelineId');
      expect(entry.payload).not.toHaveProperty('phaseId');
      expect(entry.payload).toHaveProperty('fileChangeCounts');
      expect(entry.payload).toHaveProperty('toolCategoryCounts');
    }

    const phaseSequence = starts.map((l) => l.payload.phaseId);
    expect(phaseSequence.slice(0, 9)).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-checklist',
      'speckit-analyze',
      'speckit-analyze',
      'speckit-implement'
    ]);
  });
});
