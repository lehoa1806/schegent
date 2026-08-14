// Feature 088 (T008) — the v8 → v9 step, and the compare-and-set write it feeds.
//
// The property that matters most is the negative one: a workspace that predates
// this feature must migrate with nothing moved. That is asserted against a real
// pre-feature memento shape rather than an empty object, so a reader that
// touched `WorkflowRun` would fail here rather than in production.

import { describe, expect, it, vi } from 'vitest';
import {
  STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION_V9,
  STATE_SCHEMA_VERSION_V11
} from '../../../src/contracts/state-schema';
import { migrateConnectedRuns } from '../../../src/state/connected-run-migrator';
import {
  appendAttempt,
  createConnectedRun,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

const GRAPH: WorkflowDefinition = {
  workflowId: 'wf-1',
  name: 'Triage',
  version: 1,
  nodes: [{ nodeId: 'n-a', pipelineId: 'p-a' }],
  connections: [],
  startNodeIds: ['n-a']
};

function sample(id = 'cr-1'): ConnectedWorkflowRun {
  return appendAttempt(
    createConnectedRun({
      connectedRunId: id,
      workflowId: 'wf-1',
      graph: GRAPH,
      pipelines: { 'p-a': { id: 'p-a', name: 'A', phases: [{ id: 'done', name: 'Done' }] } },
      startedAt: 10
    }),
    'n-a',
    { queueItemId: 'q-1', startedAt: 11 }
  );
}

function memento(seed: Record<string, unknown> = {}): Memento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    store,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) store.delete(key);
      // Round-trip through JSON: the memento persists, so a reader must not be
      // handed the same object graph it wrote, frozen and all.
      else store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    }
  };
}

describe('connected-run migration (v8 → v9)', () => {
  it('pins the version bump', () => {
    // Feature 088 introduced v9 and, being current at the time, pinned it as
    // *the* schema version. Feature 092 adds v10, so the two assertions
    // separate: this feature's step is still 9, and 9 is no longer the head.
    // Re-pinning the head here rather than deleting the check keeps the
    // forward-only ratchet asserted somewhere. Feature 093 moves the head
    // again, to v11, for the same reason and by the same edit.
    expect(STATE_SCHEMA_VERSION_V9).toBe(9);
    expect(STATE_SCHEMA_VERSION).toBe(STATE_SCHEMA_VERSION_V11);
    expect(STATE_SCHEMA_VERSION).toBeGreaterThan(STATE_SCHEMA_VERSION_V9);
  });

  it('reads an absent key as an empty collection', () => {
    expect(migrateConnectedRuns(undefined).runs).toEqual({});
    expect(migrateConnectedRuns(null).runs).toEqual({});
    expect(migrateConnectedRuns(undefined).dropped).toEqual([]);
  });

  it('reads a shape-invalid key as empty rather than throwing', () => {
    expect(migrateConnectedRuns('not-a-record').runs).toEqual({});
    expect(migrateConnectedRuns([sample()]).runs).toEqual({});
  });

  it('migrates a pre-feature workspace with nothing moved', async () => {
    const legacyRun = { id: 'run-1', queueItemId: 'q-0', pipeline: { id: 'p', name: 'P', phases: [] } };
    const legacyQueue = { pending: [{ id: 'task-1' }], inFlightId: null };
    const m = memento({
      [KEYS.schemaVersionNumeric]: 8,
      [KEYS.run]: legacyRun,
      [KEYS.queue]: legacyQueue
    });
    const store = new WorkspaceStateStore(m);

    expect(store.getConnectedRuns()).toEqual({});
    expect(m.store.get(KEYS.run)).toEqual(legacyRun);
    expect(m.store.get(KEYS.queue)).toEqual(legacyQueue);
    expect(m.store.has(KEYS.connectedRuns)).toBe(false);

    // Writing one connected run still leaves the pre-feature keys alone.
    await store.compareAndSetConnectedRun(sample(), 0);
    expect(m.store.get(KEYS.run)).toEqual(legacyRun);
    expect(m.store.get(KEYS.queue)).toEqual(legacyQueue);
  });

  it('round-trips a v9 workspace through the memento', async () => {
    const m = memento();
    const store = new WorkspaceStateStore(m);
    const run = sample();

    const written = await store.compareAndSetConnectedRun(run, 0);
    expect(written.outcome).toBe('written');

    const read = store.getConnectedRun('cr-1');
    expect(read).toEqual(run);
    // Frozen means frozen has to survive the restart to mean anything.
    expect(Object.isFrozen(read?.graph)).toBe(true);
    expect(Object.isFrozen(read?.pipelines['p-a'])).toBe(true);
  });

  it('names a record that fails the invariants instead of discarding it silently', () => {
    const warn = vi.fn();
    const m = memento({
      [KEYS.connectedRuns]: {
        'cr-good': JSON.parse(JSON.stringify(sample('cr-good'))) as unknown,
        'cr-bad': { connectedRunId: 'cr-bad', status: 'running' },
        'cr-mismatched': JSON.parse(JSON.stringify(sample('cr-1'))) as unknown
      }
    });
    const store = new WorkspaceStateStore(m, {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (s: string) => s
    } as unknown as ConstructorParameters<typeof WorkspaceStateStore>[1]);

    expect(Object.keys(store.getConnectedRuns())).toEqual(['cr-good']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cr-bad'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cr-mismatched'));
  });
});

describe('connected-run compare-and-set', () => {
  it('refuses a superseded revision with the authoritative record', async () => {
    const m = memento();
    const store = new WorkspaceStateStore(m);
    const run = sample();
    await store.compareAndSetConnectedRun(run, 0);

    const stale = appendAttempt(run, 'n-a', { queueItemId: 'q-2', startedAt: 12 });
    const first = await store.compareAndSetConnectedRun(stale, run.revision);
    expect(first.outcome).toBe('written');

    // Same write again — the revision it expects has moved on.
    const second = await store.compareAndSetConnectedRun(stale, run.revision);
    expect(second).toEqual({ outcome: 'stale', current: store.getConnectedRun('cr-1') });
  });

  it('refuses a create whose run already exists', async () => {
    const store = new WorkspaceStateStore(memento());
    await store.compareAndSetConnectedRun(sample(), 0);
    const again = await store.compareAndSetConnectedRun(sample(), 0);
    expect(again.outcome).toBe('stale');
  });

  it('accepts several composed mutations in one write, but never a revision that stood still', async () => {
    const store = new WorkspaceStateStore(memento());
    const run = sample();
    // `sample()` is already two mutations deep — created, then one attempt —
    // and lands in a single write, which is what a launch does.
    expect(run.revision).toBe(2);
    expect((await store.compareAndSetConnectedRun(run, 0)).outcome).toBe('written');
    expect((await store.compareAndSetConnectedRun(run, run.revision)).outcome).toBe('stale');
  });

  it('notifies subscribers only on an accepted write', async () => {
    const store = new WorkspaceStateStore(memento());
    const seen: string[] = [];
    store.subscribe((key) => seen.push(key));
    await store.compareAndSetConnectedRun(sample(), 0);
    await store.compareAndSetConnectedRun(sample(), 0);
    expect(seen).toEqual([KEYS.connectedRuns]);
  });

  it('serializes concurrent writes so exactly one wins (FR-047)', async () => {
    const store = new WorkspaceStateStore(memento());
    const run = sample();
    await store.compareAndSetConnectedRun(run, 0);

    const a = appendAttempt(run, 'n-a', { queueItemId: 'q-a', startedAt: 20 });
    const b = appendAttempt(run, 'n-a', { queueItemId: 'q-b', startedAt: 21 });
    const [first, second] = await Promise.all([
      store.compareAndSetConnectedRun(a, run.revision),
      store.compareAndSetConnectedRun(b, run.revision)
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(['stale', 'written']);
    expect(store.getConnectedRun('cr-1')?.nodes['n-a']?.attempts).toHaveLength(2);
  });

  it('clears connected runs on a workspace reset', async () => {
    const m = memento();
    const store = new WorkspaceStateStore(m);
    await store.compareAndSetConnectedRun(sample(), 0);
    await store.reset();
    expect(store.getConnectedRuns()).toEqual({});
  });
});
