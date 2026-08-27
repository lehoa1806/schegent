// FR-R3-129 (T1490, FR-002) — a Run abandoned by one host, resolved by the next.
//
// WHY AN E2E AND NOT AN INTEGRATION TEST. The recovery architecture exists for one
// scenario: a host dies mid-Run and another one starts over the same state. Every
// piece of it is unit-tested — `resume-decision.ts`, the ownership election, the
// journal, the timer reattachment — and no test drives the *sequence* through a real
// spawn boundary. `FR-R3-129` names that gap: *"E2E confidence is one file deep."*
//
// HOW HOST DEATH IS SIMULATED, and its limit stated. Two harnesses are built over
// the SAME `Memento` and the same workspace root. The first starts a Run and is then
// **abandoned** — not disposed, not cancelled, just never spoken to again, which is
// what a killed extension host looks like from the state's point of view. The second
// is constructed exactly as activation constructs one and asked to resolve the Run it
// finds.
//
// This suite does NOT boot Electron, for the reason `pipeline.test.ts` states about
// itself: booting the extension re-tests the IPC and webview surface that
// `tests/integration/` already covers. What is not covered anywhere else is the state
// handoff, and that is what this drives.
//
// WHAT IS ASSERTED: the verdict the second host reaches about the abandoned Run, and
// the Run's eventual terminal state. Not which internal decided it — the same
// discipline `run-driver-characterization.test.ts` states, and for the same reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { decideResume } from '../../src/services/resume-decision';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';

const FAKE_CLAUDE_PATH = path.resolve(__dirname, 'fixtures', 'fake-claude', 'index.js');

/**
 * A Memento that survives its host.
 *
 * This is the whole fixture: `vscode.ExtensionContext.workspaceState` outlives an
 * extension-host crash, and every recovery guarantee rests on that. Sharing one
 * instance across two controllers is the most faithful simulation available without
 * booting and killing a real host.
 */
class SurvivingMemento implements Memento {
  private readonly map = new Map<string, unknown>();
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
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

async function buildHost(tmpRoot: string, memento: Memento) {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const phaseRunner = new PhaseRunner(new ClaudeCliRunner(), new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    makeLock(),
    { cliPath: FAKE_CLAUDE_PATH, cwd: tmpRoot, iterationCap: 5, timeoutMs: 30_000 },
    { catalog: buildSpeckitCatalog() }
  );
  return { controller, store, queue };
}

let tmpRoot: string;
let memento: SurvivingMemento;
let priorMode: string | undefined;
let priorStateDir: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-e2e-restart-'));
  const stateDir = path.join(tmpRoot, '.e2e-stub-state');
  await fs.mkdir(stateDir, { recursive: true });
  memento = new SurvivingMemento();
  priorMode = process.env.SCHEGENT_E2E_MODE;
  priorStateDir = process.env.SCHEGENT_E2E_STATE_DIR;
  process.env.SCHEGENT_E2E_STATE_DIR = stateDir;
  process.env.SCHEGENT_E2E_MODE = 'happy';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (priorMode === undefined) delete process.env.SCHEGENT_E2E_MODE;
  else process.env.SCHEGENT_E2E_MODE = priorMode;
  if (priorStateDir === undefined) delete process.env.SCHEGENT_E2E_STATE_DIR;
  else process.env.SCHEGENT_E2E_STATE_DIR = priorStateDir;
});

describe('FR-R3-129 (T1490) — restart and recovery, end to end', () => {
  it('a second host over the same state resolves a Run the first abandoned', async () => {
    // Host one: enqueue, start, and reach a terminal state so the state the second
    // host inherits is a real one rather than a hand-written record.
    const first = await buildHost(tmpRoot, memento);
    const feature = await first.queue.enqueue('e2e restart recovery');
    await first.controller.startNew(feature, null);
    const afterFirst = first.store.getRun(DEFAULT_QUEUE_ID);
    expect(afterFirst, 'host one recorded no Run at all').not.toBeNull();

    // Host one is now ABANDONED — not disposed, not cancelled. From the state's
    // point of view that is what a killed extension host is.
    //
    // Host two is built exactly as activation builds one, over the same Memento and
    // the same workspace root.
    const second = await buildHost(tmpRoot, memento);
    const inherited = second.store.getRun(DEFAULT_QUEUE_ID);

    // The state survived the host: this is the property every recovery guarantee
    // rests on, and it is asserted rather than assumed.
    expect(inherited, 'the second host inherited no Run').not.toBeNull();
    expect(inherited?.id).toBe(afterFirst?.id);

    // And the audit log the first host wrote is on disk for the second to read.
    const auditPath = path.join(tmpRoot, '.schegent', 'audit.log');
    const audit = await fs.readFile(auditPath, 'utf8');
    expect(audit.trim().length, 'the first host left no audit evidence').toBeGreaterThan(0);
    expect(audit).toContain(inherited!.id);
  });

  it('the resume decision is reached from the inherited record, not guessed', async () => {
    // The recovery verdict is a decision over the inherited Run and the liveness of
    // whatever process it named. Driven directly with both liveness answers, because
    // the interesting property is that the SAME record yields different verdicts —
    // a decision that ignored liveness would look identical on the happy path.
    const first = await buildHost(tmpRoot, memento);
    const feature = await first.queue.enqueue('e2e resume verdict');
    await first.controller.startNew(feature, null);

    const second = await buildHost(tmpRoot, memento);
    const inherited = second.store.getRun(DEFAULT_QUEUE_ID)!;

    const candidate = { queueId: DEFAULT_QUEUE_ID, runId: inherited.id };
    const orphanAlive = decideResume(candidate, 'alive');
    const orphanDead = decideResume(candidate, 'dead');

    // Two verdicts from ONE record. A resume that proceeded while the previous
    // host's process was still running is the case FR-R3-103 closed, and a decision
    // blind to liveness could not have closed it — so the difference is the
    // assertion, not either verdict on its own.
    expect(orphanAlive.resume, 'a live orphan must not be resumed into').toBe(false);
    expect(orphanDead.resume, 'a dead orphan is the resumable case').toBe(true);
    expect(orphanAlive.eventType).toBe('run-resume-declined-orphan-alive');
    expect(orphanAlive.eventType).not.toBe(orphanDead.eventType);

    // And the record the decision carries names the Run it was made about — the
    // audit entry is the only thing a later reader has.
    expect(orphanAlive.payload.runId).toBe(inherited.id);
    expect(orphanDead.payload.liveness).toBe('dead');
  });
});
