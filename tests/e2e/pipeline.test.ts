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
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';

// Feature 034 Item 055 — deterministic Speckit pipeline E2E test.
//
// Drives the FULL controller stack against the REAL `ClaudeCliRunner`
// (no test doubles). The runner spawns the fake-claude stub at
// `tests/e2e/fixtures/fake-claude/index.js` via its shebang. The stub's
// behavior is gated by `SCHEGENT_E2E_MODE`, set on `process.env` in
// `beforeEach` so the spawned child inherits it. Modes: happy, loop-once,
// fatal.
//
// The test does NOT use `@vscode/test-electron` — booting the full
// extension would re-test the IPC + webview surface that
// `tests/integration/` already covers. Item 055's value is the spawn
// boundary (argv shape, prompt transport, stdout parser, audit fence,
// classification, phase advancement), which this harness exercises
// directly.

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

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'this-window' })),
    heartbeat: vi.fn(async () => {}),
    isHeld: vi.fn(() => true),
    isForeignLockHeld: vi.fn(() => false),
    ownerOfRecord: vi.fn(() => 'this-window'),
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

const FAKE_CLAUDE_PATH = path.resolve(__dirname, 'fixtures', 'fake-claude', 'index.js');

async function buildHarness(tmpRoot: string) {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);

  const runner = new ClaudeCliRunner();
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
    {
      cliPath: FAKE_CLAUDE_PATH,
      cwd: tmpRoot,
      iterationCap: 5,
      timeoutMs: 30_000,
    }
  );

  return { controller, store, queue, audit };
}

let tmpRoot: string;
let stateDir: string;
let priorMode: string | undefined;
let priorStateDir: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-e2e-pipeline-'));
  stateDir = path.join(tmpRoot, '.e2e-stub-state');
  await fs.mkdir(stateDir, { recursive: true });
  priorMode = process.env.SCHEGENT_E2E_MODE;
  priorStateDir = process.env.SCHEGENT_E2E_STATE_DIR;
  process.env.SCHEGENT_E2E_STATE_DIR = stateDir;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (priorMode === undefined) delete process.env.SCHEGENT_E2E_MODE;
  else process.env.SCHEGENT_E2E_MODE = priorMode;
  if (priorStateDir === undefined) delete process.env.SCHEGENT_E2E_STATE_DIR;
  else process.env.SCHEGENT_E2E_STATE_DIR = priorStateDir;
});

async function readAuditLines(workspaceRoot: string): Promise<readonly Record<string, unknown>[]> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return log
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('Feature 034 Item 055 — deterministic Speckit pipeline E2E', () => {
  it('drives all 7 phases happy-path through the real ClaudeCliRunner + fake-claude stub', async () => {
    process.env.SCHEGENT_E2E_MODE = 'happy';
    const { controller, store, queue } = await buildHarness(tmpRoot);
    const feature = await queue.enqueue('e2e happy path');
    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('completed');
    expect(run.currentPhase).toBe('done');
    expect(run.pipeline?.id).toBe('speckit-new-feature');

    const lines = await readAuditLines(tmpRoot);
    const starts = lines.filter((l) => l.eventType === 'phase-start');
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    expect(starts.length).toBe(ends.length);

    const phaseSequence = starts.map(
      (l) => (l.payload as { phaseId: string }).phaseId
    );
    expect(phaseSequence).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-checklist',
      'speckit-analyze',
      'speckit-implement',
      'speckit-review',
      'finalize'
    ]);
  }, 60_000);

  it('exercises the clarify+analyze loop when the stub returns ISSUES_REMAIN once', async () => {
    process.env.SCHEGENT_E2E_MODE = 'loop-once';
    const { controller, store, queue } = await buildHarness(tmpRoot);
    const feature = await queue.enqueue('e2e loop-once');
    await controller.startNew(feature, null);

    const lines = await readAuditLines(tmpRoot);
    const starts = lines.filter((l) => l.eventType === 'phase-start');
    const phaseSequence = starts.map(
      (l) => (l.payload as { phaseId: string }).phaseId
    );

    expect(phaseSequence.filter((p) => p === 'speckit-clarify').length).toBe(2);
    expect(phaseSequence.filter((p) => p === 'speckit-analyze').length).toBe(2);
    expect(phaseSequence.filter((p) => p === 'speckit-implement').length).toBe(1);

    const run = store.getRun()!;
    expect(run.status).toBe('completed');
  }, 60_000);

  it('terminates on a fatal-signature match without retrying', async () => {
    process.env.SCHEGENT_E2E_MODE = 'fatal';
    const { controller, store, queue } = await buildHarness(tmpRoot);
    const feature = await queue.enqueue('e2e fatal');
    await controller.startNew(feature, null);

    const run = store.getRun()!;
    expect(run.status).toBe('failed');
    expect(run.currentPhase).toBe('speckit-implement');
  }, 60_000);
});
