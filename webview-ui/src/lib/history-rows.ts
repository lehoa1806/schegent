// Feature 103 (T015, T016 — FR-001 to FR-005) — the cross-queue history list.
//
// The whole list is a pure function of the snapshot the webview already holds:
// the durable rows from `snapshot.history`, the live ones from each
// `QueueRuntime.inFlightRun`. There is no IPC command behind it and this feature
// registers none, so FR-023 ("filtering and composition happen locally") holds
// by construction rather than by discipline.
//
// The two sources exist because FR-003 and FR-004 pull in opposite directions:
// the surface must show runs that have not finished, and the store must not
// learn about them. Folding at render time is what satisfies both. A
// provisional row written to `HistoryStore` would satisfy FR-003 and break
// FR-004, which is what `tests/integration/history/in-flight-not-persisted.test.ts`
// exists to catch.

// Extensioned specifiers, as `lib/messages.ts` already uses. This module is the
// one piece of webview composition the host's own suite exercises — see
// `tests/integration/history/in-flight-not-persisted.test.ts`, which drives the
// real host projector into the real fold — so it is resolved by both the
// bundler and the host's `Node16` program, and only the extensioned form
// satisfies the latter.
//
// The provenance shapes come from the mirror in `snapshot-types.ts` rather than
// from `src/contracts/`: that module deliberately has no imports, and taking the
// host declaration here would make this file the one place the boundary leaks.
// The host's `HISTORY_UNATTRIBUTED_QUEUE_ID` is a value and cannot be mirrored
// without a second copy of the constant, so it stays.
import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../../../src/state/history-entry.js';
import type {
  CatalogVersionRef,
  HistoryEntry,
  QueueRuntime,
  RunOriginRef,
  WorkflowSnapshot,
  WorkflowStatus
} from './snapshot-types.js';

/**
 * FR-054 — one flat set. The three terminal outcomes a recorded row can hold,
 * plus every state a run still in flight can be in. Not two controls, and not
 * a terminal/non-terminal split: an operator looking for "the paused one" is
 * asking the same question as one looking for "the failed one".
 */
export type HistoryRowStatus = HistoryEntry['terminalStatus'] | WorkflowStatus;

export interface HistoryRow {
  readonly runId: string;
  readonly queueId: string;
  /**
   * FR-002 — what the row calls its queue. The registered queue's display name
   * when it still exists, the documented unattributed label when the row was
   * filed under that partition (FR-006), and the bare id otherwise: a run whose
   * queue was deleted after it finished still knows which id it belonged to,
   * and printing that is more use than printing nothing.
   */
  readonly queueName: string;
  /** `'recorded'` for a durable row, `'in-flight'` for a run still going (FR-003). */
  readonly source: 'recorded' | 'in-flight';
  readonly status: HistoryRowStatus;
  readonly definitionId: string | null;
  readonly catalogVersion: CatalogVersionRef | null;
  readonly origin: RunOriginRef | null;
  readonly descriptionPreview: string;
  /**
   * FR-053 — how long the original description was, so the detail can state how
   * much of it `descriptionPreview` is.
   *
   * `null` for an in-flight row and for one recorded before the store kept the
   * length. Not zero: an unknown original and an empty one are different facts,
   * and only one of them means the operator wrote nothing.
   */
  readonly descriptionLength: number | null;
  /**
   * FR-005 — `completedAt` for a recorded row, `startedAt` for an in-flight one.
   * One key so two sources produce one order. `null` when neither is recorded;
   * such a row sorts last rather than being stamped with a read-time clock,
   * which would make the order depend on when it was rendered.
   */
  readonly orderingKey: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
}

/**
 * FR-002/FR-006 — the label for a queue id.
 *
 * The unattributed partition gets a written-out name because `__unattributed__`
 * is an internal key, and a row reading it would look like a bug rather than
 * like the documented answer to "which queue was this?".
 */
export const UNATTRIBUTED_QUEUE_LABEL = 'Unattributed';

/**
 * FR-012 — what a row says instead of a version it never recorded.
 *
 * Said out loud, because the alternative is a blank cell, and a blank cell reads
 * as "nothing special here": an operator comparing two rows would take them for
 * runs of the same thing. The wording carries its own subject so it stays true
 * away from the column header — in the detail pane, in a tooltip, in a filter
 * summary — and it contains nothing a reader could mistake for a version.
 */
export const VERSION_NOT_RECORDED_LABEL = 'Version not recorded';

/**
 * The same absence, one column left. A run recorded before provenance existed
 * names neither, and the definition it ran is not recoverable from anything on
 * the row — `catalogVersion.id` is where the definition comes from, and that is
 * exactly what is missing.
 */
export const DEFINITION_NOT_RECORDED_LABEL = 'Definition not recorded';

/** FR-013 — a run that was started on its own. The spec's own word for it. */
export const ORIGIN_STANDALONE_LABEL = 'Pipeline';

/**
 * FR-013 — origin absent, which is a third state and not a synonym for
 * `ORIGIN_STANDALONE_LABEL`. Saying "Pipeline" here would assert about a run
 * that was never asked.
 */
export const ORIGIN_NOT_RECORDED_LABEL = 'Origin not recorded';

/**
 * FR-021 (T033) — display names for the ids a row carries.
 *
 * Two maps and not one: the catalog lets a Pipeline and a Workflow share an id,
 * so a single map would answer a definition lookup with a Workflow's name.
 */
export interface CatalogNames {
  readonly pipelines: ReadonlyMap<string, string>;
  readonly workflows: ReadonlyMap<string, string>;
}

/**
 * The state a surface is in before the catalog arrives, and the one the fallback
 * exists for. Not an error: `pipelineCatalog` and `workflowCatalog` are both
 * optional on the snapshot precisely because the authoritative catalog loads
 * after the first render, and a row must be nameable in that window.
 */
export const NO_CATALOG_NAMES: CatalogNames = Object.freeze({
  pipelines: new Map<string, string>(),
  workflows: new Map<string, string>()
});

export function catalogNamesFrom(
  snapshot: Pick<WorkflowSnapshot, 'pipelineCatalog' | 'workflowCatalog'>
): CatalogNames {
  return {
    pipelines: new Map(
      (snapshot.pipelineCatalog?.effective ?? []).map((p) => [p.pipelineId, p.name])
    ),
    workflows: new Map(
      (snapshot.workflowCatalog?.effective ?? []).map((w) => [w.workflowId, w.name])
    )
  };
}

/** The three provenance cells, already reduced to the text each one shows. */
export interface ProvenanceLabels {
  readonly definition: string;
  readonly version: string;
  readonly origin: string;
}

/**
 * FR-011, FR-012, FR-014 — how a row's provenance reads.
 *
 * Every arm returns a sentence rather than an empty string. A blank cell is the
 * one answer that is always wrong here: it reads as "nothing special", so an
 * operator scanning two rows takes them for runs of the same thing, and that is
 * the confusion the whole story exists to remove.
 *
 * The three are computed together because they are one reading of one row, and
 * because the R2 case is only correct when they are: a Workflow member has
 * `origin.kind === 'workflow-member'` and `catalogVersion.kind === 'pipeline'`
 * at the same time, and each of these lines states its own field's answer
 * without consulting the other.
 */
export function provenanceLabels(row: HistoryRow, names: CatalogNames): ProvenanceLabels {
  return {
    definition: definitionLabel(row, names),
    version: row.catalogVersion === null ? VERSION_NOT_RECORDED_LABEL : row.catalogVersion.versionId,
    origin: originLabel(row.origin, names)
  };
}

function definitionLabel(row: HistoryRow, names: CatalogNames): string {
  if (row.definitionId === null) return DEFINITION_NOT_RECORDED_LABEL;
  // The kind decides which map to ask, and a row with no recorded version has no
  // kind — its id came off the live run's Pipeline, so it is one.
  const map = row.catalogVersion?.kind === 'workflow' ? names.workflows : names.pipelines;
  return map.get(row.definitionId) ?? row.definitionId;
}

function originLabel(origin: RunOriginRef | null, names: CatalogNames): string {
  if (origin === null) return ORIGIN_NOT_RECORDED_LABEL;
  if (origin.kind === 'standalone') return ORIGIN_STANDALONE_LABEL;
  return `Workflow: ${names.workflows.get(origin.workflowId) ?? origin.workflowId}`;
}

function labelFor(queueId: string, names: ReadonlyMap<string, string>): string {
  if (queueId === HISTORY_UNATTRIBUTED_QUEUE_ID) return UNATTRIBUTED_QUEUE_LABEL;
  return names.get(queueId) ?? queueId;
}

function rowFromRecord(entry: HistoryEntry, names: ReadonlyMap<string, string>): HistoryRow {
  return {
    runId: entry.runId,
    queueId: entry.queueId,
    queueName: labelFor(entry.queueId, names),
    source: 'recorded',
    status: entry.terminalStatus,
    // T032 (FR-011, FR-014) — all three off the record and nowhere else.
    //
    // The definition is `catalogVersion.id`, not a separate field: the version
    // reference already carries which definition it is a version *of*, and the
    // two cannot then disagree. It also means the two absences have one cause —
    // a run recorded before provenance existed names neither — rather than a row
    // that names a definition while claiming no version was recorded.
    definitionId: entry.catalogVersion?.id ?? null,
    catalogVersion: entry.catalogVersion ?? null,
    // `?? null` and not `?? { kind: 'standalone' }`. Absent means the run was
    // never asked; standalone means it was asked and ran alone.
    origin: entry.origin ?? null,
    descriptionPreview: entry.descriptionPreview,
    descriptionLength: entry.descriptionLength ?? null,
    orderingKey: entry.completedAt || null,
    startedAt: entry.startedAt || null,
    completedAt: entry.completedAt || null,
    durationMs: entry.durationMs
  };
}

function rowFromInFlight(queue: QueueRuntime): HistoryRow | null {
  const run = queue.inFlightRun;
  if (!run) return null;
  const startedAt = run.feature?.startedAt ?? null;
  return {
    runId: run.runId,
    queueId: queue.queueId,
    // Straight off the parent rather than through `labelFor`: the queue is
    // right here, so an in-flight row can never be unattributed.
    queueName: queue.name || queue.queueId,
    source: 'in-flight',
    status: run.status,
    // FR-003 — the live run answers the same three questions. `pipeline.id`
    // comes first because a Run in flight has it whether or not a version was
    // frozen; `catalogVersion.id` covers the built-in `standard` pipeline, which
    // projects `pipeline: null`.
    definitionId: run.pipeline?.id ?? run.catalogVersion?.id ?? null,
    catalogVersion: run.catalogVersion ?? null,
    origin: run.origin ?? null,
    // A live run has no stored preview; its feature label is the same operator
    // text the preview is cut from (FR-053, row half).
    descriptionPreview: run.feature?.label ?? '',
    // The label is the whole of what a live run shows, not a cut of something
    // longer, and nothing has measured the original yet. Reporting
    // `label.length` here would state an extent the run never recorded.
    descriptionLength: null,
    orderingKey: startedAt,
    startedAt,
    completedAt: null,
    durationMs: null
  };
}

/**
 * Order newest first over a single key, with keyless rows last.
 *
 * `localeCompare` on the ISO strings rather than `Date.parse`: the keys are
 * already lexicographically ordered in that format, and an unparseable value
 * would become `NaN` and make the comparator inconsistent — which is how a sort
 * silently stops being a total order.
 */
function byOrderingKeyDescending(a: HistoryRow, b: HistoryRow): number {
  if (a.orderingKey === b.orderingKey) return 0;
  if (a.orderingKey === null) return 1;
  if (b.orderingKey === null) return -1;
  return b.orderingKey.localeCompare(a.orderingKey);
}

/**
 * Compose one cross-queue list from the two sources.
 *
 * De-duplication is by `runId` with the recorded row winning. The overlap is
 * real and brief: a run that has just reached a terminal state is written to
 * history while the queue projection still carries it, so for one snapshot it
 * is in both. The durable row is the one that carries provenance and evidence,
 * so it is the one that survives.
 *
 * `Array.prototype.sort` is stable in every engine this runs on, so rows
 * sharing an ordering key — including the keyless ones, which all compare equal
 * — keep source order. That is what makes the list stable across renders of the
 * same snapshot (FR-005).
 */
export function composeHistoryRows(
  history: readonly HistoryEntry[],
  queues: readonly QueueRuntime[]
): readonly HistoryRow[] {
  const byRunId = new Map<string, HistoryRow>();
  const names = new Map(queues.map((queue) => [queue.queueId, queue.name || queue.queueId]));

  for (const entry of history) {
    byRunId.set(entry.runId, rowFromRecord(entry, names));
  }
  for (const queue of queues) {
    const row = rowFromInFlight(queue);
    if (!row) continue;
    if (byRunId.has(row.runId)) continue;
    byRunId.set(row.runId, row);
  }

  return [...byRunId.values()].sort(byOrderingKeyDescending);
}

/**
 * FR-052 — the fixed render bound.
 *
 * A single documented number, not a heuristic and not adaptive. 200 sits above
 * any realistic filtered result against a 50-per-queue store while still
 * capping the DOM when an operator opens History unfiltered on a workspace with
 * many queues. Both counts are always stated: a truncated list that does not
 * say it is truncated reads as a complete answer.
 */
export const HISTORY_RENDER_BOUND = 200;

/**
 * FR-R3-010 (T411) — a row's evidence answer, already reduced to how it reads.
 *
 * Lives here rather than on the component because two components need it — the
 * list owns the state and the row renders it — and a type exported from a
 * `.svelte` instance script is not importable.
 */
export interface EvidenceState {
  readonly tone: 'info' | 'error';
  readonly message: string;
}

export interface BoundedRows {
  readonly rows: readonly HistoryRow[];
  readonly shown: number;
  readonly matched: number;
}

export function applyRenderBound(rows: readonly HistoryRow[]): BoundedRows {
  return {
    rows: rows.length > HISTORY_RENDER_BOUND ? rows.slice(0, HISTORY_RENDER_BOUND) : rows,
    shown: Math.min(rows.length, HISTORY_RENDER_BOUND),
    matched: rows.length
  };
}
