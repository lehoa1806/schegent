// Feature 034 T013 — end-to-end integration test for the deleteTask cleanup.
// See specs/034-task-deletion-cleanup/quickstart.md.
//
// Scenarios under test:
//   1. Two terminal tasks bound to R1 and R2; delete R1 → R1 artifacts gone,
//      R2 artifacts preserved; audit grew; `task-removed` payload carries
//      `sessionCleaned: true`.
//   2. Delete R2 with a permission-revoked tree → cleanup returns false;
//      `R2/` remains; queue row gone; audit event carries
//      `sessionCleaned: false`; runtime warn was emitted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import type { PhaseRunner } from '../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { removeTempRoot } from '../temp-root-cleanup';
import { createFailureRecorder } from '../../src/services/failure-record/failure-record-service';

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
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

async function seedSession(tmpRoot: string, runId: string): Promise<{ sessionDir: string; rawFile: string }> {
  const sessionDir = path.join(tmpRoot, '.schegent', 'sessions', runId);
  const iterDir = path.join(sessionDir, 'diagnostics', 'pipe', 'phase', 'iter-1');
  // Owner-only, as the extension creates this tree since feature 217. A
  // .schegent left at the umask's 0755 is narrowed by the audit log's next
  // append, which reports it through warn, and the first case asserts that
  // warn is never called.
  await fs.mkdir(iterDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(iterDir, 'stream.jsonl'), '{"type":"system"}\n', 'utf8');
  const rawFile = path.join(tmpRoot, '.schegent', 'sessions', `raw-${runId}.log`);
  await fs.writeFile(rawFile, 'transcript bytes\n', 'utf8');
  return { sessionDir, rawFile };
}

let tmpRoot: string;
let logger: SanitizedLogger;
let warnSpy: ReturnType<typeof vi.fn>;
let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let audit: AuditLogWriter;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-delete-cleanup-int-'));
  logger = new SanitizedLogger();
  warnSpy = vi.spyOn(logger, 'warn') as any;
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner;
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
});

afterEach(async () => {
  // Restore write perms first in case T013-scenario-2 left a read-only tree.
  try {
    await fs.chmod(path.join(tmpRoot, '.schegent', 'sessions'), 0o755).catch(() => undefined);
    const rdirs = await fs.readdir(path.join(tmpRoot, '.schegent', 'sessions')).catch(() => [] as string[]);
    for (const sub of rdirs) {
      await fs.chmod(path.join(tmpRoot, '.schegent', 'sessions', sub), 0o755).catch(() => undefined);
    }
  } catch {
    // Best-effort.
  }
  await removeTempRoot(tmpRoot);
});

function makeController(): SchegentWorkflowController {
  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  return new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    makeLock(),
    { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 }
  );
}

async function seedTerminal(runId: string, description: string): Promise<string> {
  const feature = await queue.enqueue(description);
  await queue.markInFlight(feature.id, runId);
  await queue.finish(feature.id, 'completed');
  return feature.id;
}

describe('Feature 034 T013 — deleteTask cleanup end-to-end', () => {
  it('deletes R1 artifacts only — leaves R2 alone; audit grew; sessionCleaned:true', async () => {
    const taskAId = await seedTerminal('R1', 'feature A');
    const taskBId = await seedTerminal('R2', 'feature B');
    const a = await seedSession(tmpRoot, 'R1');
    const b = await seedSession(tmpRoot, 'R2');

    // Capture audit-log size before deletion (file may not exist yet).
    const auditPath = path.join(tmpRoot, '.schegent', 'audit.log');
    const beforeSize = await fs
      .stat(auditPath)
      .then((s) => s.size)
      .catch(() => 0);

    const controller = makeController();
    const result = await controller.deleteTask(taskAId);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe('R1');
    expect(result.sessionCleaned).toBe(true);

    // R1 artifacts gone; R2 untouched.
    await expect(fs.access(a.sessionDir)).rejects.toBeDefined();
    await expect(fs.access(a.rawFile)).rejects.toBeDefined();
    await expect(fs.access(b.sessionDir)).resolves.toBeUndefined();
    await expect(fs.access(b.rawFile)).resolves.toBeUndefined();

    // Emit a sanitized `task-removed` audit entry so we can prove the
    // payload carried `sessionCleaned: true`. The controller itself
    // does NOT write the `task-removed` audit (that lives in the
    // router); but we can construct the same payload shape and
    // confirm the value propagates through the existing audit
    // sanitization pipeline.
    await audit.append({
      runId: 'integration',
      phase: 'speckit-implement' as const,
      iteration: 1,
      eventType: 'task-removed' as const,
      payload: {
        taskId: taskAId,
        queueId: 'default',
        priorStatus: 'completed',
        runId: 'R1',
        cause: 'operator',
        sessionCleaned: result.sessionCleaned ?? false
      },
      outcome: 'success'
    });

    const afterSize = await fs.stat(auditPath).then((s) => s.size);
    expect(afterSize).toBeGreaterThan(beforeSize);
    const auditBody = await fs.readFile(auditPath, 'utf8');
    expect(auditBody).toContain('"sessionCleaned":true');
    expect(auditBody).toContain('"runId":"R1"');

    // taskB is still in the queue.
    expect(queue.findById(taskBId)).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cleanup failure → R2 tree remains; queue row gone; sessionCleaned:false; warn emitted', async () => {
    const taskAId = await seedTerminal('R-FAIL', 'feature C');
    const { sessionDir } = await seedSession(tmpRoot, 'R-FAIL');

    // Lock down the session-root tree so fs.rm fails.
    // chmod 0 on the parent of <runId> makes recursive removal of
    // <runId> ENOTEMPTY / EACCES depending on the platform.
    const parent = path.dirname(sessionDir);
    await fs.chmod(parent, 0o500);

    const controller = makeController();
    const result = await controller.deleteTask(taskAId);

    // Restore perms before any further assertions / teardown.
    await fs.chmod(parent, 0o755);

    expect(result.ok).toBe(true);
    expect(result.sessionCleaned).toBe(false);
    expect(queue.findById(taskAId)).toBeNull();

    // R-FAIL/ tree still exists (cleanup couldn't remove it).
    await expect(fs.access(sessionDir)).resolves.toBeUndefined();

    // Exactly one runtime warn line was emitted by the cleanup helper.
    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls as unknown[][];
    const matched = calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('session-cleanup')
    );
    expect(matched).toBeDefined();

    // Append the audit event the router would emit and confirm the
    // value propagates through the sanitized audit pipeline.
    await audit.append({
      runId: 'integration',
      phase: 'speckit-implement' as const,
      iteration: 1,
      eventType: 'task-removed' as const,
      payload: {
        taskId: taskAId,
        queueId: 'default',
        priorStatus: 'completed',
        runId: 'R-FAIL',
        cause: 'operator',
        sessionCleaned: result.sessionCleaned ?? false
      },
      outcome: 'success'
    });
    const auditBody = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    expect(auditBody).toContain('"sessionCleaned":false');
  });
});

// FR-R4-F15 (feature 243, contract K3.1, K6.8; FR-017, FR-023; User Story 2 scenarios 1 to 4) — Remove
// deletes what it deleted before and nothing else.
//
// A failed Run's failure record lives in `.schegent/failure-records/`, outside the session tree that
// Remove clears, and the audit log lives beside it. This test writes real records through the real
// recorder, removes rows of each terminal kind through the host path the router calls, and compares a
// hash of every record file and of `audit.log` from before to after. The confirmation dialog exists
// only in the webview and is not a host input, so the host path is the same with it enabled and
// disabled; there is no second case for the flag.
describe('FR-R4-F15 K6.8 — Remove keeps every failure record and the audit log', () => {
  const RECORDS = path.join('.schegent', 'failure-records');

  async function hashTree(dir: string): Promise<Record<string, string>> {
    const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
    const hashes: Record<string, string> = {};
    for (const name of names) {
      hashes[name] = createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex');
    }
    return hashes;
  }

  async function writeTwoRecords(taskId: string, runId: string): Promise<void> {
    const recorder = createFailureRecorder({ logger, queue, workspaceRoot: tmpRoot });
    const run = { id: runId, featureId: taskId, currentPhase: 'implement' };
    for (const summary of ['the export test fails', 'the registry is down']) {
      const wrote = await recorder.record({
        run,
        cause: 'last_phase_issues_remain',
        result: {
          kind: 'remaining_issues',
          issues: [{ tag: 'regression', summary }],
          auditEntry: null
        },
        iteration: 1,
        iterationCap: 3
      });
      expect(wrote).toBe(true);
    }
  }

  async function seedRow(kind: 'failed' | 'completed' | 'attested' | 'canceled', runId: string): Promise<string> {
    const feature = await queue.enqueue(`row of kind ${kind}`);
    await queue.markInFlight(feature.id, runId);
    if (kind === 'completed') await queue.finish(feature.id, 'completed');
    else if (kind === 'canceled') await queue.finish(feature.id, 'canceled');
    else await queue.finish(feature.id, 'failed', 'last phase reported remaining issues');
    // An attested row is a completed row that carries the operator's provenance marker (TA7); it is not
    // a seventh status. It reaches that state only from `failed`, through the one method that writes it.
    if (kind === 'attested') {
      const attested = await queue.attestCompleted(feature.id);
      expect(attested).toMatchObject({ ok: true });
      expect(queue.findById(feature.id)).toMatchObject({
        status: 'completed',
        completionProvenance: 'operator-attested'
      });
    }
    return feature.id;
  }

  it.each(['failed', 'completed', 'attested', 'canceled'] as const)(
    'a %s row: the session tree and raw transcript go, every record and audit.log stay byte for byte',
    async (kind) => {
      const runId = `run-k68-${kind}`;
      const taskId = await seedRow(kind, runId);
      const session = await seedSession(tmpRoot, runId);
      await writeTwoRecords(taskId, runId);
      await audit.append({
        runId,
        phase: 'speckit-implement' as const,
        iteration: 1,
        eventType: 'task-removed' as const,
        payload: { taskId, queueId: 'default', priorStatus: 'failed', runId, cause: 'operator', sessionCleaned: true },
        outcome: 'success'
      });

      const recordsDir = path.join(tmpRoot, RECORDS);
      const auditPath = path.join(tmpRoot, '.schegent', 'audit.log');
      const recordsBefore = await hashTree(recordsDir);
      const auditBefore = await fs.readFile(auditPath);
      // Control: there is something to lose, so equality below is not vacuous.
      expect(Object.keys(recordsBefore)).toHaveLength(2);
      await expect(fs.access(session.sessionDir)).resolves.toBeUndefined();
      await expect(fs.access(session.rawFile)).resolves.toBeUndefined();

      const result = await makeController().deleteTask(taskId);

      expect(result.ok).toBe(true);
      expect(result.sessionCleaned).toBe(true);
      await expect(fs.access(session.sessionDir)).rejects.toBeDefined();
      await expect(fs.access(session.rawFile)).rejects.toBeDefined();
      expect(queue.findById(taskId)).toBeNull();
      expect(await hashTree(recordsDir)).toEqual(recordsBefore);
      expect(await fs.readFile(auditPath)).toEqual(auditBefore);
    }
  );

  it('control: a record that is not removed by Remove is still found by name afterwards', async () => {
    const taskId = await seedRow('failed', 'run-k68-find');
    await seedSession(tmpRoot, 'run-k68-find');
    await writeTwoRecords(taskId, 'run-k68-find');
    await makeController().deleteTask(taskId);
    const names = await fs.readdir(path.join(tmpRoot, RECORDS));
    expect(names.filter((name) => name.includes('_run-k68-find_'))).toHaveLength(2);
  });
});
