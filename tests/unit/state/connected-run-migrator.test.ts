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
  STATE_SCHEMA_VERSION_V15
} from '../../../src/contracts/state-schema';
import { createComposableWorkflowRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import { migrateConnectedRuns } from '../../../src/state/connected-run-migrator';
import {
  appendAttempt,
  appendInputEnvelope,
  createConnectedRun,
  setPendingHandoff,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import { checkSupportedRunSchema } from '../../../src/state/workflow-run-migrator';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
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
    // forward-only ratchet asserted somewhere. Feature 093 moved the head
    // again, to v11, for the same reason and by the same edit; FR-R3-010's
    // per-queue history reshape moves it to v12 by that same edit once more, and
    // FR-R3-011's queue-pause collapse to v13, and FR-R3-117's host-verification
    // stamp to v14, and FR-R4-F02's credit-pause default to v15 -- each by this same edit, for
    // this same reason.
    expect(STATE_SCHEMA_VERSION_V9).toBe(9);
    expect(STATE_SCHEMA_VERSION).toBe(STATE_SCHEMA_VERSION_V15);
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

  // FR-R4-F08 (G8 of the 2026-11-01 close audit). The composer reads this collection on every pass
  // and once more for each Run card, and the sidebar's log sink kicks the projector for every line
  // the logger writes, so a WARN per read was a line per pass that caused the next pass. The
  // behaviour end to end is F-T9 in `tests/unit/ui/sidebar/projection-feedback.test.ts`; these pin
  // the rule at the store, where it lives, with the same shape as the Git-plan grant warning.
  describe('the dropped-record warning is about the set, not about the read (FR-R4-F08)', () => {
    const BAD = { connectedRunId: 'cr-bad', status: 'running' };

    function storeWithWarnSpy(
      m: Memento,
      warn: ReturnType<typeof vi.fn>
    ): WorkspaceStateStore {
      return new WorkspaceStateStore(m, {
        warn,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      } as unknown as ConstructorParameters<typeof WorkspaceStateStore>[1]);
    }

    it('names an unchanged set of dropped records once however often it is read', () => {
      const warn = vi.fn();
      const store = storeWithWarnSpy(memento({ [KEYS.connectedRuns]: { 'cr-bad': BAD } }), warn);

      for (let read = 0; read < 5; read += 1) expect(store.getConnectedRuns()).toEqual({});

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cr-bad'));
    });

    it('names a changed set again, and a set that returns after it cleared', () => {
      const warn = vi.fn();
      const m = memento({ [KEYS.connectedRuns]: { 'cr-bad': BAD } });
      const store = storeWithWarnSpy(m, warn);

      store.getConnectedRuns();
      store.getConnectedRuns();
      expect(warn, 'the first set, read twice').toHaveBeenCalledTimes(1);

      m.store.set(KEYS.connectedRuns, { 'cr-bad': BAD, 'cr-worse': { ...BAD, connectedRunId: 'cr-worse' } });
      store.getConnectedRuns();
      expect(warn, 'a second record fails').toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('cr-worse'));

      // The same number of records, a different one: the set is the identity, not its size.
      m.store.set(KEYS.connectedRuns, { 'cr-bad': BAD, 'cr-other': { ...BAD, connectedRunId: 'cr-other' } });
      store.getConnectedRuns();
      expect(warn, 'one record replaced by another').toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('cr-other'));

      m.store.set(KEYS.connectedRuns, {});
      store.getConnectedRuns();
      expect(warn, 'nothing is dropped, so nothing is said').toHaveBeenCalledTimes(3);

      m.store.set(KEYS.connectedRuns, { 'cr-bad': BAD, 'cr-other': { ...BAD, connectedRunId: 'cr-other' } });
      store.getConnectedRuns();
      expect(warn, 'the very same set failing again after it cleared is a new episode').toHaveBeenCalledTimes(4);
    });

    it('says nothing for a collection in which nothing is dropped', () => {
      const warn = vi.fn();
      const store = storeWithWarnSpy(
        memento({ [KEYS.connectedRuns]: { 'cr-good': JSON.parse(JSON.stringify(sample('cr-good'))) as unknown } }),
        warn
      );

      store.getConnectedRuns();
      store.getConnectedRuns();

      expect(warn).not.toHaveBeenCalled();
    });

    it('says why each record was refused, not only which one', () => {
      const warn = vi.fn();
      const store = storeWithWarnSpy(
        memento({
          [KEYS.connectedRuns]: {
            'cr-bad': BAD,
            'cr-old': { schemaVersion: 5, connectedRunId: 'cr-old' }
          }
        }),
        warn
      );

      store.getConnectedRuns();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cr-bad (invariant-violation)'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cr-old (unsupported-run-schema-version)')
      );
    });

    it('bounds the line however many records were refused, and counts the rest', () => {
      const REFUSED_COUNT = 500;
      const collection = Object.fromEntries(
        Array.from({ length: REFUSED_COUNT }, (_, index) => [
          `cr-bad-${index}`,
          { ...BAD, connectedRunId: `cr-bad-${index}` }
        ])
      );
      const warn = vi.fn();
      const store = storeWithWarnSpy(memento({ [KEYS.connectedRuns]: collection }), warn);

      store.getConnectedRuns();

      const line = String(warn.mock.calls.at(0)?.at(0));
      expect(line).toContain(`${REFUSED_COUNT} connected run(s)`);
      expect(line).toContain('cr-bad-0 (invariant-violation)');
      expect(line, 'past the cap').not.toContain('cr-bad-20 ');
      expect(line).toContain(`and ${REFUSED_COUNT - 20} more`);
    });

    it('clips an absurdly long key in the diagnostic rather than copying it into the log', () => {
      const LONG_KEY = 'k'.repeat(10_000);
      const migrated = migrateConnectedRuns({ [LONG_KEY]: BAD });

      expect(migrated.dropped).toEqual([LONG_KEY]);
      expect(migrated.diagnostics.at(0)?.connectedRunId.length).toBeLessThan(200);
    });
  });

  // Feature 261 FR-011: an unsupported shape is rejected or quarantined "without auto-deleting
  // developer state files". Reads hide such a record; a read-modify-write of the collection built
  // from what reads return would erase it on the next unrelated launch, so both writes carry it.
  describe('a refused record stays in the key until an explicit reset (feature 261 FR-011)', () => {
    const LEGACY = { schemaVersion: 5, featureId: 'legacy-feature', phases: [{ id: 'old' }] };
    const INVALID = { connectedRunId: 'cr-bad', status: 'in-flight' };
    const REFUSED = { 'cr-legacy': LEGACY, 'cr-bad': INVALID };

    function seededWithRefusedRecords(): {
      readonly m: ReturnType<typeof memento>;
      readonly store: WorkspaceStateStore;
    } {
      const m = memento({ [KEYS.connectedRuns]: REFUSED });
      return { m, store: new WorkspaceStateStore(m) };
    }

    it('survives a compare-and-set of an unrelated run, byte for byte', async () => {
      const { m, store } = seededWithRefusedRecords();

      const written = await store.compareAndSetConnectedRun(sample('cr-new'), 0);

      expect(written.outcome).toBe('written');
      expect(m.store.get(KEYS.connectedRuns)).toEqual(expect.objectContaining(REFUSED));
      expect(Object.keys(store.getConnectedRuns())).toEqual(['cr-new']);
    });

    it('survives every later write, not only the first one', async () => {
      const { m, store } = seededWithRefusedRecords();
      const first = sample('cr-new');
      await store.compareAndSetConnectedRun(first, 0);

      const second = appendAttempt(first, 'n-a', { queueItemId: 'q-2', startedAt: 12 });
      await store.compareAndSetConnectedRun(second, first.revision);

      expect(m.store.get(KEYS.connectedRuns)).toEqual(expect.objectContaining(REFUSED));
    });

    it('survives deleting an unrelated run', async () => {
      const { m, store } = seededWithRefusedRecords();
      await store.compareAndSetConnectedRun(sample('cr-new'), 0);

      expect(await store.deleteConnectedRuns(['cr-new'])).toBe(1);

      expect(m.store.get(KEYS.connectedRuns)).toEqual(REFUSED);
      expect(store.getConnectedRuns()).toEqual({});
    });

    it('is not counted as removed, and not removed, when a delete names it', async () => {
      const { m, store } = seededWithRefusedRecords();

      expect(await store.deleteConnectedRuns(['cr-bad'])).toBe(0);

      expect(m.store.get(KEYS.connectedRuns)).toEqual(REFUSED);
    });

    it('is not replaced by a write that happens to reuse its id', async () => {
      const { m, store } = seededWithRefusedRecords();

      const written = await store.compareAndSetConnectedRun(sample('cr-bad'), 0);

      expect(written).toEqual({ outcome: 'stale', current: null });
      expect(m.store.get(KEYS.connectedRuns)).toEqual(REFUSED);
    });

    it('stays hidden from every read while it is kept', async () => {
      const { store } = seededWithRefusedRecords();
      await store.compareAndSetConnectedRun(sample('cr-new'), 0);

      expect(store.getConnectedRun('cr-bad')).toBeNull();
      expect(store.getConnectedRun('cr-legacy')).toBeNull();
    });

    it('is cleared by an explicit workspace reset', async () => {
      const { m, store } = seededWithRefusedRecords();

      await store.reset();

      expect(m.store.has(KEYS.connectedRuns)).toBe(false);
    });

    it('returns the raw value for a key the prototype setter would otherwise swallow', () => {
      const raw = JSON.parse('{"__proto__":{"connectedRunId":"__proto__"}}') as unknown;

      const migrated = migrateConnectedRuns(raw);

      expect(Object.keys(migrated.refused)).toEqual(['__proto__']);
    });
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

  it('round-trips new-schema composable Workflow runs (frozenClosure, invocations, inputEnvelopes, pendingHandoff) and refuses unsupported legacy shapes with bounded diagnostics (FR-R5-F02)', async () => {
    const phaseSpec: PhaseDefinition = {
      phaseId: 'phase-spec',
      name: 'Spec Phase',
      version: 1,
      instruction: '/speckit.specify'
    };
    const rootWf: WorkflowDefinition = {
      workflowId: 'wf-root',
      name: 'Root Workflow',
      version: 1,
      inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
      outputs: [{ portId: 'finalSpec', label: 'Final Spec', type: 'file-set', required: true }],
      startNodeIds: ['node-spec'],
      nodes: [
        {
          nodeId: 'node-spec',
          kind: 'phase',
          phaseId: 'phase-spec'
        }
      ],
      connections: [],
      bindings: [
        {
          kind: 'input',
          nodeId: 'node-spec',
          inputKey: 'featureDescription',
          source: { from: 'workflow-input', portId: 'featureDescription' }
        },
        {
          kind: 'output',
          portId: 'finalSpec',
          nodeId: 'node-spec',
          outputKey: 'specDir'
        }
      ]
    };

    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'crun-composable-1',
      workflow: rootWf,
      entryNodeId: 'node-spec',
      effectivePhases: [phaseSpec],
      boundInputs: {
        featureDescription: {
          portId: 'featureDescription',
          type: 'text',
          value: 'Persist composable run'
        }
      },
      startedAt: 1000
    });
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    let composableRun = created.run;
    composableRun = appendInputEnvelope(composableRun, {
      envelopeId: 'env-1',
      invocationId: created.rootInvocationId,
      targetNodeId: 'node-spec',
      source: 'manual-continuation',
      inputsByPort: Object.freeze({
        featureDescription: Object.freeze({
          portId: 'featureDescription',
          type: 'text',
          value: 'Override'
        })
      }),
      localInputs: Object.freeze([]),
      outputTargetOverrides: Object.freeze([]),
      acceptedAt: 1200
    });
    composableRun = setPendingHandoff(composableRun, {
      invocationId: created.rootInvocationId,
      fromNodeId: 'node-spec',
      fromAttemptId: 'att-1',
      connectionIndex: 0,
      target: { kind: 'return' },
      prefilledInputsByPort: Object.freeze({}),
      pausedAt: 1300
    });

    const m = memento();
    const store = new WorkspaceStateStore(m);
    const written = await store.compareAndSetConnectedRun(composableRun, 0);
    expect(written.outcome).toBe('written');

    const reloaded = store.getConnectedRun('crun-composable-1');
    expect(reloaded).toEqual(composableRun);
    expect(Object.isFrozen(reloaded?.frozenClosure)).toBe(true);
    expect(Object.isFrozen(reloaded?.invocations)).toBe(true);
    expect(Object.isFrozen(reloaded?.inputEnvelopes)).toBe(true);

    // Verify bounded refusal diagnostics for unsupported legacy schema shapes
    const rawWithLegacy: Record<string, unknown> = {
      'crun-composable-1': JSON.parse(JSON.stringify(composableRun)),
      'legacy-pipeline-1': { id: 'legacy-pipeline-1', featureId: 'feat-1', status: 'completed' },
      'legacy-versioned': { connectedRunId: 'legacy-versioned', schemaVersion: 1 }
    };
    const migrated = migrateConnectedRuns(rawWithLegacy);
    expect(Object.keys(migrated.runs)).toEqual(['crun-composable-1']);
    expect(migrated.diagnostics).toEqual([
      { connectedRunId: 'legacy-pipeline-1', reason: 'unsupported-run-schema-version' },
      { connectedRunId: 'legacy-versioned', reason: 'unsupported-run-schema-version' }
    ]);
    expect(checkSupportedRunSchema({ schemaVersion: 1 })).toEqual({
      supported: false,
      reason: 'unsupported-run-schema-version'
    });
  });
});
