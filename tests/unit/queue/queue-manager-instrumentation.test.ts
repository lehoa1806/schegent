import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { SanitizedLogger, type LogSink } from '../../../src/lib/logger';

/**
 * Feature 019 BUG-001 (T045) — paired INFO-on-success / WARN-on-failure
 * instrumentation for `QueueManager` operator-initiated mutations
 * (FR-021).
 *
 * Feature 030 (US3, T046) — the original FR-021 suite covered seven
 * canonical op tags backed by `createNamedQueue` / `renameNamedQueue` /
 * `deleteNamedQueue` / `setSchedule` / `clearSchedule` and the
 * multi-queue branch of `setQueuePausedState`. The single-queue
 * migration removed those public methods from `QueueManager`; the
 * remaining tagged ops on the single unified queue are limited to
 * pause/resume (still exercised at the integration level) and the
 * pre-existing `enqueue` / `dequeue` DEBUG instrumentation. This file
 * now pins only the DEBUG branch, which is the part of FR-021 that
 * survived the migration unchanged.
 */

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

function makeSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string) {
      lines.push(line);
    }
  };
}

let store: WorkspaceStateStore;
let queue: QueueManager;
let sink: LogSink & { lines: string[] };

beforeEach(async () => {
  const memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  sink = makeSink();
  const logger = new SanitizedLogger([sink]);
  queue = new QueueManager(store, logger);
});

describe('QueueManager — FR-021 preserves existing DEBUG enqueue/dequeue lines (T016)', () => {
  it('still emits DEBUG queue-manager.enqueue on enqueue', async () => {
    await queue.enqueue('feature A');
    const line = sink.lines.find(
      (l) => l.includes('DEBUG') && l.includes('queue-manager.enqueue')
    );
    expect(line).toBeDefined();
    expect(line).toContain('"sizeAfter":1');
  });

  it('still emits DEBUG queue-manager.dequeue on markInFlight', async () => {
    const a = await queue.enqueue('feature A');
    sink.lines.length = 0;
    await queue.markInFlight(a.id, 'run-1');
    const line = sink.lines.find(
      (l) => l.includes('DEBUG') && l.includes('queue-manager.dequeue')
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"taskId":"${a.id}"`);
  });

  it('does NOT emit INFO/WARN on plain enqueue (only DEBUG)', async () => {
    await queue.enqueue('feature A');
    const infoCount = sink.lines.filter((l) => l.includes('INFO')).length;
    const warnCount = sink.lines.filter((l) => l.includes('WARN')).length;
    expect(infoCount).toBe(0);
    expect(warnCount).toBe(0);
  });
});

// FR-R4-F05 (FR-011; the brief's "never leak exception substrings to IPC") — the reason a failed
// mutation returns is read by the sidebar and shown to the operator. Two helpers turned any thrown
// `Error` into `reason: err.message`, so an I/O fault from the persistence layer put its path in
// that field. A typed refusal keeps its own code; anything else answers the closed
// `operation-rejected` and the detail goes to the log through `describeFailure`.
describe('QueueManager — an unexpected mutation failure answers a code, never the exception (FR-R4-F05)', () => {
  // A synthetic home directory: a real OS fault from the persistence layer names one.
  const SYNTHETIC_PATH = '/synthetic/home/user-252/state.json';
  const osFault = (): Error => new Error(`EACCES: permission denied, open '${SYNTHETIC_PATH}'`);
  const detailLines = (): string[] =>
    sink.lines.filter((l) => l.includes('WARN') && l.includes('unexpected mutation failure'));

  it('createQueue answers operation-rejected for a registry write that throws a path-bearing Error', async () => {
    vi.spyOn(store, 'updateQueueRegistry').mockRejectedValueOnce(osFault());

    const result = await queue.createQueue('Backlog');

    expect(result).toMatchObject({ ok: false, reason: 'operation-rejected' });
    expect(JSON.stringify(result)).not.toContain('user-252');
  });

  it('modifyTask answers operation-rejected for a task write that throws a path-bearing Error', async () => {
    const task = await queue.enqueue('feature A');
    vi.spyOn(store, 'modifyPendingRequest').mockRejectedValueOnce(osFault());

    const result = await queue.modifyTask(task.id, 'a new description');

    expect(result).toEqual({ ok: false, reason: 'operation-rejected' });
  });

  it('keeps the detail for the log, where the logger sanitizes it, and out of the reason', async () => {
    const task = await queue.enqueue('feature A');
    vi.spyOn(store, 'modifyPendingRequest').mockRejectedValueOnce(osFault());

    const result = await queue.modifyTask(task.id, 'a new description');

    expect(JSON.stringify(result)).not.toContain('user-252');
    const lines = detailLines();
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).toContain('user-252');
  });

  it('answers operation-rejected for a thrown null and logs a bounded description of it', async () => {
    const task = await queue.enqueue('feature A');
    vi.spyOn(store, 'modifyPendingRequest').mockRejectedValueOnce(null);

    const result = await queue.modifyTask(task.id, 'a new description');

    expect(result).toEqual({ ok: false, reason: 'operation-rejected' });
    expect(detailLines().join('\n')).toContain('null thrown');
  });

  it('keeps the typed refusals and the description-validation code, with no detail line', async () => {
    const task = await queue.enqueue('feature A');

    const unknownTask = await queue.modifyTask('no-such-task', 'a new description');
    const emptyDescription = await queue.modifyTask(task.id, '   ');
    const emptyName = await queue.createQueue('');

    expect(unknownTask).toEqual({ ok: false, reason: 'unknown-task-id' });
    expect(emptyDescription).toEqual({ ok: false, reason: 'invalid-description' });
    expect(emptyName).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(detailLines()).toHaveLength(0);
  });
});
