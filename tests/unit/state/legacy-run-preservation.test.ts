// Feature 089 (T020, T021, US4, FR-021, FR-022, FR-023, FR-024, SC-006) — a run
// persisted before this platform survives the upgrade intact.
//
// The fixture holds three runs, because the three have different things to lose:
//
//   **completed** — its evidence. A finished run is read for its record, and the
//   record is `phasesCompleted[]`: what ran, in which iteration, with what
//   outcome, and the `auditEntryId` linking each entry to the audit log. Lose
//   that and the run is still "there" while everything it is consulted for is
//   gone.
//
//   **failed** — its diagnosis. `lastError`, the terminal status, and the retry
//   counters are why the operator opens it at all.
//
//   **mid-phase-paused** — its recovery actions (FR-022). This is the in-flight
//   case, and it is the one an upgrade is most likely to break: the pause pair,
//   the breakpoint list, the resume target, and the per-run overrides together
//   decide what the run *offers* after the restart. Preserve the fields and the
//   offered actions follow; drop one and the operator's only way back into a
//   half-finished run quietly disappears.
//
// All three are asserted **field by field** rather than by deep-equality against
// a golden object. A deep-equal would pass just as happily if the migrator
// invented a field nobody wanted, and would fail for reasons that have nothing
// to do with preservation the first time an unrelated additive field lands. The
// key-set check that follows each is what closes that gap deliberately.
//
// The frozen Pipeline snapshot gets its own assertion for the reason the
// standing invariant states: an in-flight `WorkflowRun.pipeline` is never
// mutated or retargeted, and a migration is exactly the moment someone would be
// tempted to "refresh" it against the current catalog.

import { describe, expect, it } from 'vitest';
import { migrateLegacyRun } from '../../../src/state/workflow-run-migrator';
import { migrateConnectedRuns } from '../../../src/state/connected-run-migrator';
import {
  WorkspaceStateStore,
  KEYS,
  SCHEMA_VERSION,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION_V8 } from '../../../src/contracts/state-schema';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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
  raw(key: string): unknown {
    return this.map.get(key);
  }
}

/** The frozen snapshot every fixture run carries. Two Phases, authored ids. */
const SNAPSHOT = {
  id: 'legacy-flow',
  name: 'Legacy Flow',
  version: 1,
  phases: [
    { id: 'legacy-draft', name: 'Legacy Draft', version: 1, instruction: 'Draft.' },
    { id: 'legacy-review', name: 'Legacy Review', version: 1, instruction: 'Review.' }
  ]
} as const;

/** One completed Phase, with its audit link — the evidence half of FR-021. */
const DRAFT_RESULT = {
  phase: 'legacy-draft',
  iteration: 1,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  result: 'clean',
  terminationReason: 'completed',
  exitCode: 0,
  stdoutSummary: 'drafted',
  stderrSummary: '',
  auditEntryId: 'audit-legacy-draft-1'
} as const;

const REVIEW_RESULT = {
  phase: 'legacy-review',
  iteration: 1,
  startedAt: 1_700_000_060_000,
  endedAt: 1_700_000_120_000,
  result: 'clean',
  terminationReason: 'completed',
  exitCode: 0,
  stdoutSummary: 'reviewed',
  stderrSummary: '',
  auditEntryId: 'audit-legacy-review-1'
} as const;

/**
 * A run record as it was written before this platform: no `phaseOverrides`, no
 * `phaseBreakpoints`, no `resumeTargetPhaseId`, no `rawTranscriptMode`, no
 * `mutationPlan`, and no port-era fields at all.
 */
function legacyRun(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'run-legacy',
    featureId: 'feature-legacy',
    featureDir: 'specs/001-legacy',
    status: 'completed',
    currentPhase: 'legacy-review',
    currentIteration: 1,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_120_000,
    phasesCompleted: [{ ...DRAFT_RESULT }, { ...REVIEW_RESULT }],
    lastError: null,
    pipeline: JSON.parse(JSON.stringify(SNAPSHOT)) as unknown,
    ...overrides
  };
}

const COMPLETED = legacyRun({});

const FAILED = legacyRun({
  id: 'run-legacy-failed',
  status: 'failed',
  currentPhase: 'legacy-review',
  phasesCompleted: [
    { ...DRAFT_RESULT },
    {
      ...REVIEW_RESULT,
      result: 'blocked',
      terminationReason: 'fatal',
      exitCode: 1,
      stdoutSummary: 'blocked',
      auditEntryId: 'audit-legacy-review-fail'
    }
  ],
  lastError: { message: 'phase reported a fatal signature', code: 'fatal-signature' },
  delayedRetryCount: 2
});

/**
 * The in-flight one: paused mid-Phase by the operator, with a retry already
 * scheduled. Both pairs are two-sided, which is what the invariant requires and
 * what makes this record a real test of the pair logic rather than of its
 * defaults.
 */
const PAUSED = legacyRun({
  id: 'run-legacy-paused',
  status: 'paused',
  currentPhase: 'legacy-review',
  phasesCompleted: [{ ...DRAFT_RESULT }],
  manualPauseAt: 1_700_000_090_000,
  manualPauseCause: 'operator-paused',
  pendingRetryAt: 1_700_000_600_000,
  pendingRetryCause: 'rate_limit',
  delayedRetryCount: 1
});

/** Fields whose value the migration must carry through untouched. */
const IDENTITY_FIELDS = [
  'id',
  'featureId',
  'featureDir',
  'currentPhase',
  'currentIteration',
  'startedAt',
  'lastTransitionAt'
] as const;

function migrated(record: Record<string, unknown>): WorkflowRun {
  const result = migrateLegacyRun(record);
  if (result === null) throw new Error('fixture record did not migrate');
  return result;
}

describe('a run persisted before this platform survives migration (T020, FR-021, SC-006)', () => {
  it.each([
    ['completed', COMPLETED],
    ['failed', FAILED],
    ['mid-phase-paused', PAUSED]
  ])('preserves the identity of a %s run field by field', (_label, record) => {
    const run = migrated(record) as unknown as Record<string, unknown>;
    for (const field of IDENTITY_FIELDS) {
      expect(run[field]).toEqual(record[field]);
    }
    expect(run.status).toBe(record.status);
    expect(run.lastError).toEqual(record.lastError);
  });

  it.each([
    ['completed', COMPLETED],
    ['failed', FAILED],
    ['mid-phase-paused', PAUSED]
  ])('preserves the frozen Pipeline snapshot of a %s run, unretargeted', (_label, record) => {
    const run = migrated(record);
    // Not "a snapshot of the same Pipeline" — the same snapshot, Phase for
    // Phase, in order. Refreshing this against the current catalog is the
    // failure the standing invariant forbids.
    expect(run.pipeline).toEqual(SNAPSHOT);
    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual([
      'legacy-draft',
      'legacy-review'
    ]);
  });

  it.each([
    ['completed', COMPLETED],
    ['failed', FAILED],
    ['mid-phase-paused', PAUSED]
  ])('preserves phase progress and evidence links of a %s run', (_label, record) => {
    const run = migrated(record);
    const stored = record.phasesCompleted as readonly Record<string, unknown>[];

    expect(run.phasesCompleted).toHaveLength(stored.length);
    run.phasesCompleted.forEach((entry, index) => {
      const source = stored[index]!;
      expect(entry.phase).toBe(source.phase);
      expect(entry.iteration).toBe(source.iteration);
      expect(entry.startedAt).toBe(source.startedAt);
      expect(entry.endedAt).toBe(source.endedAt);
      expect(entry.result).toBe(source.result);
      expect(entry.terminationReason).toBe(source.terminationReason);
      expect(entry.exitCode).toBe(source.exitCode);
      // The evidence link. A migration that renumbered or dropped it would
      // leave the run readable and its audit trail unreachable.
      expect(entry.auditEntryId).toBe(source.auditEntryId);
    });
  });

  it('preserves the recovery actions an in-flight run offered (FR-022)', () => {
    const run = migrated(PAUSED);

    // The pause pair, two-sided as persisted — the resume action is offered off
    // exactly this pair.
    expect(run.manualPauseAt).toBe(1_700_000_090_000);
    expect(run.manualPauseCause).toBe('operator-paused');
    // The retry pair, likewise: the scheduled retry is what the run is waiting
    // on, and its cause is what the operator is told it is waiting for.
    expect(run.pendingRetryAt).toBe(1_700_000_600_000);
    expect(run.pendingRetryCause).toBe('rate_limit');
    expect(run.delayedRetryCount).toBe(1);
    // Absent before this platform, defaulted rather than left undefined — a
    // consumer that reads `.length` must not have to guard.
    expect(run.phaseOverrides).toEqual([]);
    expect(run.phaseBreakpoints).toEqual([]);
    expect(run.resumeTargetPhaseId).toBeNull();
    // A run written before transcript retention was frozen keeps the historical
    // behavior rather than silently adopting today's default.
    expect(run.rawTranscriptMode).toBe('always');
  });

  it('adds only the fields the forward chain declares, and drops none', () => {
    const before = new Set(Object.keys(PAUSED));
    const after = new Set(Object.keys(migrated(PAUSED) as unknown as object));

    for (const key of before) {
      expect(after.has(key)).toBe(true);
    }
    // Stated as an exact set: a field added here without a `STATE_SCHEMA_VERSION`
    // step is the shape change FR-025 forbids shipping unversioned, and
    // `release-qualification.test.ts` is where that pin lives.
    expect([...after].filter((key) => !before.has(key)).sort()).toEqual([
      'mutationPlan',
      'phaseBreakpoints',
      'phaseOverrides',
      'rawTranscriptMode',
      'resumeTargetPhaseId'
    ]);
  });

  it('carries an in-flight run through a real store open without rewriting it', async () => {
    const memento = new FakeMemento();
    // A workspace last written at v8: the run key holds the legacy record, and
    // nothing else about the workspace has been touched.
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V8);
    await memento.update(KEYS.run, JSON.parse(JSON.stringify(PAUSED)));

    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    const run = store.getRun(DEFAULT_QUEUE_ID);
    expect(run).not.toBeNull();
    expect(run!.id).toBe('run-legacy-paused');
    expect(run!.status).toBe('paused');
    expect(run!.pipeline).toEqual(SNAPSHOT);
    expect(run!.phasesCompleted.map((entry) => entry.auditEntryId)).toEqual([
      'audit-legacy-draft-1'
    ]);
    expect(run!.manualPauseCause).toBe('operator-paused');
    expect(run!.pendingRetryCause).toBe('rate_limit');
    // The open advanced the version, which is the forward-only step itself.
    expect(memento.raw(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });
});

describe('migration is forward-only and idempotent (T021, FR-023)', () => {
  it.each([
    ['completed', COMPLETED],
    ['failed', FAILED],
    ['mid-phase-paused', PAUSED]
  ])('re-migrating an already-migrated %s run changes nothing', (_label, record) => {
    const once = migrated(record);
    const twice = migrateLegacyRun(JSON.parse(JSON.stringify(once)) as unknown);
    expect(twice).toEqual(once);
  });

  it('re-opening an already-migrated workspace leaves the run untouched', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V8);
    await memento.update(KEYS.run, JSON.parse(JSON.stringify(PAUSED)));

    const first = new WorkspaceStateStore(memento);
    await first.initialize();
    const afterFirst = JSON.parse(JSON.stringify(memento.raw(KEYS.run))) as unknown;

    // Second open of the same workspace, now at the current version.
    const second = new WorkspaceStateStore(memento);
    const result = await second.initialize();

    expect(memento.raw(KEYS.run)).toEqual(afterFirst);
    expect(result.migrated).toBe(false);
    expect(result.runRepairEvents).toEqual([]);
  });
});

describe('a record that fails the current invariants is set aside, not fatal (T021, FR-024)', () => {
  /** A connected run that satisfies every invariant — the surviving sibling. */
  function validConnectedRun(connectedRunId: string): unknown {
    const graph = Object.freeze({
      workflowId: 'legacy-workflow',
      name: 'Legacy Workflow',
      version: 1,
      nodes: Object.freeze([Object.freeze({ nodeId: 'n1', pipelineId: 'legacy-flow' })]),
      connections: Object.freeze([]),
      startNodeIds: Object.freeze(['n1'])
    });
    return {
      connectedRunId,
      workflowId: 'legacy-workflow',
      graph,
      pipelines: Object.freeze({}),
      nodes: {},
      decisions: [],
      revision: 1,
      startedAt: 1_700_000_000_000
    };
  }

  it('names the offending record and keeps its siblings', () => {
    const result = migrateConnectedRuns({
      'run-a': validConnectedRun('run-a'),
      // Revision zero: a positive integer is the aggregate's own invariant.
      'run-bad': { ...(validConnectedRun('run-bad') as object), revision: 0 },
      'run-b': validConnectedRun('run-b')
    });

    expect(Object.keys(result.runs).sort()).toEqual(['run-a', 'run-b']);
    // Reported, not silently discarded — the id is host-generated, so naming it
    // leaks nothing and gives the operator something to act on.
    expect(result.dropped).toEqual(['run-bad']);
    // Evidence is not erased on the way past: the two intact records still hold
    // everything they held.
    expect(result.runs['run-a']!.graph.nodes[0]!.nodeId).toBe('n1');
    expect(result.runs['run-b']!.revision).toBe(1);
  });

  it('reads an absent connected-run key as empty on a pre-platform workspace', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V8);
    await memento.update(KEYS.run, JSON.parse(JSON.stringify(COMPLETED)));

    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    // Absent is empty, not an error and not a reason to refuse to open — this is
    // the state of every workspace that predates the aggregate.
    expect(store.getConnectedRuns()).toEqual({});
    expect(store.getConnectedRun('anything')).toBeNull();
    // And the step wrote nothing under the key it did not need.
    expect(memento.raw(KEYS.connectedRuns)).toBeUndefined();
  });
});
