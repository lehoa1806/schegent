/**
 * FR-R6-F06 (FR-001..005, FR-014, FR-015, NFR-002, research R4, R7, R13) — the ingest
 * transaction for one observation.
 *
 * One `BEGIN IMMEDIATE` transaction writes the observation row, its measure rows, the attempt
 * row and, for an attributed observation, a pending projection intent. A refusal that is a
 * counted loss still commits its gap row, in its own transaction when nothing else is written.
 *
 * Observation ids are derived here, not by the F02 `acceptUsageObservation` boundary: F02's id
 * leaves out the observation revision, and a corrected revision must be a distinct row.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  type AccountingBounds,
  type AccountingRefusalCode,
  type AccountingResult,
  type GapKind,
  type IngestDisposition,
  ACCOUNTING_NORMALIZATION_VERSION
} from '../../contracts/usage-accounting/accounting-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';
import { cumulativeGapOf } from './cumulative-qualifier';
import { UNATTRIBUTED_GAP_SCOPE, recordGap } from './gap-counter';
import {
  type AccountingObservationInput,
  type NormalizedObservation,
  computeDedupKey,
  normalizeObservation
} from './observation-normalizer';

/** A revision walk past this many occupied revisions is refused rather than scanned further. */
export const MAX_OBSERVATION_REVISION_WALK = 64;

const GAP_SCOPE_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export interface IngestContext {
  readonly workspaceId: string;
  readonly nowUtc: string;
  readonly monotonicMs: number;
  readonly bounds: AccountingBounds;
}

export interface StoredObservation {
  readonly observationId: string;
  readonly disposition: IngestDisposition;
  readonly ingestSeq: number | null;
  /** The pending projection intent, when the observation is attributed and newly stored. */
  readonly intentId: number | null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function gapScopeOf(attemptId: unknown): string {
  return typeof attemptId === 'string' && GAP_SCOPE_PATTERN.test(attemptId) ? attemptId : UNATTRIBUTED_GAP_SCOPE;
}

function refusal<T>(code: AccountingRefusalCode, detail?: string): AccountingResult<T> {
  return { ok: false, refusal: { code, ...(detail !== undefined ? { detail } : {}) } };
}

interface RevisionSlot {
  readonly kind: 'free' | 'duplicate';
  readonly revision: number;
  readonly dedupKey: string | null;
  readonly observationId: string | null;
}

/** Finds the first revision at or above the given one that is free, or the one whose content matches. */
function findRevisionSlot(conn: NodeSqliteConnection, obs: NormalizedObservation): RevisionSlot | undefined {
  if (obs.dedupKey === null) return { kind: 'free', revision: obs.observationRevision, dedupKey: null, observationId: null };
  for (let step = 0; step < MAX_OBSERVATION_REVISION_WALK; step += 1) {
    const revision = obs.observationRevision + step;
    const dedupKey = computeDedupKey(obs.producerNamespace, obs.sourceIdentity, obs.attemptId, revision);
    const row = conn.get<{ observation_id: string; content_digest: string }>(
      'SELECT observation_id, content_digest FROM accounting_observations WHERE dedup_key = ?',
      dedupKey
    );
    if (row === undefined) return { kind: 'free', revision, dedupKey, observationId: null };
    if (row.content_digest === obs.contentDigest) return { kind: 'duplicate', revision, dedupKey, observationId: row.observation_id };
  }
  return undefined;
}

function nextIngestSeq(conn: NodeSqliteConnection): number {
  return Number(conn.scalar('SELECT COALESCE(MAX(ingest_seq), 0) FROM accounting_observations') ?? 0) + 1;
}

function boundRefusal(conn: NodeSqliteConnection, obs: NormalizedObservation, ingestSeq: number, bounds: AccountingBounds): { code: AccountingRefusalCode; gap: GapKind } | undefined {
  if (obs.disposition === 'unattributed') {
    const held = Number(conn.scalar("SELECT count(*) FROM accounting_observations WHERE disposition = 'unattributed'") ?? 0);
    if (held >= bounds.maxUnattributed) return { code: 'unattributed-limit', gap: 'unattributed-limit' };
  }
  if (obs.disposition === 'attributed') {
    const pending = Number(conn.scalar("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'") ?? 0);
    if (pending >= bounds.maxPendingIntents) return { code: 'projection-backlog-full', gap: 'ingest-failed' };
  }
  if (ingestSeq > bounds.maxRetainedObservations) {
    const retained = Number(conn.scalar('SELECT count(*) FROM accounting_observations') ?? 0);
    if (retained >= bounds.maxRetainedObservations) return { code: 'store-full', gap: 'ingest-failed' };
  }
  return undefined;
}

function normalizedInstant(utc: string): string {
  return new Date(utc).toISOString();
}

/** Upserts the attempt row. Returns false when the attempt is already bound to another root. */
function upsertAttempt(conn: NodeSqliteConnection, obs: NormalizedObservation, workspaceId: string): boolean {
  const attemptId = obs.attemptId as string;
  const rootId = obs.rootId as string;
  const existing = conn.get<{ root_id: string }>('SELECT root_id FROM accounting_attempts WHERE attempt_id = ?', attemptId);
  if (existing !== undefined && existing.root_id !== rootId) return false;
  const eventUtc = normalizedInstant(obs.eventUtc);
  const dims = obs.dimensions;
  conn.run(
    `INSERT INTO accounting_attempts (attempt_id, root_id, workspace_id, backend, model, workflow_revision, phase_id, first_event_utc, last_event_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id) DO UPDATE SET
       backend = COALESCE(accounting_attempts.backend, excluded.backend),
       model = COALESCE(accounting_attempts.model, excluded.model),
       workflow_revision = COALESCE(accounting_attempts.workflow_revision, excluded.workflow_revision),
       phase_id = COALESCE(accounting_attempts.phase_id, excluded.phase_id),
       first_event_utc = MIN(accounting_attempts.first_event_utc, excluded.first_event_utc),
       last_event_utc = MAX(accounting_attempts.last_event_utc, excluded.last_event_utc)`,
    attemptId,
    rootId,
    workspaceId,
    dims.backend,
    dims.modelReported ?? dims.modelRequested,
    dims.workflowRevision,
    dims.phaseId,
    eventUtc,
    eventUtc
  );
  return true;
}

function insertObservationRows(
  conn: NodeSqliteConnection,
  obs: NormalizedObservation,
  row: { observationId: string; ingestSeq: number; dedupKey: string | null; revision: number; disposition: string },
  ctx: IngestContext
): void {
  const dims = obs.dimensions;
  conn.run(
    `INSERT INTO accounting_observations (
       observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind, source_identity,
       observation_revision, workspace_id, root_id, attempt_id, invocation_ordinal, counter_scope, adapter_version,
       normalization_version, backend, model_requested, model_reported, provider_session_ref, workflow_revision, phase_id,
       event_utc, observed_utc, ingested_utc, ingested_monotonic_ms, clock_anomaly, disposition, uncertainty_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.observationId,
    row.ingestSeq,
    row.dedupKey,
    obs.contentDigest,
    obs.producerNamespace,
    obs.sourceKind,
    obs.sourceIdentity,
    row.revision,
    ctx.workspaceId,
    obs.rootId,
    obs.attemptId,
    obs.invocationOrdinal,
    obs.counterScope,
    obs.adapterVersion,
    ACCOUNTING_NORMALIZATION_VERSION,
    dims.backend,
    dims.modelRequested,
    dims.modelReported,
    dims.providerSessionRef,
    dims.workflowRevision,
    dims.phaseId,
    obs.eventUtc,
    obs.observedUtc,
    ctx.nowUtc,
    Math.floor(ctx.monotonicMs),
    obs.clockAnomaly ? 1 : 0,
    row.disposition,
    obs.uncertaintyReason
  );
  for (const measure of obs.measures) {
    conn.run(
      `INSERT INTO accounting_observation_measures (
         observation_id, measure, quantity, unit, reported_scale, completeness, provenance, cache_relation, pricing_version, unknown_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.observationId,
      measure.measure,
      measure.quantity,
      measure.unit,
      measure.reportedScale,
      measure.completeness,
      measure.provenance,
      measure.cacheRelation,
      measure.pricingVersion,
      measure.unknownReason
    );
  }
}

function storeNormalized(conn: NodeSqliteConnection, obs: NormalizedObservation, ctx: IngestContext): AccountingResult<StoredObservation> {
  const scope = gapScopeOf(obs.attemptId);
  const slot = findRevisionSlot(conn, obs);
  if (slot === undefined) return refusal('invalid-observation', 'observationRevision');
  if (slot.kind === 'duplicate') {
    return { ok: true, value: { observationId: slot.observationId as string, disposition: 'duplicate', ingestSeq: null, intentId: null } };
  }
  const ingestSeq = nextIngestSeq(conn);
  const bound = boundRefusal(conn, obs, ingestSeq, ctx.bounds);
  if (bound !== undefined) {
    recordGap(conn, bound.gap, scope, ctx.nowUtc, ctx.bounds.maxGapKeys);
    return refusal(bound.code);
  }
  const attributed = obs.disposition === 'attributed';
  if (attributed && !upsertAttempt(conn, obs, ctx.workspaceId)) return refusal('invalid-observation', 'rootId');

  const observationId =
    slot.dedupKey !== null
      ? sha256Hex(`accounting-observation\0${slot.dedupKey}`)
      : sha256Hex(`${obs.contentDigest}\0${String(ingestSeq)}`);
  const conflicting = slot.revision > obs.observationRevision;
  const storedDisposition = attributed ? (conflicting ? 'conflicting' : 'accepted') : obs.disposition;
  insertObservationRows(conn, obs, { observationId, ingestSeq, dedupKey: slot.dedupKey, revision: slot.revision, disposition: storedDisposition }, ctx);
  for (let index = 0; index < obs.excludedDimensions.length; index += 1) {
    recordGap(conn, 'dimension-excluded', scope, ctx.nowUtc, ctx.bounds.maxGapKeys);
  }
  // FR-006: a cumulative figure left unknown for want of a baseline is also a counted gap.
  for (const measure of obs.measures) {
    const gap = cumulativeGapOf(measure.unknownReason);
    if (gap !== undefined) recordGap(conn, gap, scope, ctx.nowUtc, ctx.bounds.maxGapKeys);
  }
  let intentId: number | null = null;
  if (attributed) {
    const inserted = conn.run(
      "INSERT INTO accounting_projection_intents (observation_id, state, attempts, created_utc) VALUES (?, 'pending', 0, ?)",
      observationId,
      ctx.nowUtc
    );
    intentId = Number(inserted.lastInsertRowid);
  }
  return { ok: true, value: { observationId, disposition: storedDisposition, ingestSeq, intentId } };
}

/**
 * Validates, deduplicates and stores one observation. A refusal names a code and, at most, a
 * field name; a counted refusal also commits its gap. Storage errors propagate to the caller.
 */
export function ingestObservationRecord(
  conn: NodeSqliteConnection,
  input: AccountingObservationInput,
  ctx: IngestContext
): AccountingResult<StoredObservation> {
  const normalized = normalizeObservation(input, { workspaceId: ctx.workspaceId, nowUtc: ctx.nowUtc, bounds: ctx.bounds });
  if (!normalized.ok) {
    const { code, detail, gap } = normalized.refusal;
    if (gap !== undefined) {
      const raw: unknown = input;
      const scope = gapScopeOf(typeof raw === 'object' && raw !== null ? (raw as { attemptId?: unknown }).attemptId : undefined);
      inImmediateTransaction(conn, () => recordGap(conn, gap, scope, ctx.nowUtc, ctx.bounds.maxGapKeys));
    }
    return refusal(code, detail);
  }
  return inImmediateTransaction(conn, () => storeNormalized(conn, normalized.observation, ctx));
}
