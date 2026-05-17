import { describe, it, expect, beforeEach } from 'vitest';
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
