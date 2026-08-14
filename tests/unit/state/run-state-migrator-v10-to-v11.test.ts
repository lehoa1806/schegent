// Feature 093 (T004, T030-T032) — the v10 → v11 forward migration.
//
// v11 pluralises `KEYS.run`: `WorkflowRun | null` becomes
// `Record<queueId, WorkflowRun>`, the shape that lets more than one queue hold
// an executing Run at once. It is the exact complement of v9 → v10, which
// pluralised `KEYS.queue` and left `KEYS.run` alone — the two migrations never
// overlap a key.
//
// The corpus below is the evidence for contracts/state-schema-v11.md §2 rather
// than a happy-path sample, because a defect here is not recoverable by
// downgrading. Each guarantee is pinned separately:
//
//   1. only `KEYS.run` is read or written
//   2. `WorkflowRun` fields survive the reshape byte-for-byte
//   3. an already-v11 record reports `changed: false`, so no write is performed
//   4. a Run whose Task resolves to no queue is REASSIGNED to the default
//      queue with a recorded reason — never dropped
//   5. an unrecognised record is repaired to `{}` rather than guessed at
//   6. audit payloads carry identifiers and closed reason codes only
//
// Guarantee 1 is checked at the *signature* level: the migrator is a pure
// function over the run record with no store, so there is nothing it could
// reach `KEYS.queue` from. That is stronger than asserting a mock went
// uncalled, and it is why the migrator is pure — the same argument
// `queue-state-migrator-v9-to-v10.test.ts` makes in the other direction.

import { describe, it, expect } from 'vitest';
import {
  migrateV10ToV11,
  type RunStateMap,
  type RunStateMigrationAuditEvent
} from '../../../src/state/run-state-migrator';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { STATE_SCHEMA_VERSION_V11 } from '../../../src/contracts/state-schema';
import {
  FIXTURE_NOW,
  buildV9QueueState,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const NOW = FIXTURE_NOW;
const QUEUE_A = fixtureQueueId(1);
const QUEUE_B = fixtureQueueId(2);

/** The task→queue resolver the store injects, standing in for the registry. */
const RESOLVES = (taskId: string): string | null => (taskId === 'task-0' ? QUEUE_A : null);
const RESOLVES_NOTHING = (): string | null => null;

function eventTypes(events: readonly RunStateMigrationAuditEvent[]): string[] {
  return events.map((e) => e.type);
}

interface CorpusRow {
  readonly label: string;
  readonly raw: unknown;
  readonly resolve: (taskId: string) => string | null;
  readonly expectedKeys: readonly string[];
  readonly changed: boolean;
  readonly expectedEvents: readonly string[];
}

/**
 * One row per line of contracts/state-schema-v11.md §2, plus the shapes a real
 * workspace can actually hold at `KEYS.run`. A single fixture cannot evidence a
 * claim about *every* workspace.
 */
const CORPUS: readonly CorpusRow[] = [
  {
    label: 'absent record — null',
    raw: null,
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11']
  },
  {
    label: 'absent record — undefined',
    raw: undefined,
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11']
  },
  {
    label: 'a running Run whose Task resolves to a queue',
    raw: buildWorkflowRun(),
    resolve: RESOLVES,
    expectedKeys: [QUEUE_A],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11']
  },
  {
    label: 'a paused Run whose Task resolves to a queue',
    raw: buildWorkflowRun({ status: 'paused', manualPauseCause: 'operator-paused' }),
    resolve: RESOLVES,
    expectedKeys: [QUEUE_A],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11']
  },
  {
    label: 'a Run whose Task resolves to no queue — reassigned, not dropped',
    raw: buildWorkflowRun({ featureId: 'task-gone' }),
    resolve: RESOLVES_NOTHING,
    expectedKeys: [DEFAULT_QUEUE_ID],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11', 'run-reassigned-to-default-queue']
  },
  {
    label: 'already v11 — one entry',
    raw: { [QUEUE_A]: buildWorkflowRun() },
    resolve: RESOLVES,
    expectedKeys: [QUEUE_A],
    changed: false,
    expectedEvents: []
  },
  {
    label: 'already v11 — two entries',
    raw: {
      [QUEUE_A]: buildWorkflowRun({ id: 'run-a', featureId: 'task-a' }),
      [QUEUE_B]: buildWorkflowRun({ id: 'run-b', featureId: 'task-b' })
    },
    resolve: RESOLVES,
    expectedKeys: [QUEUE_A, QUEUE_B],
    changed: false,
    expectedEvents: []
  },
  {
    label: 'already v11 — no Run executing',
    raw: {},
    resolve: RESOLVES,
    expectedKeys: [],
    changed: false,
    expectedEvents: []
  },
  {
    label: 'unrecognised — a QueueState mistakenly at KEYS.run',
    raw: buildV9QueueState({ pendingCount: 2 }),
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11', 'run-record-repaired']
  },
  {
    label: 'unrecognised — a number',
    raw: 42,
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11', 'run-record-repaired']
  },
  {
    label: 'unrecognised — an array',
    raw: [buildWorkflowRun()],
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11', 'run-record-repaired']
  },
  {
    label: 'unrecognised — a half-built Run missing its status',
    raw: { id: 'run-1', featureId: 'task-0' },
    resolve: RESOLVES,
    expectedKeys: [],
    changed: true,
    expectedEvents: ['state-migrated-v10-to-v11', 'run-record-repaired']
  }
];

describe('migrateV10ToV11 — shape', () => {
  it.each(CORPUS)('produces the contracted record: $label', (row) => {
    const result = migrateV10ToV11(row.raw, row.resolve, NOW);

    expect(Object.keys(result.runs).sort()).toEqual([...row.expectedKeys].sort());
    expect(result.changed).toBe(row.changed);
    expect(eventTypes(result.events)).toEqual([...row.expectedEvents]);
  });

  it('keys the inherited Run by the queue its Task belongs to', () => {
    const run = buildWorkflowRun();
    const result = migrateV10ToV11(run, RESOLVES, NOW);

    expect(result.runs[QUEUE_A]).toEqual(run);
    expect(Object.keys(result.runs)).toEqual([QUEUE_A]);
  });

  it('fabricates no Run record for a workspace that had none', () => {
    // The absent case is `{}`, not `{ default: <something> }`. A migration that
    // invented a Run would hand the drain coordinator a queue that looks busy.
    for (const absent of [null, undefined]) {
      expect(migrateV10ToV11(absent, RESOLVES, NOW).runs).toEqual({});
    }
  });

  it('reports no change for a record already in the v11 map shape', () => {
    // `changed: false` is the whole write contract — the store performs no
    // `update()` at all, so an already-migrated workspace does not rewrite
    // `KEYS.run` on every window open.
    const already: RunStateMap = { [QUEUE_A]: buildWorkflowRun() };
    const result = migrateV10ToV11(already, RESOLVES, NOW);

    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.runs).toEqual(already);
  });
});

describe('migrateV10ToV11 — preservation', () => {
  it.each(CORPUS.filter((row) => row.expectedKeys.length > 0))(
    'carries the Run byte-for-byte through the reshape: $label',
    (row) => {
      const before = JSON.parse(JSON.stringify(row.raw));
      const result = migrateV10ToV11(row.raw, row.resolve, NOW);
      const carried = Object.values(result.runs);

      // An already-v11 row passes its entries through; a v10 row carries the
      // one Run. Either way the Run objects must be identical to the input.
      const expected = row.changed ? [before] : Object.values(before as RunStateMap);
      expect(carried).toEqual(expected);
    }
  );

  it('preserves a paused Run as paused, with its pause pair intact', () => {
    const paused = buildWorkflowRun({ status: 'paused', manualPauseCause: 'operator-paused' });
    const carried = migrateV10ToV11(paused, RESOLVES, NOW).runs[QUEUE_A];

    expect(carried.status).toBe('paused');
    expect(carried.manualPauseCause).toBe('operator-paused');
    expect(carried.manualPauseAt).toBe(FIXTURE_NOW);
  });

  it('stamps no queue id onto the Run — the map key is the only association', () => {
    // data-model §1.1: `WorkflowRun` gains no field, so the association has
    // exactly one representation and cannot disagree with itself.
    const run = buildWorkflowRun();
    const carried = migrateV10ToV11(run, RESOLVES, NOW).runs[QUEUE_A];

    expect(Object.keys(carried).sort()).toEqual(Object.keys(run).sort());
    expect(carried).not.toHaveProperty('queueId');
  });

  it('does not reorder or re-key an already-plural record', () => {
    const already: RunStateMap = {
      [QUEUE_B]: buildWorkflowRun({ id: 'run-b', featureId: 'task-b' }),
      [QUEUE_A]: buildWorkflowRun({ id: 'run-a', featureId: 'task-a' })
    };
    const result = migrateV10ToV11(already, RESOLVES, NOW);

    expect(Object.keys(result.runs)).toEqual([QUEUE_B, QUEUE_A]);
    expect(result.runs[QUEUE_A].id).toBe('run-a');
    expect(result.runs[QUEUE_B].id).toBe('run-b');
  });
});

describe('migrateV10ToV11 — an unresolvable Run is reassigned, never dropped', () => {
  // FR-003 / FR-006. Dropping the Run does not drop the Task that points at
  // it: the Task keeps its in-flight status with nothing left to advance or
  // terminate it, which is a queue stuck forever on work nothing is running —
  // the failure the source follow-up reports. Reassignment keeps the Run
  // addressable and cancellable, and the audit event says why it is there.
  const orphan = buildWorkflowRun({ id: 'run-orphan', featureId: 'task-gone' });

  it('lands the Run in the default queue', () => {
    const result = migrateV10ToV11(orphan, RESOLVES_NOTHING, NOW);

    expect(result.runs[DEFAULT_QUEUE_ID]).toEqual(orphan);
    expect(Object.keys(result.runs)).toEqual([DEFAULT_QUEUE_ID]);
  });

  it('records the reason as a closed code naming the Run', () => {
    const reassign = migrateV10ToV11(orphan, RESOLVES_NOTHING, NOW).events.find(
      (e) => e.type === 'run-reassigned-to-default-queue'
    );

    expect(reassign).toBeDefined();
    expect(reassign).toMatchObject({
      type: 'run-reassigned-to-default-queue',
      occurredAt: NOW,
      runId: 'run-orphan',
      queueId: DEFAULT_QUEUE_ID,
      reason: 'task-not-in-any-queue'
    });
  });

  it('emits no reassignment event when the Task did resolve', () => {
    const events = migrateV10ToV11(buildWorkflowRun(), RESOLVES, NOW).events;
    expect(eventTypes(events)).not.toContain('run-reassigned-to-default-queue');
  });
});

describe('migrateV10ToV11 — the audit events', () => {
  it('emits one reshape event naming the queues it produced', () => {
    const [event, ...rest] = migrateV10ToV11(buildWorkflowRun(), RESOLVES, NOW).events;

    expect(rest).toHaveLength(0);
    expect(event.type).toBe('state-migrated-v10-to-v11');
    expect(event).toMatchObject({
      fromVersion: 10,
      toVersion: STATE_SCHEMA_VERSION_V11,
      occurredAt: NOW,
      queueIds: [QUEUE_A],
      runCount: 1
    });
  });

  it('records the repair reason rather than guessing at an unreadable record', () => {
    const repair = migrateV10ToV11(42, RESOLVES, NOW).events.find(
      (e) => e.type === 'run-record-repaired'
    );

    expect(repair).toMatchObject({
      type: 'run-record-repaired',
      occurredAt: NOW,
      reason: 'unrecognised-record-shape'
    });
  });

  it('carries no operator-authored text — the payload-shape rule', () => {
    // Task descriptions, queue names and pipeline names are all
    // operator-authored. An audit payload carrying one would put arbitrary
    // operator text into the structured log, which `CLAUDE.md` forbids.
    // Mirrors queue-state-migrator-v9-to-v10.test.ts:238-251.
    for (const row of CORPUS) {
      const serialised = JSON.stringify(migrateV10ToV11(row.raw, row.resolve, NOW).events);
      expect(serialised, row.label).not.toMatch(/name/i);
      expect(serialised, row.label).not.toMatch(/description/i);
      expect(serialised, row.label).not.toMatch(/instruction/i);
    }
  });

  it('emits nothing when there was nothing to migrate', () => {
    expect(migrateV10ToV11({ [QUEUE_A]: buildWorkflowRun() }, RESOLVES, NOW).events).toEqual([]);
    expect(migrateV10ToV11({}, RESOLVES, NOW).events).toEqual([]);
  });
});

describe('migrateV10ToV11 — purity', () => {
  it('does not mutate the record it was handed', () => {
    const run = buildWorkflowRun();
    const before = JSON.parse(JSON.stringify(run));
    migrateV10ToV11(run, RESOLVES, NOW);

    expect(run).toEqual(before);
  });

  it('consults the injected resolver rather than reaching for a registry', () => {
    // The resolver is a parameter precisely so the migrator stays free of the
    // queue manager. Asserting it is *the* source of the key is what makes the
    // single-key guarantee checkable.
    const seen: string[] = [];
    const result = migrateV10ToV11(
      buildWorkflowRun({ featureId: 'task-7' }),
      (taskId) => {
        seen.push(taskId);
        return QUEUE_B;
      },
      NOW
    );

    expect(seen).toEqual(['task-7']);
    expect(Object.keys(result.runs)).toEqual([QUEUE_B]);
  });

  it('takes its clock from the caller', () => {
    const other = NOW + 5_000;
    const [event] = migrateV10ToV11(buildWorkflowRun(), RESOLVES, other).events;
    expect(event.occurredAt).toBe(other);
  });
});
