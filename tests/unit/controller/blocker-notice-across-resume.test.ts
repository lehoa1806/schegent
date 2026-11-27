// FR-R5-F19 (feature 278, T19.1, FR-001, SC-001) — the first-blocker notice is once per Run, and a Run
// that failed on its decision and is resumed is still the same Run.
//
// A failed Run is terminal, so the controller disposes its session (and the driver in it) when the
// drive returns; resuming builds a new driver. A ledger owned by the driver would therefore forget the
// Run and repeat the notice. These cases build the real controller so that the ledger's owner, not only
// its use, is under test. The harness follows `retry-phase-now.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { buildSpeckitCatalog } from '../../fixtures/speckit-catalog-fixture';
import { RecordingDeadlineTimer } from '../../recording-deadline-timer';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

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

const BLOCKING_TAG = 'needs-decision';
const NOTICE_FRAGMENT = 'waiting on a decision';

function blockingOutput(tag: string): PhaseRunOutput {
  return {
    result: { kind: 'remaining_issues', issues: [{ tag, summary: 'Pick the retention window' }], auditEntry: null as never },
    outcome: 'issues_remain',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: 'audit-1',
    warnings: []
  } as unknown as PhaseRunOutput;
}

let store: WorkspaceStateStore;
let queue: QueueManager;
let runSpy: ReturnType<typeof vi.fn>;
let controller: SchegentWorkflowController;
let notifier: Notifier;

beforeEach(async () => {
  const memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  runSpy = vi.fn();
  const phaseRunner = { run: runSpy, evictStagnationTracker: vi.fn() } as unknown as PhaseRunner;
  const auditAppend = vi.fn(async (entry: Record<string, unknown>) => ({
    id: 'mock-audit-id',
    timestamp: new Date().toISOString(),
    ...entry
  }));
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    notifier,
    new SanitizedLogger(),
    {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
    {
      catalog: buildSpeckitCatalog(),
      auditWriter: { append: auditAppend } as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
      deadlineTimer: new RecordingDeadlineTimer()
    }
  );
});

const noticesRaised = (): number =>
  vi
    .mocked(notifier.warn)
    .mock.calls.filter((call) => String(call.at(0)).includes(NOTICE_FRAGMENT)).length;

describe('the first-blocker notice across a resume of the same Run', () => {
  it('is raised once when a Run blocks, ends, and is resumed to block again', async () => {
    runSpy.mockImplementation(async () => blockingOutput(BLOCKING_TAG));
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    const firstRun = store.getRun(DEFAULT_QUEUE_ID);
    expect(firstRun).not.toBeNull();
    // The premise of the case: the first drive ended the Run, so its driver is gone.
    expect(firstRun?.status).toBe('failed');
    expect(noticesRaised()).toBe(1);

    await controller.resumeExisting(DEFAULT_QUEUE_ID);

    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe(firstRun?.id);
    expect(runSpy.mock.calls.length).toBeGreaterThan(1);
    expect(noticesRaised()).toBe(1);
  }, 20_000);

  it('control: a report with no blocking tag raises none, so the count above is the notice and not noise', async () => {
    runSpy.mockImplementation(async () => blockingOutput('needs-fix'));
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(runSpy.mock.calls.length).toBeGreaterThan(0);
    expect(noticesRaised()).toBe(0);
  }, 20_000);
});
