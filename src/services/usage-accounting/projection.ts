/**
 * FR-R6-F06 (FR-006, FR-007, FR-014, NFR-004, research R5, R7) — the versioned contribution
 * projection.
 *
 * Applying a pending intent recomputes the (invocation, measure, unit) groups of the intent's
 * attempt and invocation with the authority policy, closes each open contribution whose selection
 * changed, opens its replacement, rewrites the observations' dispositions, appends exactly one revision and marks
 * the intent applied, all in one `BEGIN IMMEDIATE` transaction. A failure rolls that back; a
 * second transaction then counts the attempt on the intent and a `projection-failed` gap, so
 * the intent stays pending for `rebuildPendingProjections`.
 *
 * The invocation ordinal is part of the group: two invocations of one attempt are two
 * contributions that add up, never rival reports of one figure. Observations with no ordinal
 * form one group per attempt. Groups are independent and every measure of one observation shares
 * its ordinal, so an intent reloads only its own invocation: the work per ingest does not grow
 * with the attempt's earlier invocations (SC-003).
 *
 * A group whose open contribution carries a correction is left alone: a correction outranks
 * any later observation until it is itself replaced.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  type Completeness,
  type CounterScope,
  type Measure,
  type Provenance,
  type RevisionCause,
  ACCOUNTING_CALCULATION_VERSION,
  ACCOUNTING_POLICY_VERSION
} from '../../contracts/usage-accounting/accounting-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';
import {
  type CandidateDisposition,
  type CandidateMeasure,
  aggregateObservationDisposition,
  selectContribution
} from './authority-policy';
import { parseSumText } from './exact-quantities';
import { UNATTRIBUTED_GAP_SCOPE, recordGap } from './gap-counter';

/** The counter scope whose readings replace each other: the newest event wins (FR-023). */
const LATEST_VALUE_SCOPE: CounterScope = 'acp-context-occupancy';

/** Pending intents applied per `rebuildPendingProjections` call. */
export const REBUILD_BATCH_LIMIT = 10_000;

export interface ProjectionContext {
  readonly nowUtc: string;
  readonly maxGapKeys: number;
  /** Test seam: throwing here aborts the apply transaction after its writes. */
  readonly failpoint?: ((stage: 'apply') => void) | undefined;
}

export interface ContributionRow {
  readonly contributionId: number;
  readonly attemptId: string;
  readonly invocationOrdinal: number | null;
  readonly measure: Measure;
  readonly unit: string;
  readonly quantity: bigint | null;
  readonly completeness: Completeness;
  readonly provenance: Provenance;
  readonly costOrigin: 'reported' | 'estimated' | null;
  readonly selectedObservationId: string | null;
  readonly correctionId: number | null;
  readonly fromRevision: number;
  readonly toRevision: number | null;
}

export type ApplyOutcome = { readonly applied: true; readonly revision: number } | { readonly applied: false };

interface CandidateRow {
  readonly observation_id: string;
  readonly ingest_seq: number;
  readonly invocation_ordinal: number | null;
  readonly measure: Measure;
  readonly unit: string;
  readonly quantity_text: string | null;
  readonly completeness: Completeness;
  readonly provenance: Provenance;
  readonly counter_scope: CounterScope;
  readonly event_utc: string;
}

interface OpenRow {
  readonly contribution_id: number;
  readonly quantity_text: string | null;
  readonly completeness: Completeness;
  readonly provenance: Provenance;
  readonly selected_observation_id: string | null;
  readonly correction_id: number | null;
}

const CONTRIBUTION_COLUMNS = `contribution_id, attempt_id, invocation_ordinal, measure, unit, CAST(quantity AS TEXT) AS quantity_text, completeness,
  provenance, cost_origin, selected_observation_id, correction_id, from_revision, to_revision`;

interface RawContribution {
  readonly contribution_id: number;
  readonly attempt_id: string;
  readonly invocation_ordinal: number | null;
  readonly measure: Measure;
  readonly unit: string;
  readonly quantity_text: string | null;
  readonly completeness: Completeness;
  readonly provenance: Provenance;
  readonly cost_origin: 'reported' | 'estimated' | null;
  readonly selected_observation_id: string | null;
  readonly correction_id: number | null;
  readonly from_revision: number;
  readonly to_revision: number | null;
}

function toContribution(row: RawContribution): ContributionRow {
  return {
    contributionId: Number(row.contribution_id),
    attemptId: row.attempt_id,
    invocationOrdinal: row.invocation_ordinal === null ? null : Number(row.invocation_ordinal),
    measure: row.measure,
    unit: row.unit,
    quantity: row.quantity_text === null ? null : parseSumText(row.quantity_text),
    completeness: row.completeness,
    provenance: row.provenance,
    costOrigin: row.cost_origin,
    selectedObservationId: row.selected_observation_id,
    correctionId: row.correction_id === null ? null : Number(row.correction_id),
    fromRevision: Number(row.from_revision),
    toRevision: row.to_revision === null ? null : Number(row.to_revision)
  };
}

/**
 * The WHERE clause of an open-contribution lookup. It repeats the key expressions of
 * `idx_accounting_contributions_open` (`IFNULL(invocation_ordinal, -1)`; ordinals are never
 * negative), so SQLite searches all four key columns. `invocation_ordinal IS ?` matches only
 * the `attempt_id` prefix, which scans every open contribution of the attempt on each ingest.
 */
export const OPEN_CONTRIBUTION_KEY =
  'attempt_id = ? AND IFNULL(invocation_ordinal, -1) = IFNULL(?, -1) AND measure = ? AND unit = ? AND to_revision IS NULL';

/** The latest committed revision, or 0 before the first one. */
export function latestRevision(conn: NodeSqliteConnection): number {
  return Number(conn.scalar('SELECT COALESCE(MAX(revision), 0) FROM accounting_revisions') ?? 0);
}

/** Appends one revision. The cutoff never moves backwards. Callers provide the transaction. */
export function appendRevision(conn: NodeSqliteConnection, cause: RevisionCause, nowUtc: string, ingestSeq: number): number {
  const previous = conn.get<{ revision: number; cutoff_ingest_seq: number }>(
    'SELECT revision, cutoff_ingest_seq FROM accounting_revisions ORDER BY revision DESC LIMIT 1'
  );
  const revision = previous === undefined ? 1 : Number(previous.revision) + 1;
  const cutoff = Math.max(previous === undefined ? 0 : Number(previous.cutoff_ingest_seq), ingestSeq);
  conn.run(
    `INSERT INTO accounting_revisions (revision, committed_utc, cause, cutoff_ingest_seq, policy_version, calculation_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
    revision,
    nowUtc,
    cause,
    cutoff,
    ACCOUNTING_POLICY_VERSION,
    ACCOUNTING_CALCULATION_VERSION
  );
  return revision;
}

function costOriginOf(measure: Measure, provenance: Provenance): 'reported' | 'estimated' | null {
  if (measure !== 'cost') return null;
  return provenance === 'estimated' ? 'estimated' : 'reported';
}

function loadCandidates(conn: NodeSqliteConnection, attemptId: string, invocationOrdinal: number | null): Map<string, CandidateRow[]> {
  const rows = conn.all<CandidateRow>(
    `SELECT o.observation_id, o.ingest_seq, o.invocation_ordinal, m.measure, m.unit, CAST(m.quantity AS TEXT) AS quantity_text, m.completeness, m.provenance,
            o.counter_scope, o.event_utc
       FROM accounting_observations o
       JOIN accounting_observation_measures m ON m.observation_id = o.observation_id
      WHERE o.attempt_id = ? AND o.invocation_ordinal IS ? AND o.disposition NOT IN ('unattributed', 'historical', 'correction')`,
    attemptId,
    invocationOrdinal
  );
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = `${String(row.invocation_ordinal)}\0${row.measure}\0${row.unit}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function sameSelection(open: OpenRow, quantity: bigint | null, completeness: Completeness, provenance: Provenance, selectedId: string): boolean {
  const openQuantity = open.quantity_text === null ? null : parseSumText(open.quantity_text);
  return (
    openQuantity === quantity &&
    open.completeness === completeness &&
    open.provenance === provenance &&
    open.selected_observation_id === selectedId
  );
}

/** Recomputes the groups of one attempt's invocation at `revision`. Callers provide the transaction. */
export function recomputeInvocation(
  conn: NodeSqliteConnection,
  attemptId: string,
  invocationOrdinal: number | null,
  revision: number
): void {
  const perObservation = new Map<string, CandidateDisposition[]>();
  for (const group of loadCandidates(conn, attemptId, invocationOrdinal).values()) {
    const first = group.at(0) as CandidateRow;
    const open = conn.get<OpenRow>(
      `SELECT contribution_id, CAST(quantity AS TEXT) AS quantity_text, completeness, provenance, selected_observation_id, correction_id
         FROM accounting_contributions
        WHERE ${OPEN_CONTRIBUTION_KEY}`,
      attemptId,
      first.invocation_ordinal,
      first.measure,
      first.unit
    );
    if (open !== undefined && open.correction_id !== null) continue;
    const candidates: CandidateMeasure[] = group.map((row) => ({
      observationId: row.observation_id,
      ingestSeq: Number(row.ingest_seq),
      provenance: row.provenance,
      completeness: row.completeness,
      quantity: row.quantity_text === null ? null : parseSumText(row.quantity_text),
      latestWinsEventUtc: row.counter_scope === LATEST_VALUE_SCOPE ? row.event_utc : undefined
    }));
    const selection = selectContribution(candidates);
    for (const [observationId, disposition] of selection.dispositions) {
      const list = perObservation.get(observationId) ?? [];
      list.push(disposition);
      perObservation.set(observationId, list);
    }
    const selected = selection.selected as CandidateMeasure;
    if (open !== undefined && sameSelection(open, selected.quantity, selection.completeness, selected.provenance, selected.observationId)) continue;
    if (open !== undefined) {
      conn.run('UPDATE accounting_contributions SET to_revision = ? WHERE contribution_id = ?', revision, open.contribution_id);
    }
    conn.run(
      `INSERT INTO accounting_contributions (attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, cost_origin, selected_observation_id, from_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptId,
      first.invocation_ordinal,
      first.measure,
      first.unit,
      selected.quantity,
      selection.completeness,
      selected.provenance,
      costOriginOf(first.measure, selected.provenance),
      selected.observationId,
      revision
    );
  }
  for (const [observationId, dispositions] of perObservation) {
    const disposition = aggregateObservationDisposition(dispositions);
    if (disposition === undefined) continue;
    conn.run('UPDATE accounting_observations SET disposition = ? WHERE observation_id = ?', disposition, observationId);
  }
}

interface PendingIntent {
  readonly intent_id: number;
  readonly state: 'pending' | 'applied';
  readonly applied_revision: number | null;
  readonly attempt_id: string | null;
  readonly invocation_ordinal: number | bigint | null;
  readonly ingest_seq: number;
}

function loadIntent(conn: NodeSqliteConnection, intentId: number): PendingIntent | undefined {
  return conn.get<PendingIntent>(
    `SELECT i.intent_id, i.state, i.applied_revision, o.attempt_id, o.invocation_ordinal, o.ingest_seq
       FROM accounting_projection_intents i JOIN accounting_observations o ON o.observation_id = i.observation_id
      WHERE i.intent_id = ?`,
    intentId
  );
}

/**
 * Applies one intent. Returns `{ applied: false }` after a failure, which is counted on the
 * intent and as a `projection-failed` gap; it never throws for an apply failure.
 */
export function applyProjectionIntent(conn: NodeSqliteConnection, intentId: number, cause: RevisionCause, ctx: ProjectionContext): ApplyOutcome {
  let gapScope = UNATTRIBUTED_GAP_SCOPE;
  try {
    return inImmediateTransaction(conn, () => {
      const intent = loadIntent(conn, intentId);
      if (intent === undefined) return { applied: false } as const;
      if (intent.state === 'applied') return { applied: true, revision: Number(intent.applied_revision) } as const;
      if (intent.attempt_id === null) return { applied: false } as const;
      gapScope = intent.attempt_id;
      const revision = appendRevision(conn, cause, ctx.nowUtc, Number(intent.ingest_seq));
      const ordinal = intent.invocation_ordinal === null ? null : Number(intent.invocation_ordinal);
      recomputeInvocation(conn, intent.attempt_id, ordinal, revision);
      conn.run("UPDATE accounting_projection_intents SET state = 'applied', applied_revision = ? WHERE intent_id = ?", revision, intentId);
      ctx.failpoint?.('apply');
      return { applied: true, revision } as const;
    });
  } catch {
    inImmediateTransaction(conn, () => {
      conn.run("UPDATE accounting_projection_intents SET attempts = attempts + 1 WHERE intent_id = ? AND state = 'pending'", intentId);
      recordGap(conn, 'projection-failed', gapScope, ctx.nowUtc, ctx.maxGapKeys);
    });
    return { applied: false };
  }
}

/** Applies pending intents in intent order. Each one is its own transaction and revision. */
export function rebuildPendingProjections(conn: NodeSqliteConnection, ctx: ProjectionContext): { applied: number; stillPending: number } {
  const pending = conn.all<{ intent_id: number }>(
    "SELECT intent_id FROM accounting_projection_intents WHERE state = 'pending' ORDER BY intent_id LIMIT ?",
    REBUILD_BATCH_LIMIT
  );
  let applied = 0;
  for (const row of pending) {
    if (applyProjectionIntent(conn, Number(row.intent_id), 'rebuild', ctx).applied) applied += 1;
  }
  const stillPending = Number(conn.scalar("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'") ?? 0);
  return { applied, stillPending };
}

/** Contributions visible at revision N: opened at or before N and not closed by N. */
export function readContributionsAsOf(conn: NodeSqliteConnection, revision: number): ContributionRow[] {
  return conn
    .all<RawContribution>(
      `SELECT ${CONTRIBUTION_COLUMNS} FROM accounting_contributions
        WHERE from_revision <= ? AND (to_revision IS NULL OR to_revision > ?)
        ORDER BY attempt_id, invocation_ordinal, measure, unit`,
      revision,
      revision
    )
    .map(toContribution);
}

/** The open contributions, optionally for one attempt. */
export function readOpenContributions(conn: NodeSqliteConnection, attemptId?: string): ContributionRow[] {
  const rows =
    attemptId === undefined
      ? conn.all<RawContribution>(`SELECT ${CONTRIBUTION_COLUMNS} FROM accounting_contributions WHERE to_revision IS NULL ORDER BY attempt_id, invocation_ordinal, measure, unit`)
      : conn.all<RawContribution>(
          `SELECT ${CONTRIBUTION_COLUMNS} FROM accounting_contributions WHERE to_revision IS NULL AND attempt_id = ? ORDER BY invocation_ordinal, measure, unit`,
          attemptId
        );
  return rows.map(toContribution);
}
