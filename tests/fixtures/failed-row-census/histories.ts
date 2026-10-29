// FR-R4-F16 (feature 244, contract E6 preamble) — the histories behind the failed-row census tests.
//
// A history is built the way production builds one: audit entries in the shape the writer produces,
// passed through the REAL `createCensusLogBuilder()` (contract A1), and a queue snapshot built through
// the REAL `toQueueSnapshot` from row states (TA3). Nothing here calls the census itself; the tests
// do, and assert each outcome against the E6 table.
//
// Every title, `lastErrorSummary`, `lastError`, actor and `correlationId` the fixture writes carries a
// sentinel, and `SENTINELS` is exported so the report tests (contract R3.5) can search for them. The
// log builder and the snapshot never copy them, so a sentinel that reaches a report is a leak.
//
// Markers (cut record, unreadable segment, unparseable line, malformed entry) can be inserted at any
// position by calling their method between two events. Ids are valid (UUID-shaped) so the report
// prints them; `QUEUE_DEFAULT` is the reserved queue id.

import type { FailureCause } from '../../../src/contracts/failure-cause';
import type { QueueFailurePolicy } from '../../../src/contracts/queue-failure-policy';
import type { FeatureRequestStatus, QueueState } from '../../../src/queue/feature-request';
import { createCensusLogBuilder } from '../../../src/services/failed-row-census/census-log';
import type { CensusLog, QueueSnapshot } from '../../../src/services/failed-row-census/census-model';
import { toQueueSnapshot } from '../../../src/services/failed-row-census/census-snapshot';
import { buildPendingTask, buildV9QueueState } from '../state/queue-fixtures';

export const SENTINELS: readonly string[] = [
  'SENTINEL-TITLE-9F3A',
  'SENTINEL-ERROR-SUMMARY-9F3A',
  'SENTINEL-LAST-ERROR-9F3A',
  'SENTINEL-ACTOR-9F3A',
  'SENTINEL-CORRELATION-9F3A'
];
const [TITLE_SENTINEL, SUMMARY_SENTINEL, LAST_ERROR_SENTINEL, ACTOR_SENTINEL, CORRELATION_SENTINEL] =
  SENTINELS as readonly [string, string, string, string, string];

export const BASE_MS = Date.parse('2026-10-20T10:00:00.000Z');
const STEP_MS = 1000;
/** A cutoff a day after the base, past every event a history writes with the automatic clock. */
export const DEFAULT_CUTOFF_MS = BASE_MS + 24 * 60 * 60 * 1000;

function uuid(prefix: number, n: number): string {
  return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
export const taskId = (n: number): string => uuid(1, n);
export const runId = (n: number): string => uuid(2, n);
export const queueIdOf = (n: number): string => uuid(3, n);
export const QUEUE_DEFAULT = 'default';
export const QUEUE_B = queueIdOf(2);
export const QUEUE_C = queueIdOf(3);

export const T1 = taskId(1);
export const T2 = taskId(2);
export const T3 = taskId(3);
export const R1 = runId(1);
export const R2 = runId(2);
export const R3 = runId(3);
export const R9 = runId(9);

export type RemovalProvenance = 'absent' | 'null' | 'attested' | 'malformed';

export interface SnapshotRowSpec {
  readonly queue: string;
  readonly taskId: string;
  readonly status: FeatureRequestStatus;
  readonly runId: string | null;
  readonly attested?: boolean;
}

export interface BuiltHistory {
  readonly log: CensusLog;
  readonly cutoffMs: number;
  readonly snapshot: QueueSnapshot;
  /** The same log read against another cutoff and, when given, other snapshot rows. */
  snapshotAt(cutoffMs: number, rows?: readonly SnapshotRowSpec[]): QueueSnapshot;
}

interface Noise {
  readonly title: string;
  readonly lastErrorSummary: string;
  readonly lastError: string;
  readonly actor: { readonly kind: 'operator'; readonly id: string };
}

const NOISE: Noise = {
  title: TITLE_SENTINEL,
  lastErrorSummary: SUMMARY_SENTINEL,
  lastError: LAST_ERROR_SENTINEL,
  actor: { kind: 'operator', id: ACTOR_SENTINEL }
};

function statesFor(
  rows: readonly SnapshotRowSpec[],
  policies: Readonly<Record<string, QueueFailurePolicy | undefined>>
): Record<string, QueueState> {
  const queues = new Set<string>([...rows.map((row) => row.queue), ...Object.keys(policies)]);
  const states: Record<string, QueueState> = {};
  for (const queue of queues) {
    const requests = rows
      .filter((row) => row.queue === queue)
      .map((row, position) => ({
        ...buildPendingTask({ id: row.taskId, description: TITLE_SENTINEL, position, queueId: queue }),
        status: row.status,
        runId: row.runId,
        lastError: LAST_ERROR_SENTINEL,
        ...(row.attested === true ? { completionProvenance: 'operator-attested' as const } : {})
      }));
    const policy = policies[queue];
    states[queue] = {
      ...buildV9QueueState({ pendingCount: 0 }),
      requests,
      ...(policy === undefined ? {} : { failurePolicy: policy })
    };
  }
  return states;
}

/** Builds one history by calling the real log builder in log order. */
export class HistoryBuilder {
  private readonly builder = createCensusLogBuilder();
  private clock = BASE_MS;
  private readonly rows: SnapshotRowSpec[] = [];
  private readonly policies: Record<string, QueueFailurePolicy> = {};
  private defaultPolicy: QueueFailurePolicy = 'halt-on-failure';
  private cutoff = DEFAULT_CUTOFF_MS;

  private stamp(at: number | undefined): string {
    this.clock += STEP_MS;
    return new Date(at ?? this.clock).toISOString();
  }

  private entry(eventType: string, payload: Record<string, unknown>, at?: number): this {
    const fields = { ...NOISE, ...payload };
    this.builder.line({
      entry: {
        id: `entry-${this.clock}-${eventType}`,
        timestamp: this.stamp(at),
        runId: 'queue:fixture',
        phase: 'queue-manager' as never,
        iteration: 0,
        eventType: eventType as never,
        payload: {
          ...fields,
          stateTransition: { actor: NOISE.actor, reasonCode: eventType, newState: fields }
        },
        outcome: 'info',
        correlationId: CORRELATION_SENTINEL
      }
    });
    return this;
  }

  public fail(run: string, task: string, cause: FailureCause | 'omit' = 'phase_failed', at?: number): this {
    return this.entry(
      'task-execution-ended',
      {
        taskId: task,
        runId: run,
        terminalStatus: 'failed',
        durationMs: 1000,
        ...(cause === 'omit' ? {} : { failureCause: cause })
      },
      at
    );
  }

  public complete(run: string, task: string, at?: number): this {
    return this.entry('task-execution-ended', { taskId: task, runId: run, terminalStatus: 'completed' }, at);
  }

  public start(run: string, task: string, queue: string, isResume = false, at?: number): this {
    return this.entry(
      'task-execution-started',
      { taskId: task, runId: run, queueId: queue, pipelineId: '', isResume },
      at
    );
  }

  public remove(
    task: string,
    queue: string | null,
    priorStatus: string,
    options: { run?: string | null; provenance?: RemovalProvenance; at?: number } = {}
  ): this {
    const provenance = options.provenance ?? 'absent';
    const provenanceField =
      provenance === 'absent'
        ? {}
        : {
            completionProvenance:
              provenance === 'attested' ? 'operator-attested' : provenance === 'null' ? null : 'Operator-Attested'
          };
    return this.entry(
      'task-removed',
      {
        taskId: task,
        queueId: queue,
        priorStatus,
        runId: options.run ?? null,
        cause: 'operator',
        sessionCleaned: true,
        sessionCleanupRefusal: null,
        ...provenanceField
      },
      options.at
    );
  }

  public move(task: string, toQueue: string, at?: number): this {
    return this.entry('task-moved', { taskId: task, queueId: toQueue }, at);
  }

  public deleteQueue(queue: string, at?: number): this {
    return this.entry('queue-deleted', { queueId: queue, pendingTaskCount: 0 }, at);
  }

  public clearQueue(queue: string, at?: number): this {
    return this.entry('queue-cleared', { queueId: queue, removedFailed: 1 }, at);
  }

  public clearAll(at?: number): this {
    return this.entry('queue-cleared-all', { removedPending: 0 }, at);
  }

  /** A parsed entry of a type the census does not use. Its stamp still counts. */
  public noise(at?: number): this {
    return this.entry('phase-end', { outcome: 'clean' }, at);
  }

  /** A census entry missing a field it needs. */
  public malformedStart(at?: number): this {
    return this.entry('task-execution-started', { taskId: T3, runId: R3, queueId: QUEUE_DEFAULT, isResume: 'yes' }, at);
  }

  public cut(): this {
    this.builder.cut();
    return this;
  }

  public unreadable(): this {
    this.builder.unreadableSegment();
    return this;
  }

  public unparseable(): this {
    this.builder.line({ entry: null, warning: 'malformed JSON' });
    return this;
  }

  public row(spec: SnapshotRowSpec): this {
    this.rows.push(spec);
    return this;
  }

  public policy(queue: string, value: QueueFailurePolicy): this {
    this.policies[queue] = value;
    return this;
  }

  public defaultIs(value: QueueFailurePolicy): this {
    this.defaultPolicy = value;
    return this;
  }

  public cutoffAt(ms: number): this {
    this.cutoff = ms;
    return this;
  }

  public build(): BuiltHistory {
    const log = this.builder.finish();
    const snapshotAt = (cutoffMs: number, rows: readonly SnapshotRowSpec[] = this.rows): QueueSnapshot =>
      toQueueSnapshot(statesFor(rows, this.policies), this.defaultPolicy, cutoffMs);
    return { log, cutoffMs: this.cutoff, snapshot: snapshotAt(this.cutoff), snapshotAt };
  }
}

const A = QUEUE_DEFAULT;
const B = QUEUE_B;
const C = QUEUE_C;

/** A failed row still in the snapshot under its Run, the common ending for a history that stops. */
const failedRow = (queue: string, task: string, run: string): SnapshotRowSpec => ({
  queue,
  taskId: task,
  status: 'failed',
  runId: run
});

/** The time the earlier of E6.11's two cutoffs falls at: after the failure, before the removal. */
export const E6_11_REMOVAL_AT = BASE_MS + 600_000;
export const E6_11_EARLY_CUTOFF = BASE_MS + 300_000;
export const E6_11_LATE_CUTOFF = BASE_MS + 900_000;

/** One builder per contract E6 row, by id. E6.37 is a check over the others and has no builder. */
export const HISTORIES: Readonly<Record<string, () => BuiltHistory>> = {
  'E6.1': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).remove(T1, A, 'failed', { run: R1 }).build(),
  'E6.2': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .row({ queue: A, taskId: T1, status: 'completed', runId: R1, attested: true })
      .build(),
  'E6.3': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'completed', { run: R1, provenance: 'attested' })
      .build(),
  'E6.4': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1, 'phase_timeout')
      .start(R1, T1, A, true)
      .fail(R1, T1, 'phase_failed')
      .remove(T1, A, 'failed', { run: R1 })
      .build(),
  'E6.5': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).start(R2, T1, A, false).build(),
  'E6.6': () =>
    new HistoryBuilder().start(R1, T1, A).fail(R1, T1).fail(R1, T1).row(failedRow(A, T1, R1)).build(),
  'E6.7': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .start(R2, T1, B)
      .fail(R1, T1)
      .fail(R2, T1)
      .remove(T1, B, 'completed', { run: R2, provenance: 'attested' })
      .remove(T1, A, 'failed', { run: R1 })
      .build(),
  'E6.8': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'completed', { run: R1, provenance: 'absent' })
      .build(),
  'E6.9': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).build(),
  'E6.10': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).cut().row(failedRow(A, T1, R1)).build(),
  'E6.11': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'failed', { run: R1, at: E6_11_REMOVAL_AT })
      .row(failedRow(A, T1, R1))
      .build(),
  'E6.12': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .start(R2, T2, A)
      .start(R3, T3, A)
      .row(failedRow(A, T1, R1))
      .row({ queue: A, taskId: T2, status: 'in-flight', runId: R2 })
      .row({ queue: A, taskId: T3, status: 'in-flight', runId: R3 })
      .build(),
  'E6.13': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .row({ queue: A, taskId: T1, status: 'completed', runId: R1, attested: true })
      .build(),
  'E6.14': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1, 'phase_failed', DEFAULT_CUTOFF_MS + 1000)
      .row(failedRow(A, T1, R1))
      .build(),
  'E6.15': () =>
    new HistoryBuilder().fail(R1, T1, 'start_failed').remove(T1, A, 'failed', { run: null }).build(),
  'E6.16': () =>
    new HistoryBuilder()
      .fail(R1, T1, 'start_failed')
      .remove(T1, A, 'failed', { run: null })
      .row({ queue: B, taskId: T1, status: 'pending', runId: null })
      .build(),
  'E6.17': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).start(R1, T1, A, true).build(),
  'E6.18': () =>
    new HistoryBuilder().start(R1, T1, A).fail(R1, T1).remove(T1, A, 'pending', { run: null }).build(),
  'E6.19': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .row({ queue: A, taskId: T1, status: 'pending', runId: R1 })
      .build(),
  'E6.20': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .row({ queue: A, taskId: T1, status: 'pending', runId: R9 })
      .build(),
  'E6.21': () =>
    new HistoryBuilder().start(R1, T1, A).fail(R1, T1).move(T1, B).start(R2, T1, B, false).build(),
  'E6.22': () =>
    new HistoryBuilder()
      .start(runId(8), T1, C)
      .start(R1, T1, A)
      .fail(R1, T1)
      .move(T1, B)
      .start(R2, T1, B, false)
      .build(),
  'E6.23': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).deleteQueue(A).build(),
  'E6.24': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).clearQueue(A).build(),
  'E6.24b': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).clearQueue(B).build(),
  'E6.25': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).clearAll().build(),
  'E6.26': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .row({ queue: A, taskId: T2, status: 'completed', runId: R2 })
      .build(),
  'E6.27': () =>
    new HistoryBuilder()
      .start(R1, T1, B)
      .fail(R1, T1)
      .row({ queue: A, taskId: T2, status: 'completed', runId: R2 })
      .build(),
  'E6.28': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).row(failedRow(A, T1, R9)).build(),
  'E6.29': () => new HistoryBuilder().build(),
  'E6.30': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).unreadable().row(failedRow(A, T1, R1)).build(),
  'E6.31': () => new HistoryBuilder().start(R1, T1, A).fail(R1, T1).unparseable().row(failedRow(A, T1, R1)).build(),
  'E6.32': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .unparseable()
      .noise()
      .row(failedRow(A, T1, R1))
      .build(),
  'E6.33': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'completed', { run: R1, provenance: 'null' })
      .build(),
  'E6.34': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'completed', { run: R1, provenance: 'malformed' })
      .build(),
  'E6.35': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1, 'phase_failed', BASE_MS + 100_000)
      .remove(T1, A, 'failed', { run: R1, at: BASE_MS + 50_000 })
      .build(),
  'E6.36': () =>
    new HistoryBuilder()
      .start(R1, T1, A)
      .fail(R1, T1)
      .remove(T1, A, 'failed', { run: R1, at: DEFAULT_CUTOFF_MS + 1000 })
      .build()
};

/** The history for contract E6 row `id`. Throws on an id the table does not have. */
export function history(id: string): BuiltHistory {
  const build = HISTORIES[id] as (() => BuiltHistory) | undefined;
  if (build === undefined) throw new Error(`no history ${id}`);
  return build();
}
