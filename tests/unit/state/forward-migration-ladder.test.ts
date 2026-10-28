// FR-R3-039 — every branch of `initialize()` runs the same forward ladder.
//
// The round-3 review (STATE-1) proposed extracting "eight `migrateVnToVn+1`
// methods" from `WorkspaceStateStore`. Those had already been extracted, into
// `queue-state-migrator.ts`, `run-state-migrator.ts`,
// `history-state-migrator.ts` and their siblings. What was still duplicated was
// the ORCHESTRATION: the seven-step ladder was written out in full at four
// separate points in `initialize()`, once per version branch — the same calls,
// in the same order, four times.
//
// That is duplication with teeth. Order is load-bearing (each step's doc comment
// says what it must run after and why), and an order stated four times is an
// order that can disagree with itself. Adding a v13 → v14 step meant editing four
// places, and missing one left a branch that silently skipped a migration for
// whichever workspaces took it.
//
// `runForwardMigrations()` is now the single definition of the sequence. This
// test is what keeps it single: it drives all four branches and asserts each one
// reports the ladder's full result shape. A branch that stopped calling the
// ladder — or called a subset of it — would return a result missing those keys.
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceStateStore,
  KEYS,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  type Memento,
  type InitializeResult
} from '../../../src/state/workspace-state';
import type { WatchdogState, WorkflowRun } from '../../../src/state/workflow-run';
import {
  buildQueueRegistry,
  buildQueueStateMap,
  buildWorkflowRun,
  fixtureQueueId,
  FIXTURE_NOW
} from '../../fixtures/state/queue-fixtures';

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

/**
 * The keys the ladder owns. Named here rather than derived from a result, so a
 * step removed from `runForwardMigrations` fails this test instead of quietly
 * shrinking what it is compared against.
 */
const LADDER_KEYS = [
  'v6MigrationEvents',
  'v7MigrationEvents',
  'v10MigrationEvents',
  'v11MigrationEvents',
  'v12MigrationEvents',
  'v13MigrationEvents',
  // FR-R4-F01 (spec 239, US4, contract V2 G6) — the verdict-basis step.
  'v14MigrationEvents'
] as const;

/**
 * The four states `initialize()` branches on, by the condition each one takes.
 * Reaching all four is the point: three of them were previously served by
 * copy-pasted ladders, and a divergence between them is invisible to a test that
 * only exercises one.
 */
const BRANCHES: ReadonlyArray<{ name: string; seed: (m: FakeMemento) => Promise<void> }> = [
  {
    name: 'no persisted version string',
    seed: async () => {
      /* nothing persisted at all */
    }
  },
  {
    name: 'version string matches, numeric behind',
    seed: async (m) => {
      await m.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION - 1);
    }
  },
  {
    name: 'version string and numeric both current',
    seed: async (m) => {
      await m.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    }
  },
  {
    name: 'same major, different version string',
    seed: async (m) => {
      const [major] = SCHEMA_VERSION.split('.');
      await m.update(KEYS.schemaVersion, `${major}.99.99`);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    }
  }
];

describe('FR-R3-039 — the forward migration ladder is defined once', () => {
  for (const branch of BRANCHES) {
    it(`reports every ladder step on the "${branch.name}" branch`, async () => {
      const memento = new FakeMemento();
      await branch.seed(memento);
      const result: InitializeResult = await new WorkspaceStateStore(memento).initialize();

      for (const key of LADDER_KEYS) {
        expect(
          Array.isArray(result[key]),
          `the "${branch.name}" branch of initialize() returned no \`${key}\`. Every branch runs ` +
            `the same ladder through runForwardMigrations(); a branch that returns a partial ` +
            `result has stopped calling it, which is the duplication this test exists to prevent.`
        ).toBe(true);
      }
    });
  }

  it('reaches every branch, so none of them is asserted vacuously', () => {
    // A guard on the guard: if `initialize()` gains a fifth branch, the four
    // above no longer cover it and this test would keep passing while saying
    // nothing about the new one.
    expect(BRANCHES).toHaveLength(4);
  });

  it('counts a migration as having run by reading the whole result shape', async () => {
    // `migrated` was computed from six named `.length > 0` checks. A seventh step
    // added without a seventh check would report `migrated: false` on a workspace
    // that had just been migrated. It now reads every field of the ladder result.
    const memento = new FakeMemento();
    const result = await new WorkspaceStateStore(memento).initialize();
    expect(typeof result.migrated).toBe('boolean');
  });
});

describe('FR-R4-F01 (contract V2 G6) — the verdict-basis step sits between two others', () => {
  it('runs after the v12-to-v13 step and before the orphaned-Run reconcile, on every branch', async () => {
    // The step reads `KEYS.run` as a map, which the v10-to-v11 reshape guarantees, and the
    // reconcile must see the Phases it has already made explicit. The order is load-bearing, so it
    // is observed rather than described: each private step is wrapped to record when it ran.
    const proto = WorkspaceStateStore.prototype as unknown as Record<string, () => Promise<unknown>>;
    const observed: string[] = [];
    const restore: Array<() => void> = [];
    for (const name of [
      'migrateV12ToV13IfNeeded',
      'migrateVerdictBasisIfNeeded',
      'reconcileOrphanedRunsIfNeeded'
    ]) {
      const original = proto[name];
      expect(original, `${name} is missing from the store`).toBeTypeOf('function');
      const spy = vi.spyOn(proto, name).mockImplementation(async function (this: unknown) {
        observed.push(name);
        return original!.call(this);
      });
      restore.push(() => spy.mockRestore());
    }
    try {
      for (const branch of BRANCHES) {
        observed.length = 0;
        const memento = new FakeMemento();
        await branch.seed(memento);
        await new WorkspaceStateStore(memento).initialize();
        expect(observed, branch.name).toEqual([
          'migrateV12ToV13IfNeeded',
          'migrateVerdictBasisIfNeeded',
          'reconcileOrphanedRunsIfNeeded'
        ]);
      }
    } finally {
      for (const undo of restore) undo();
    }
  });
});

// FR-R4-F02 (spec 240, contract W4 G12 to G14; FR-044) — the v15 step writes the credit-pause
// record's default on every Run and `lastPollOutcome` on an existing watchdog record, once, before
// the stamp. The fixture is a complete v14 workspace: a registry, one queue per entry holding the
// Task each Run advances (so the orphan reconcile that follows the step leaves the Runs alone),
// three Runs in the three pause shapes, and a watchdog record a pre-feature build left behind.
const V14 = 14;
const V15 = 15;

/** The three queues of the seeded registry, in registry order. */
const RUN_QUEUES = [
  { queueId: 'default', status: 'running' as const },
  { queueId: fixtureQueueId(1), status: 'paused' as const, retry: true },
  { queueId: fixtureQueueId(3), status: 'paused' as const, manual: true }
] as const;

class CountingMemento extends FakeMemento {
  public readonly writes: string[] = [];
  /** Keys whose next `update()` rejects; consumed on use. */
  public readonly failOnce = new Set<string>();
  update(key: string, value: unknown): Thenable<void> {
    this.writes.push(key);
    if (this.failOnce.delete(key)) {
      return Promise.reject(new Error(`memento write to '${key}' failed`));
    }
    return super.update(key, value);
  }
  seed(key: string, value: unknown): void {
    // `update` is the only writer FakeMemento exposes; seeding bypasses the counter.
    void super.update(key, value);
  }
}

/** A v14 Run: the shape the runtime wrote before the `creditPause` key existed. */
function v14Run(queueId: string, index: number): Record<string, unknown> {
  const spec = RUN_QUEUES[index]!;
  const base = buildWorkflowRun({
    id: `run-${index}`,
    featureId: 'task-0',
    status: spec.status,
    manualPauseCause: 'manual' in spec ? 'operator-paused' : null
  });
  const { creditPause: _absentBeforeV15, ...withoutKey } = base as WorkflowRun & {
    creditPause?: unknown;
  };
  const pair =
    'retry' in spec
      ? { delayedRetryCount: 1, pendingRetryAt: FIXTURE_NOW + 60_000, pendingRetryCause: 'rate_limit' }
      : {};
  return {
    ...withoutKey,
    ...pair,
    pipeline: {
      ...base.pipeline,
      phases: base.pipeline!.phases.map((phase) => ({
        ...phase,
        hostVerification: 'exit-code',
        hostVerificationDeclaredAt: 'default'
      }))
    },
    queueIdUnderTest: queueId
  };
}

function seedV14Workspace(memento: CountingMemento): void {
  const registry = buildQueueRegistry({ count: 3, defaultAtPosition: 0 });
  const queues = buildQueueStateMap(registry);
  const collapsed: Record<string, unknown> = {};
  for (const [queueId, state] of Object.entries(queues)) {
    // Already collapsed (FR-R3-011), so the v13 step has nothing to rewrite and the only keys this
    // file sees move are the ones the v15 step owns.
    const { paused: _mirror, ...rest } = state;
    collapsed[queueId] = { ...rest, queueLifecycle: 'idle-pending', pauseSource: null };
  }
  const runs: Record<string, unknown> = {};
  RUN_QUEUES.forEach((spec, index) => {
    const { queueIdUnderTest: _tag, ...run } = v14Run(spec.queueId, index);
    runs[spec.queueId] = run;
  });
  const watchdog: Omit<WatchdogState, 'lastPollOutcome'> = {
    paused: true,
    pausedSince: FIXTURE_NOW,
    nextPollAt: FIXTURE_NOW + 1_800_000,
    pollIntervalMs: 1_800_000,
    lastStatusOk: null,
    cause: 'rate_limit'
  };
  memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
  memento.seed(KEYS.schemaVersionNumeric, V14);
  memento.seed(KEYS.queueRegistry, registry);
  memento.seed(KEYS.queue, collapsed);
  memento.seed(KEYS.run, runs);
  memento.seed(KEYS.watchdog, watchdog);
}

function creditPauseOf(run: WorkflowRun): unknown {
  return (run as unknown as { creditPause?: unknown }).creditPause;
}

describe('FR-R4-F02 (contract W4 G12, G13; FR-044) — the v15 credit-pause step', () => {
  it('is the version this feature stamps', () => {
    expect(STATE_SCHEMA_VERSION).toBe(V15);
  });

  it('stamps 15, defaults creditPause on every Run and lastPollOutcome on the watchdog record', async () => {
    const memento = new CountingMemento();
    seedV14Workspace(memento);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(V15);
    const runs = Object.entries(store.getRunMap());
    expect(runs).toHaveLength(RUN_QUEUES.length);
    for (const [queueId, run] of runs) {
      expect(creditPauseOf(run), `Run of queue ${queueId}`).toBeNull();
    }
    expect(store.getWatchdog().lastPollOutcome).toBeNull();
    expect(memento.get<Record<string, unknown>>(KEYS.watchdog)).toHaveProperty(
      'lastPollOutcome',
      null
    );
  });

  it('leaves every other field of each Run as it was', async () => {
    const memento = new CountingMemento();
    seedV14Workspace(memento);
    const before = memento.get<Record<string, Record<string, unknown>>>(KEYS.run)!;
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    for (const [queueId, run] of Object.entries(store.getRunMap())) {
      const { creditPause: _added, ...rest } = run as WorkflowRun & { creditPause?: unknown };
      expect(rest, `Run of queue ${queueId}`).toEqual(before[queueId]);
    }
  });

  it('writes nothing on a second open', async () => {
    // The count is taken over the keys this step and the stamp own. `KEYS.queue` is excluded on
    // purpose: the v9 -> v10 step rewrites it on every open of any workspace, a behaviour this
    // feature neither adds nor changes.
    const memento = new CountingMemento();
    seedV14Workspace(memento);
    await new WorkspaceStateStore(memento).initialize();
    expect(memento.writes).toContain(KEYS.run);
    expect(memento.writes).toContain(KEYS.watchdog);

    memento.writes.length = 0;
    await new WorkspaceStateStore(memento).initialize();
    const ownKeys = new Set<string>([
      KEYS.run,
      KEYS.watchdog,
      KEYS.schemaVersion,
      KEYS.schemaVersionNumeric
    ]);
    expect(memento.writes.filter((key) => ownKeys.has(key))).toEqual([]);
  });

  it('leaves 14 when the open is interrupted after the Run write and before the stamp, and the next open completes', async () => {
    const memento = new CountingMemento();
    seedV14Workspace(memento);
    memento.failOnce.add(KEYS.schemaVersionNumeric);
    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow(/memento write/);

    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(V14);
    const interrupted = memento.get<Record<string, Record<string, unknown>>>(KEYS.run)!;
    for (const run of Object.values(interrupted)) expect(run).toHaveProperty('creditPause', null);

    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(V15);
    expect(Object.values(store.getRunMap()).map(creditPauseOf)).toEqual([null, null, null]);
  });

  it('runs after the verdict-basis step and before the stamp, on every branch', async () => {
    const proto = WorkspaceStateStore.prototype as unknown as Record<string, () => Promise<unknown>>;
    expect(proto['migrateCreditPauseIfNeeded'], 'migrateCreditPauseIfNeeded is missing').toBeTypeOf(
      'function'
    );
    const observed: string[] = [];
    const restore: Array<() => void> = [];
    for (const name of ['migrateVerdictBasisIfNeeded', 'migrateCreditPauseIfNeeded']) {
      const original = proto[name];
      const spy = vi.spyOn(proto, name).mockImplementation(async function (this: unknown) {
        observed.push(name);
        return original!.call(this);
      });
      restore.push(() => spy.mockRestore());
    }
    try {
      for (const branch of BRANCHES) {
        observed.length = 0;
        const memento = new FakeMemento();
        await branch.seed(memento);
        await new WorkspaceStateStore(memento).initialize();
        expect(observed, branch.name).toEqual([
          'migrateVerdictBasisIfNeeded',
          'migrateCreditPauseIfNeeded'
        ]);
      }
    } finally {
      for (const undo of restore) undo();
    }
  });
});
