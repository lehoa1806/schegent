// FR-R3-152 (T1632g, FR-005, FR-006) — per-queue scheduled-start projection.
//
// Before this feature, `scheduledStartAt`/`scheduledStartSource` were persisted
// on every `QueueState` (Feature 065) but projected only onto the top-level
// `QueueProjection` (the default queue's own reading) — every other queue's
// `QueueRuntime` had no such fields at all. This suite pins two properties
// through the real composition path (`StateProjector` -> `snapshot-composer.ts`
// -> `composeQueueRuntimes`), not a hand-rolled composer-context mock:
//
//   1. Each queue's own `QueueRuntime.scheduledStartAt`/`scheduledStartSource`
//      come from that queue's own persisted entry, and only that entry — a
//      fixture that swaps two queues' schedules fails by queue id (FR-005).
//   2. The write-time lockstep (`scheduledStartAt !== null` implies
//      `lifecycle === 'idle-pending'`) holds as a read-side property over the
//      projection, for every queue in the snapshot (FR-006). This is asserted
//      here — not re-enforced at the projection layer, per FR-012's ban on a
//      second `idle-pending` enforcement site.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { QueueManager } from '../../../../src/queue/queue-manager';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { runtimeOf } from './queue-runtime-read.helpers';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import type { ScheduledStartSource } from '../../../../src/queue/feature-request';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';

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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-projector-sched-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeProjector(): StateProjector {
  return new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    debounceMs: 100
  });
}

/**
 * Arms a schedule directly on the named queue's persisted entry, the same
 * lockstep write `ScheduledStartCoordinator` performs (queueLifecycle and
 * scheduledStartAt/Source in one write) — bypassing the coordinator itself
 * because this suite is about the projection reading the persisted entry
 * correctly, not about how the entry comes to be armed.
 */
async function armSchedule(
  queueId: string,
  scheduledStartAt: number,
  source: ScheduledStartSource = 'operator-chooser'
): Promise<void> {
  await store.updateQueue(
    (current) => ({
      queue: {
        ...current,
        queueLifecycle: 'idle-pending',
        scheduledStartAt,
        scheduledStartSource: source
      },
      result: undefined
    }),
    queueId,
    unfencedCommit('test-fixture')
  );
}

/** Every queue currently published, as an array. */
function allRuntimes(snap: Pick<WorkflowSnapshot, 'queues'>) {
  return snap.queues;
}

describe('QueueRuntime schedule projection (FR-R3-152, T1632)', () => {
  it("projects each queue's own scheduledStartAt/scheduledStartSource, sourced only from that queue's entry", async () => {
    const second = await queue.createQueue('second');
    expect(second.ok, second.ok ? '' : second.reason).toBe(true);
    const secondQueueId = second.queueId!;

    await armSchedule(DEFAULT_QUEUE_ID, 1_700_000_100_000, 'operator-chooser');
    await armSchedule(secondQueueId, 1_700_000_200_000, 'operator-restart');

    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();

    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).scheduledStartAt).toBe(1_700_000_100_000);
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).scheduledStartSource).toBe('operator-chooser');
    expect(runtimeOf(snap, secondQueueId).scheduledStartAt).toBe(1_700_000_200_000);
    expect(runtimeOf(snap, secondQueueId).scheduledStartSource).toBe('operator-restart');

    // The non-vacuity check named in the feature's acceptance evidence: a
    // fixture that swapped the two queues' values would fail this assertion.
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).scheduledStartAt).not.toBe(
      runtimeOf(snap, secondQueueId).scheduledStartAt
    );

    p.dispose();
  });

  it('projects null for a queue with no armed schedule, default queue included', async () => {
    const second = await queue.createQueue('second');
    const secondQueueId = second.queueId!;
    await armSchedule(secondQueueId, 1_700_000_300_000);

    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();

    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).scheduledStartAt).toBeNull();
    expect(runtimeOf(snap, DEFAULT_QUEUE_ID).scheduledStartSource).toBeNull();

    p.dispose();
  });

  it(
    'holds the FR-006 lockstep for every published queue: scheduledStartAt !== null implies ' +
      "lifecycle === 'idle-pending' (property test over the projection, not a second enforcement site)",
    async () => {
      const second = await queue.createQueue('second');
      const secondQueueId = second.queueId!;
      const third = await queue.createQueue('third');
      const thirdQueueId = third.queueId!;

      // Default: scheduled. Second: idle-pending with no schedule (the FR-006
      // second sentence — not every held-pending queue has one). Third:
      // untouched (active-empty, the steady-state default).
      await armSchedule(DEFAULT_QUEUE_ID, 1_700_000_400_000);
      await store.updateQueue(
        (current) => ({
          queue: { ...current, queueLifecycle: 'idle-pending' },
          result: undefined
        }),
        secondQueueId,
        unfencedCommit('test-fixture')
      );

      const p = makeProjector();
      p.start();
      const snap = p.getCurrentSnapshot();

      for (const runtime of allRuntimes(snap)) {
        if (runtime.scheduledStartAt !== null) {
          expect(runtime.lifecycle, `queue ${runtime.queueId} carries a schedule but is not idle-pending`).toBe(
            'idle-pending'
          );
        }
      }

      // The held-but-unscheduled and the untouched queue both read null,
      // confirming the property isn't vacuously true because nothing but the
      // default ever carries a schedule.
      expect(runtimeOf(snap, secondQueueId).lifecycle).toBe('idle-pending');
      expect(runtimeOf(snap, secondQueueId).scheduledStartAt).toBeNull();
      expect(runtimeOf(snap, thirdQueueId).lifecycle).toBe('active-empty');
      expect(runtimeOf(snap, thirdQueueId).scheduledStartAt).toBeNull();

      p.dispose();
    }
  );
});
