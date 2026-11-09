/**
 * FR-R6-F06 (T043, FR-010, FR-019, US3) — corrections.
 *
 * A correction replaces the open contribution of its target's (attempt, invocation, measure,
 * unit) group under one new `correction` revision; it never adds to it. Earlier revisions stay
 * readable unchanged. Applying the correction the group already carries writes nothing and
 * answers the original `{ correctionId, revision }`.
 *
 * A missing target, or one whose event is past the horizon, is `beyond-correction-horizon`. A
 * contribution takes at most `maxCorrectionsPerContribution` corrections. The actor is a closed
 * vocabulary and the reason a code, so no free text is ever stored.
 *
 * Provenance: a provider correction is `provider-reported`; an operator correction is `derived`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  COUNT_MEASURES,
  CORRECTION_ACTORS,
  MEASURES,
  type AccountingResult,
  type CorrectionActor,
  type Measure
} from '../../contracts/usage-accounting/accounting-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';
import { parseCount, parseDecimalMicros } from './exact-quantities';
import { REASON_CODE, unitIsValid } from './observation-normalizer';
import { OPEN_CONTRIBUTION_KEY, appendRevision } from './projection';

export interface CorrectionRequest {
  readonly targetObservationId: string;
  readonly measure: Measure;
  readonly replacementQuantity: bigint | null;
  readonly unit: string;
  readonly reasonCode: string;
  readonly actor: CorrectionActor;
}

export interface CorrectionResult {
  readonly correctionId: number;
  readonly revision: number;
}

export interface CorrectionLimits {
  readonly horizonDays: number;
  readonly maxCorrectionsPerContribution: number;
}

const MS_PER_DAY = 86_400_000;
const OBSERVATION_ID_MAX_CHARS = 128;
const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'targetObservationId',
  'measure',
  'replacementQuantity',
  'unit',
  'reasonCode',
  'actor'
]);

interface TargetRow {
  readonly attempt_id: string | null;
  readonly invocation_ordinal: number | null;
  readonly event_utc: string;
}

interface OpenRow {
  readonly contribution_id: number;
  readonly correction_id: number | null;
}

interface CorrectionRow {
  readonly correction_id: number;
  readonly target_observation_id: string;
  readonly replacement_quantity: bigint | number | null;
  readonly reason_code: string;
  readonly actor: string;
  readonly revision: number;
}

function invalid(detail: string): AccountingResult<never> {
  return { ok: false, refusal: { code: 'invalid-correction', detail } };
}

function parseReplacement(measure: Measure, value: unknown): bigint | null | undefined {
  if (value === null) return null;
  if (COUNT_MEASURES.has(measure)) return parseCount(value);
  return parseDecimalMicros(value)?.micros;
}

function validateRequest(input: unknown): AccountingResult<CorrectionRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('request');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !REQUEST_KEYS.has(key))) return invalid('request');
  const { targetObservationId, measure, replacementQuantity, unit, reasonCode, actor } = raw;
  if (typeof targetObservationId !== 'string' || targetObservationId.length === 0 || targetObservationId.length > OBSERVATION_ID_MAX_CHARS) {
    return invalid('targetObservationId');
  }
  if (typeof measure !== 'string' || !(MEASURES as readonly string[]).includes(measure)) return invalid('measure');
  const typedMeasure = measure as Measure;
  if (!unitIsValid(typedMeasure, unit)) return invalid('unit');
  const replacement = parseReplacement(typedMeasure, replacementQuantity);
  if (replacement === undefined) return invalid('replacementQuantity');
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) return invalid('reasonCode');
  if (typeof actor !== 'string' || !(CORRECTION_ACTORS as readonly string[]).includes(actor)) return invalid('actor');
  return {
    ok: true,
    value: {
      targetObservationId,
      measure: typedMeasure,
      replacementQuantity: replacement,
      unit: unit as string,
      reasonCode,
      actor: actor as CorrectionActor
    }
  };
}

function sameCorrection(row: CorrectionRow, request: CorrectionRequest): boolean {
  const stored = row.replacement_quantity === null ? null : BigInt(row.replacement_quantity);
  return (
    row.target_observation_id === request.targetObservationId &&
    stored === request.replacementQuantity &&
    row.reason_code === request.reasonCode &&
    row.actor === request.actor
  );
}

function correctionsOnGroup(conn: NodeSqliteConnection, target: TargetRow, request: CorrectionRequest): number {
  return Number(
    conn.scalar(
      `SELECT count(*) FROM accounting_corrections c
         JOIN accounting_observations o ON o.observation_id = c.target_observation_id
        WHERE o.attempt_id = ? AND o.invocation_ordinal IS ? AND c.measure = ? AND c.unit = ?`,
      target.attempt_id,
      target.invocation_ordinal,
      request.measure,
      request.unit
    ) ?? 0
  );
}

function writeCorrection(conn: NodeSqliteConnection, target: TargetRow & { attempt_id: string }, request: CorrectionRequest, open: OpenRow | undefined, nowUtc: string): CorrectionResult {
  const revision = appendRevision(conn, 'correction', nowUtc, 0);
  conn.run(
    `INSERT INTO accounting_corrections (target_observation_id, measure, replacement_quantity, unit, reason_code, actor, recorded_utc, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    request.targetObservationId,
    request.measure,
    request.replacementQuantity,
    request.unit,
    request.reasonCode,
    request.actor,
    nowUtc,
    revision
  );
  const correctionId = Number(conn.scalar('SELECT last_insert_rowid()'));
  if (open !== undefined) {
    conn.run('UPDATE accounting_contributions SET to_revision = ? WHERE contribution_id = ?', revision, open.contribution_id);
  }
  const provenance = request.actor === 'provider' ? 'provider-reported' : 'derived';
  conn.run(
    `INSERT INTO accounting_contributions (attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, cost_origin, selected_observation_id, correction_id, from_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    target.attempt_id,
    target.invocation_ordinal,
    request.measure,
    request.unit,
    request.replacementQuantity,
    request.replacementQuantity === null ? 'unknown' : 'known',
    provenance,
    request.measure === 'cost' ? 'reported' : null,
    correctionId,
    revision
  );
  return { correctionId, revision };
}

/** Applies one correction. Validates `input`; every refusal leaves the store unchanged. */
export function applyCorrection(
  conn: NodeSqliteConnection,
  input: unknown,
  nowUtc: string,
  limits: CorrectionLimits
): AccountingResult<CorrectionResult> {
  const validated = validateRequest(input);
  if (!validated.ok) return validated;
  const request = validated.value;
  return inImmediateTransaction(conn, (): AccountingResult<CorrectionResult> => {
    const target = conn.get<TargetRow>(
      'SELECT attempt_id, invocation_ordinal, event_utc FROM accounting_observations WHERE observation_id = ?',
      request.targetObservationId
    );
    if (target === undefined) return { ok: false, refusal: { code: 'beyond-correction-horizon' } };
    if (Date.parse(target.event_utc) < Date.parse(nowUtc) - limits.horizonDays * MS_PER_DAY) {
      return { ok: false, refusal: { code: 'beyond-correction-horizon' } };
    }
    if (target.attempt_id === null) return invalid('targetObservationId');
    const measured = conn.scalar(
      'SELECT unit FROM accounting_observation_measures WHERE observation_id = ? AND measure = ?',
      request.targetObservationId,
      request.measure
    );
    if (measured === undefined) return invalid('measure');
    if (measured !== request.unit) return invalid('unit');

    const open = conn.get<OpenRow>(
      `SELECT contribution_id, correction_id FROM accounting_contributions WHERE ${OPEN_CONTRIBUTION_KEY}`,
      target.attempt_id,
      target.invocation_ordinal,
      request.measure,
      request.unit
    );
    if (open !== undefined && open.correction_id !== null) {
      const current = conn.get<CorrectionRow>(
        'SELECT correction_id, target_observation_id, replacement_quantity, reason_code, actor, revision FROM accounting_corrections WHERE correction_id = ?',
        open.correction_id
      );
      if (current !== undefined && sameCorrection(current, request)) {
        return { ok: true, value: { correctionId: Number(current.correction_id), revision: Number(current.revision) } };
      }
    }
    if (correctionsOnGroup(conn, target, request) >= limits.maxCorrectionsPerContribution) {
      return { ok: false, refusal: { code: 'correction-limit' } };
    }
    return { ok: true, value: writeCorrection(conn, { ...target, attempt_id: target.attempt_id }, request, open, nowUtc) };
  });
}
