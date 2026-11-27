/**
 * FR-R6-F14 (FR-003, FR-007, FR-008) — the boundary between a source row and the exporter.
 * `parseSourceRecord` builds an `ExportSourceRecord` from an untrusted value and copies only
 * the fields the shape names, so a workspace, root, Run, attempt, session, phase or workflow
 * identifier, a path or any content on the value it was given cannot be queued.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  EXPORT_COMPLETENESS_VALUES,
  EXPORT_RECORD_KINDS,
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_SOURCE_SCHEMA,
  type ExportCorrection,
  type ExportMeasure,
  type ExportSourceRecord
} from '../../contracts/telemetry-export';
import {
  ATTEMPT_OUTCOMES,
  CACHE_RELATIONS,
  COUNT_MEASURES,
  MEASURES,
  PROVENANCE_VALUES,
  type Measure
} from '../../contracts/usage-accounting/accounting-types';

export type ParsedSourceRecord =
  | { readonly kind: 'record'; readonly record: ExportSourceRecord }
  | { readonly kind: 'unsupported-schema' }
  | { readonly kind: 'invalid' };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Decimal text: `0`, or a non-zero digit followed by at most 18 digits. */
const QUANTITY = /^(0|[1-9][0-9]{0,18})$/;
const COUNT_UNIT = 'count';
const CURRENCY_UNIT = /^[A-Z]{3}$/;
/** The unit rule of the usage ledger for `credits`, which this mapping does not export. */
const CREDIT_UNIT = /^[a-z][a-z0-9._-]{0,31}$/;

const INVALID: ParsedSourceRecord = Object.freeze({ kind: 'invalid' });
const UNSUPPORTED_SCHEMA: ParsedSourceRecord = Object.freeze({ kind: 'unsupported-schema' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isQuantityOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && QUANTITY.test(value));
}

function isUnitOf(measure: Measure, unit: unknown): unit is string {
  if (typeof unit !== 'string') return false;
  if (COUNT_MEASURES.has(measure)) return unit === COUNT_UNIT;
  return measure === 'cost' ? CURRENCY_UNIT.test(unit) : CREDIT_UNIT.test(unit);
}

/** `null` for an absent value, the text for a string, `undefined` for anything else. */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readMeasure(value: unknown): ExportMeasure | undefined {
  if (!isRecord(value)) return undefined;
  const { measure, quantity, unit, completeness, provenance } = value;
  const cacheRelation = value.cacheRelation ?? null;
  if (!oneOf(MEASURES, measure) || !isUnitOf(measure, unit) || !isQuantityOrNull(quantity)) return undefined;
  if (!oneOf(EXPORT_COMPLETENESS_VALUES, completeness) || !oneOf(PROVENANCE_VALUES, provenance)) return undefined;
  if (cacheRelation !== null && !oneOf(CACHE_RELATIONS, cacheRelation)) return undefined;
  return Object.freeze({ measure, quantity, unit, completeness, provenance, cacheRelation });
}

function readMeasures(value: unknown): readonly ExportMeasure[] | undefined {
  if (!Array.isArray(value) || value.length > TELEMETRY_EXPORT_BOUNDS.measuresPerRecordMax) return undefined;
  const measures: ExportMeasure[] = [];
  for (const entry of value) {
    const measure = readMeasure(entry);
    if (measure === undefined) return undefined;
    measures.push(measure);
  }
  return Object.freeze(measures);
}

function readCorrection(value: unknown): ExportCorrection | undefined {
  if (!isRecord(value)) return undefined;
  const { measure, unit, previousQuantity, replacementQuantity } = value;
  if (!oneOf(MEASURES, measure) || !isUnitOf(measure, unit)) return undefined;
  if (!isQuantityOrNull(previousQuantity) || !isQuantityOrNull(replacementQuantity)) return undefined;
  return Object.freeze({ measure, unit, previousQuantity, replacementQuantity });
}

function isDurationOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function readRecord(value: Record<string, unknown>): ExportSourceRecord | undefined {
  const { kind, sourceId, sourceRevision, backend } = value;
  const modelRequested = optionalText(value.modelRequested);
  const modelReported = optionalText(value.modelReported);
  if (!oneOf(EXPORT_RECORD_KINDS, kind)) return undefined;
  if (typeof sourceId !== 'string' || !IDENTIFIER.test(sourceId)) return undefined;
  if (typeof sourceRevision !== 'number' || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) return undefined;
  if (typeof backend !== 'string' || modelRequested === undefined || modelReported === undefined) return undefined;
  const base = { sourceSchema: TELEMETRY_SOURCE_SCHEMA, sourceId, sourceRevision, backend, modelRequested, modelReported };
  if (kind === 'usage') {
    const measures = readMeasures(value.measures);
    return measures === undefined ? undefined : Object.freeze({ ...base, kind, measures });
  }
  if (kind === 'operation') {
    const { durationMs, outcome } = value;
    if (!isDurationOrNull(durationMs) || !oneOf(ATTEMPT_OUTCOMES, outcome)) return undefined;
    return Object.freeze({ ...base, kind, durationMs, outcome });
  }
  const correction = readCorrection(value.correction);
  return correction === undefined ? undefined : Object.freeze({ ...base, kind, correction });
}

/**
 * Builds a source record from an untrusted value. A supported record is a frozen copy of the
 * named fields; a record of another source schema is reported as such, whatever else it holds;
 * everything else is `invalid`. Never throws.
 */
export function parseSourceRecord(value: unknown): ParsedSourceRecord {
  try {
    if (!isRecord(value)) return INVALID;
    const { sourceSchema } = value;
    if (typeof sourceSchema !== 'number' || !Number.isInteger(sourceSchema)) return INVALID;
    if (sourceSchema !== TELEMETRY_SOURCE_SCHEMA) return UNSUPPORTED_SCHEMA;
    const record = readRecord(value);
    return record === undefined ? INVALID : Object.freeze({ kind: 'record', record });
  } catch {
    // A getter or proxy on the value threw: the value is not a record this boundary accepts.
    return INVALID;
  }
}
