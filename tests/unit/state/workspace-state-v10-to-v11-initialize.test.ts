// Feature 093 (T010, T010a, T011) — the v10 → v11 reshape as `initialize()`
// performs it, rather than as the pure migrator computes it.
//
// The corpus test next door (`run-state-migrator-v10-to-v11.test.ts`) already
// pins every input → output row. What it cannot see is the store: whether the
// step is wired into all four `initialize()` branches, whether the single write
// is really single, and what a rejected write leaves behind. Those are the
// three properties here.
//
//   T010   every branch returns v11-shaped state. A branch is a *return
//          statement*, not a code path a reader can eyeball — four of them
//          exist and a missed one hands a v10-shaped record to a caller that
//          will treat it as v11, which type-checks and then reads `undefined`.
//   T010a  FR-002a. A rejected write leaves the previous version in its
//          previous shape and the next open re-attempts. Forward-only means
//          re-attempt is the entire recovery story — there is no rollback to a
//          shape the runtime no longer reads, so there is none to assert.
//   T011   guarantee 1. `KEYS.queue` is untouched. v10 reshaped the queue key
//          and left the run key alone; v11 is the exact complement, and that
//          non-overlap is what keeps each migration a single-key write.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import {
  STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION_V10
} from '../../../src/contracts/state-schema';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  buildQueueRegistry,
  buildV9QueueState,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

/**
 * The non-default queue in the seeded registry. `buildQueueRegistry` ids its
 * entries by position, so a two-entry registry with `'default'` at position 0
 * puts this one at position 1.
 */
const OTHER_QUEUE = fixtureQueueId(2);

/** The task each seeded queue holds. Namespaced so no two queues share one. */
function taskIdFor(queueId: string): string {
  return `${queueId}-task`;
}

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  /** Keys whose next `update()` rejects. Consumed on use — one failure each. */
  public readonly failOnce = new Set<string>();
  /** Every key written, in order, including the writes that then rejected. */
  public readonly writes: string[] = [];

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.writes.push(key);
    if (this.failOnce.delete(key)) {
      return Promise.reject(new Error(`memento write to '${key}' failed`));
    }
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }

  seed(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

/**
 * A complete workspace persisted at v10: a registry, one `QueueState` per
 * entry, and a single `WorkflowRun` sitting directly at `KEYS.run`.
 *
 * The Run's task lives in a **non-default** queue on purpose. A Run keyed by
 * `'default'` passes both the "resolved its queue" and the "fell back to
 * default" paths, so it cannot tell them apart — and telling them apart is the
 * whole of FR-003.
 */
function seedV10Workspace(memento: FakeMemento, run: WorkflowRun): void {
  const registry = buildQueueRegistry({ count: 2, defaultAtPosition: 0 });
  const queueMap: Record<string, QueueState> = {};
  for (const entry of registry.entries) {
    const state = buildV9QueueState({ pendingCount: 1 });
    queueMap[entry.id] = {
      ...state,
      queueLifecycle: 'idle-pending',
      requests: state.requests.map((request) => ({
        ...request,
        id: taskIdFor(entry.id),
        queueId: entry.id
      }))
    };
  }
  memento.seed(KEYS.queueRegistry, registry);
  memento.seed(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  memento.seed(KEYS.queue, queueMap);
  memento.seed(KEYS.run, run);
}

let memento: FakeMemento;
let run: WorkflowRun;

beforeEach(() => {
  memento = new FakeMemento();
  run = buildWorkflowRun({ featureId: taskIdFor(OTHER_QUEUE) });
});

describe('initialize() reshapes KEYS.run in every branch (T010, FR-002)', () => {
  /**
   * The four branches, each identified by the persisted version pair that
   * selects it. `initialize()` dispatches on (`schemaVersion` string,
   * `schemaVersionNumeric`) and nothing else, so seeding that pair is a
   * complete way to name a branch.
   */
  const BRANCHES: readonly {
    readonly label: string;
    readonly version: string | undefined;
    readonly numeric: number | undefined;
  }[] = [
    {
      label: 'branch 1 — no persisted version string',
      version: undefined,
      numeric: STATE_SCHEMA_VERSION_V10
    },
    {
      label: 'branch 2 — current version string, stale numeric',
      version: SCHEMA_VERSION,
      numeric: STATE_SCHEMA_VERSION_V10
    },
    {
      label: 'branch 3 — fully current version pair, stale record shape',
      version: SCHEMA_VERSION,
      numeric: STATE_SCHEMA_VERSION
    },
    {
      label: 'branch 4 — same major, different version string',
      version: '1.0.1',
      numeric: STATE_SCHEMA_VERSION_V10
    }
  ];

  it.each(BRANCHES)('returns and persists a v11 record: $label', async ({ version, numeric }) => {
    seedV10Workspace(memento, run);
    if (version !== undefined) memento.seed(KEYS.schemaVersion, version);
    if (numeric !== undefined) memento.seed(KEYS.schemaVersionNumeric, numeric);
    const store = new WorkspaceStateStore(memento);
    const result = await store.initialize();

    expect(memento.get(KEYS.run)).toEqual({ [OTHER_QUEUE]: run });
    expect(result.v11MigrationEvents.map((event) => event.type)).toContain(
      'state-migrated-v10-to-v11'
    );
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });

  /**
   * Branch 3 is the one that would go quiet under a version-gated step: its
   * version pair already reads as current, so a step keyed on the number would
   * decide there is nothing to do and leave a v10 record in place forever. The
   * step is keyed on the record's shape instead, and this is the assertion that
   * says so.
   */
  it('reshapes even when the version pair already reads as current', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);

    const store = new WorkspaceStateStore(memento);
    const result = await store.initialize();

    expect(memento.get(KEYS.run)).not.toHaveProperty('featureId');
    expect(result.migrated).toBe(true);
  });

  it('is idempotent — a second open reshapes nothing and emits nothing (FR-004)', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);

    await new WorkspaceStateStore(memento).initialize();
    const afterFirst = structuredClone(memento.get(KEYS.run));

    const second = await new WorkspaceStateStore(memento).initialize();

    expect(memento.get(KEYS.run)).toEqual(afterFirst);
    expect(second.v11MigrationEvents).toEqual([]);
  });

  /**
   * Feature 093 (T030) — the "exactly one atomic write" half of US2 scenario 1.
   *
   * `KEYS.run` is one memento key and a `Memento` offers no multi-key
   * transaction, so "atomic" here can only mean: the reshape reaches the key
   * once. A second write would mean a window in which the key holds something
   * that is neither the v10 record nor the finished v11 map — and since the
   * whole recovery story for a forward-only migration is "re-attempt on the next
   * open" (T010a above), a crash inside that window is the one state the next
   * open could not repair from. The count is the only way to see it: every
   * assertion in this file reads the key *after* `initialize()` resolves, by
   * which time one write and three are indistinguishable.
   */
  it('reaches KEYS.run exactly once while upgrading (T030, FR-002)', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);

    await new WorkspaceStateStore(memento).initialize();

    expect(memento.writes.filter((key) => key === KEYS.run)).toEqual([KEYS.run]);
    expect(memento.get(KEYS.run)).toEqual({ [OTHER_QUEUE]: run });
  });

  it('fabricates no Run when none was persisted (FR-005)', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.run, undefined);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);

    await new WorkspaceStateStore(memento).initialize();

    expect(memento.get(KEYS.run)).toEqual({});
  });
});

describe('a rejected write leaves v10 state intact (T010a, FR-002a)', () => {
  beforeEach(() => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);
    memento.failOnce.add(KEYS.run);
  });

  it('propagates the failure rather than reporting a migration that did not happen', async () => {
    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow(
      /memento write to 'schegent.run' failed/
    );
  });

  it('leaves the persisted version at v10', async () => {
    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow();

    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION_V10);
  });

  it('leaves the record in its v10 shape — no partially-migrated state', async () => {
    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow();

    expect(memento.get(KEYS.run)).toEqual(run);
  });

  it('re-attempts the upgrade on the next open, and succeeds', async () => {
    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow();

    const retry = await new WorkspaceStateStore(memento).initialize();

    expect(memento.get(KEYS.run)).toEqual({ [OTHER_QUEUE]: run });
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
    expect(retry.v11MigrationEvents.map((event) => event.type)).toContain(
      'state-migrated-v10-to-v11'
    );
  });
});

describe('a persisted version above the runtime is refused (T015, FR-007)', () => {
  /**
   * Refused, never downgraded. A workspace written by a newer release holds
   * queues and Runs this build does not know how to read; opening it anyway
   * would mean writing back a shape that discards whatever the newer release
   * added. Refusing is the only outcome that cannot lose an operator's work.
   *
   * These assertions go through `initialize()` rather than through
   * `assertPersistedVersionSupported` directly, because defect D3 was precisely
   * that the guard was correct in isolation and unreachable in production. A
   * test of the helper alone would have passed throughout.
   */
  it.each([STATE_SCHEMA_VERSION + 1, 99])('refuses version %i', async (persisted) => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, persisted);

    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow(/exceeds runtime/i);
  });

  it('writes nothing on refusal — the newer workspace is left exactly as found', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION + 1);

    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow();

    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION + 1);
    expect(memento.get(KEYS.run)).toEqual(run);
  });

  it('opens a workspace persisted at exactly the runtime version', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);

    await expect(new WorkspaceStateStore(memento).initialize()).resolves.toBeDefined();
  });
});

describe('KEYS.queue is untouched by the v11 migration (T011, guarantee 1)', () => {
  it('reads back byte-identical across the reshape', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);
    const before = structuredClone(memento.get(KEYS.queue));

    await new WorkspaceStateStore(memento).initialize();

    expect(memento.get(KEYS.queue)).toEqual(before);
    expect(memento.get(KEYS.run)).not.toEqual(before);
  });

  it('carries the Run into the queue its task already names, not the default one (FR-003)', async () => {
    seedV10Workspace(memento, run);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);

    await new WorkspaceStateStore(memento).initialize();

    expect(Object.keys(memento.get(KEYS.run) as object)).toEqual([OTHER_QUEUE]);
  });

  it('reassigns a Run whose task belongs to no queue, rather than dropping it (FR-006)', async () => {
    const orphan = buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' });
    seedV10Workspace(memento, orphan);
    memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
    memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);

    const result = await new WorkspaceStateStore(memento).initialize();

    expect(memento.get(KEYS.run)).toEqual({ [DEFAULT_QUEUE_ID]: orphan });
    expect(result.v11MigrationEvents.map((event) => event.type)).toContain(
      'run-reassigned-to-default-queue'
    );
  });
});
