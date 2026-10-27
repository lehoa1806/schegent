// FR-R4-F01 (spec 239, US4, T056, FR-016 to FR-019, SC-004, contract V2) — an upgraded workspace
// keeps each Run's verdict basis.
//
// `initialize()` over real persisted shapes in an in-memory `Memento`. At `ebf589fa` a v13
// workspace with a paused Run stamped schema 14 and left every frozen Phase without
// `hostVerification`: `migrateV13ToV14` was pure and correct and nothing called it. A Run resumed
// after the upgrade then read the ABSENT field under the new rule, and the Phases its snapshot
// said would advance on the model's own account were judged on their exit status.
//
// The step is keyed on the SHAPE of each frozen Phase, not on the persisted number, so it also
// repairs a workspace an earlier v14 build stamped without migrating.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION_V13 } from '../../../src/contracts/state-schema';
import type { QueueState } from '../../../src/queue/feature-request';
import type { TerminalTransitionIntent, WorkflowRun } from '../../../src/state/workflow-run';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import {
  buildQueueRegistry,
  buildV9QueueState,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  /** Keys whose next `update()` rejects. Consumed on use. */
  public readonly failOnce = new Set<string>();
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

const OTHER_QUEUE = fixtureQueueId(2);
const taskIdFor = (queueId: string): string => `${queueId}-task`;

const phase = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  instruction: `/${id}`,
  sideEffects: 'workspace',
  ...extra
});

/** The three frozen shapes an upgrade meets, plus the one no production freeze writes. */
const LEGACY_DEFAULT = phase('legacy-default');
const LEGACY_AUTHORED = phase('legacy-authored', { hostVerification: 'exit-code' });
const CURRENT = phase('current', {
  hostVerification: 'exit-code',
  hostVerificationDeclaredAt: 'phase-definition'
});
const UNKNOWN = phase('unknown', { hostVerificationDeclaredAt: 'default' });

function frozenRun(
  queueId: string,
  status: WorkflowRun['status'],
  phases: readonly Record<string, unknown>[]
): WorkflowRun {
  const base = buildWorkflowRun({ id: `run-${queueId.slice(0, 4)}`, featureId: taskIdFor(queueId), status });
  const snapshot = { id: 'p', name: 'p', phases };
  return {
    ...base,
    pipeline: snapshot,
    envelope: { pipeline: snapshot }
  } as unknown as WorkflowRun;
}

/** A complete workspace at `numeric`, with one in-flight Task per queue so no Run is orphaned. */
function seedWorkspace(
  memento: FakeMemento,
  numeric: number,
  runs: Record<string, WorkflowRun>,
  intents?: Record<string, TerminalTransitionIntent>
): void {
  const registry = buildQueueRegistry({ count: 2, defaultAtPosition: 0 });
  const queueMap: Record<string, QueueState> = {};
  for (const entry of registry.entries) {
    const { paused: _collapsedMirror, ...state } = buildV9QueueState({ pendingCount: 0 });
    queueMap[entry.id] = {
      ...state,
      queueLifecycle: 'running',
      pauseSource: null,
      requests: [
        {
          id: taskIdFor(entry.id),
          description: 'the Task',
          enqueuedAt: 1,
          createdAt: 1,
          startedAt: 1,
          updatedAt: 1,
          completedAt: null,
          status: 'in-flight',
          queueId: entry.id,
          position: 0,
          pauseCause: null,
          runId: (runs as Record<string, WorkflowRun | undefined>)[entry.id]?.id ?? null,
          retryCount: 0,
          lastError: null,
          pausedReason: null
        }
      ] as QueueState['requests'],
      inFlightId: taskIdFor(entry.id)
    };
  }
  memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
  memento.seed(KEYS.schemaVersionNumeric, numeric);
  memento.seed(KEYS.queueRegistry, registry);
  memento.seed(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  memento.seed(KEYS.queue, queueMap);
  memento.seed(KEYS.run, runs);
  if (intents !== undefined) memento.seed(KEYS.terminalTransitionIntent, intents);
}

const phasesOf = (run: WorkflowRun | undefined): readonly Record<string, unknown>[] =>
  (run?.pipeline as unknown as { phases: readonly Record<string, unknown>[] }).phases;
const envelopePhasesOf = (run: WorkflowRun | undefined): readonly Record<string, unknown>[] =>
  (run?.envelope as unknown as { pipeline: { phases: readonly Record<string, unknown>[] } }).pipeline
    .phases;
const phaseById = (phases: readonly Record<string, unknown>[], id: string) =>
  phases.find((candidate) => candidate.id === id);

const runMapOf = (memento: FakeMemento): Record<string, WorkflowRun> =>
  memento.get<Record<string, WorkflowRun>>(KEYS.run) ?? {};
const bytes = (memento: FakeMemento, key: string): string => JSON.stringify(memento.get(key) ?? null);

let memento: FakeMemento;

beforeEach(() => {
  memento = new FakeMemento();
});

describe('a v13 workspace is migrated before it is stamped (US4 #1, #2)', () => {
  it('gives every Phase of a paused Run and a failed Run its legacy basis, then stamps 14', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION_V13, {
      [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [LEGACY_DEFAULT, LEGACY_AUTHORED, CURRENT]),
      [OTHER_QUEUE]: frozenRun(OTHER_QUEUE, 'failed', [LEGACY_DEFAULT, LEGACY_AUTHORED])
    });

    await new WorkspaceStateStore(memento).initialize();

    const runs = runMapOf(memento);
    for (const queueId of [DEFAULT_QUEUE_ID, OTHER_QUEUE]) {
      for (const phases of [phasesOf(runs[queueId]), envelopePhasesOf(runs[queueId])]) {
        expect(phaseById(phases, 'legacy-default')).toMatchObject({
          hostVerification: 'model-token',
          hostVerificationDeclaredAt: 'default'
        });
        expect(phaseById(phases, 'legacy-authored')).toMatchObject({
          hostVerification: 'exit-code',
          hostVerificationDeclaredAt: 'phase-definition'
        });
      }
    }
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });

  it('leaves a Phase frozen by a v14 build unchanged', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION_V13, {
      [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [CURRENT])
    });
    const before = JSON.stringify(phasesOf(runMapOf(memento)[DEFAULT_QUEUE_ID]));

    await new WorkspaceStateStore(memento).initialize();

    expect(JSON.stringify(phasesOf(runMapOf(memento)[DEFAULT_QUEUE_ID]))).toBe(before);
  });

  it('handles a workspace with no Runs, and Runs on several queues', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION_V13, {});
    const empty = await new WorkspaceStateStore(memento).initialize();
    expect(empty.v14MigrationEvents).toEqual([]);
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);

    const several = new FakeMemento();
    seedWorkspace(several, STATE_SCHEMA_VERSION_V13, {
      [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [LEGACY_DEFAULT]),
      [OTHER_QUEUE]: frozenRun(OTHER_QUEUE, 'paused', [LEGACY_AUTHORED])
    });
    const result = await new WorkspaceStateStore(several).initialize();
    expect(result.v14MigrationEvents.map((event) => event.queueId).sort()).toEqual(
      [DEFAULT_QUEUE_ID, OTHER_QUEUE].sort()
    );
  });
});

describe('the step is keyed on shape, not on the persisted number (US4 #3, FR-017)', () => {
  it('repairs a workspace an earlier v14 build stamped without migrating', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION, {
      [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [LEGACY_DEFAULT, LEGACY_AUTHORED])
    });

    const result = await new WorkspaceStateStore(memento).initialize();

    const phases = phasesOf(runMapOf(memento)[DEFAULT_QUEUE_ID]);
    expect(phaseById(phases, 'legacy-default')).toMatchObject({ hostVerification: 'model-token' });
    expect(phaseById(phases, 'legacy-authored')).toMatchObject({
      hostVerificationDeclaredAt: 'phase-definition'
    });
    expect(result.migrated).toBe(true);
  });

  it('repairs a Run inside the terminal-transition journal too', async () => {
    const run = frozenRun(DEFAULT_QUEUE_ID, 'completed', [LEGACY_DEFAULT]);
    seedWorkspace(memento, STATE_SCHEMA_VERSION, {}, {
      [run.id]: { schemaVersion: 1, run, createdAt: 5 }
    });

    const result = await new WorkspaceStateStore(memento).initialize();

    const journalled = memento.get<Record<string, TerminalTransitionIntent>>(
      KEYS.terminalTransitionIntent
    )![run.id]!;
    expect(phaseById(phasesOf(journalled.run), 'legacy-default')).toMatchObject({
      hostVerification: 'model-token',
      hostVerificationDeclaredAt: 'default'
    });
    expect(result.v14MigrationEvents).toMatchObject([
      { type: 'verdict-basis-migrated', runId: run.id, queueId: null, legacyDefault: 1 }
    ]);
  });
});

describe('the step is idempotent and safe to interrupt (US4 #4, FR-018)', () => {
  const legacyWorkspace = (target: FakeMemento): void =>
    seedWorkspace(
      target,
      STATE_SCHEMA_VERSION_V13,
      {
        [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [LEGACY_DEFAULT, LEGACY_AUTHORED]),
        [OTHER_QUEUE]: frozenRun(OTHER_QUEUE, 'failed', [LEGACY_DEFAULT])
      },
      {}
    );

  it('a second initialize() changes no byte of KEYS.run or the journal, and writes neither', async () => {
    legacyWorkspace(memento);
    await new WorkspaceStateStore(memento).initialize();
    const runBytes = bytes(memento, KEYS.run);
    const journalBytes = bytes(memento, KEYS.terminalTransitionIntent);
    memento.writes.length = 0;

    const again = await new WorkspaceStateStore(memento).initialize();

    expect(bytes(memento, KEYS.run)).toBe(runBytes);
    expect(bytes(memento, KEYS.terminalTransitionIntent)).toBe(journalBytes);
    expect(memento.writes).not.toContain(KEYS.run);
    expect(memento.writes).not.toContain(KEYS.terminalTransitionIntent);
    expect(again.v14MigrationEvents).toEqual([]);
  });

  it('a write that throws leaves the persisted version at 13, and a re-run equals an uninterrupted run', async () => {
    legacyWorkspace(memento);
    memento.failOnce.add(KEYS.run);

    await expect(new WorkspaceStateStore(memento).initialize()).rejects.toThrow(/failed/);
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION_V13);

    await new WorkspaceStateStore(memento).initialize();
    const uninterrupted = new FakeMemento();
    legacyWorkspace(uninterrupted);
    await new WorkspaceStateStore(uninterrupted).initialize();

    expect(bytes(memento, KEYS.run)).toBe(bytes(uninterrupted, KEYS.run));
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });
});

describe('a Phase no production freeze could have written is disclosed once (US4 #5, FR-019)', () => {
  it('yields one provenance-unknown event on the first initialize() and none on the second', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION_V13, {
      [OTHER_QUEUE]: frozenRun(OTHER_QUEUE, 'paused', [UNKNOWN, CURRENT])
    });

    const first = await new WorkspaceStateStore(memento).initialize();
    const second = await new WorkspaceStateStore(memento).initialize();

    expect(first.v14MigrationEvents).toEqual([
      {
        type: 'verdict-basis-provenance-unknown',
        runId: `run-${OTHER_QUEUE.slice(0, 4)}`,
        queueId: OTHER_QUEUE,
        phaseCount: 1
      }
    ]);
    expect(second.v14MigrationEvents).toEqual([]);
    // The undatable Phase keeps the policy the runtime already applied, written explicitly.
    expect(phaseById(phasesOf(runMapOf(memento)[OTHER_QUEUE]), 'unknown')).toMatchObject({
      hostVerification: 'exit-code',
      hostVerificationDeclaredAt: 'default'
    });
  });

  it('reports a migrated Run with the counts of its legacy Phases, and no notification event', async () => {
    seedWorkspace(memento, STATE_SCHEMA_VERSION_V13, {
      [DEFAULT_QUEUE_ID]: frozenRun(DEFAULT_QUEUE_ID, 'paused', [
        LEGACY_DEFAULT,
        LEGACY_AUTHORED,
        CURRENT
      ])
    });

    const result = await new WorkspaceStateStore(memento).initialize();

    expect(result.v14MigrationEvents).toEqual([
      {
        type: 'verdict-basis-migrated',
        runId: `run-${DEFAULT_QUEUE_ID.slice(0, 4)}`,
        queueId: DEFAULT_QUEUE_ID,
        legacyAuthored: 1,
        legacyDefault: 1
      }
    ]);
  });
});
