/**
 * FR-R6-F14 (FR-003, FR-004, FR-006, FR-007; research R2, R3) — one source record to the
 * observations mapping revision 1 exports and the coverage outcomes it counts. A value the
 * source does not have is counted `missing`; it is never exported as zero.
 *
 * Pure. Values stay in source units (tokens, milliseconds, micros); the encoder applies the
 * instrument's divisor. A label value is sent only when it passes the usage ledger's dimension
 * rule, so a path, a credential or free text in a backend or model field is left out.
 *
 * `createRecordMapper` is the same mapping for a caller that maps many records (NFR-003): it
 * builds each distinct attribute list once, so equal lists are one frozen object.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type {
  CorrectionSourceRecord,
  CoverageOutcome,
  ExportMeasure,
  ExportSourceRecord,
  OperationSourceRecord,
  UsageSourceRecord
} from '../../contracts/telemetry-export';
import type { AttemptOutcome } from '../../contracts/usage-accounting/accounting-types';
import { sanitizeDimension, type DimensionName } from '../usage-accounting/dimension-sanitizer';
import {
  ATTRIBUTE_KEYS,
  DURATION_UNIT,
  MAPPING_REVISION_1,
  OPERATION_NAME,
  TOKEN_UNIT,
  isMappedMeasure,
  providerNameOf,
  type InstrumentId,
  type MappedMeasure
} from './mapping-revision';

export type Attribute = readonly [key: string, value: string];

export interface MappedObservation {
  readonly instrument: InstrumentId;
  /** The unit on the wire; for cost, the currency code. */
  readonly unit: string;
  /** Sorted by key; every key is in the instrument's allowlist. */
  readonly attributes: readonly Attribute[];
  /** In source units: tokens, milliseconds or micros. Signed for an adjustment. */
  readonly value: number;
}

export interface MappedRecord {
  readonly observations: readonly MappedObservation[];
  readonly coverage: readonly CoverageOutcome[];
}

const K = ATTRIBUTE_KEYS;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Quantity text has no leading zero, so text shorter than this is under the largest safe integer. */
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

const TOKEN_TYPES = Object.freeze({ input_tokens: 'input', output_tokens: 'output' } as const);
const CACHE_KINDS = Object.freeze({ cache_read_tokens: 'read', cache_creation_tokens: 'creation' } as const);
/** Outcomes of an operation that did not succeed; `error.type` carries the outcome for these. */
const ERROR_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(['failed', 'cancelled', 'interrupted']);

/** How much a record mapper keeps: label sets, lists per label set, and the longest field it looks up. */
const SHARED_LABEL_SETS_MAX = 256;
const SHARED_LISTS_PER_LABEL_SET_MAX = 64;
const SHARED_LABEL_CHARS_MAX = 256;

interface SourceLabels {
  readonly attributes: readonly Attribute[];
  /** One `excluded-dimension` per label field that failed the dimension rule. */
  readonly excluded: readonly CoverageOutcome[];
  /** The lists already built from these labels, by label choice; `null` when lists are not shared. */
  readonly lists: Map<string, readonly Attribute[]> | null;
}

export type RecordMapper = (record: ExportSourceRecord) => MappedRecord;

function byKey(left: Attribute, right: Attribute): number {
  if (left[0] === right[0]) return 0;
  return left[0] < right[0] ? -1 : 1;
}

/** Sorted by key and frozen with every entry, so a list that is shared cannot change. */
function sorted(attributes: readonly Attribute[]): readonly Attribute[] {
  return Object.freeze([...attributes].sort(byKey).map((attribute) => Object.freeze(attribute)));
}

/** The sorted list `build` makes; shared labels build the list of each label choice once. */
function listOf(labels: SourceLabels, choice: string, build: () => Attribute[]): readonly Attribute[] {
  const { lists } = labels;
  if (lists === null) return sorted(build());
  const known = lists.get(choice);
  if (known !== undefined) return known;
  const built = sorted(build());
  if (lists.size < SHARED_LISTS_PER_LABEL_SET_MAX) lists.set(choice, built);
  return built;
}

/** The value when it passes the dimension rule, `null` when absent, `undefined` when excluded. */
function dimension(name: DimensionName, raw: string | null): string | null | undefined {
  const result = sanitizeDimension(name, raw);
  return 'excluded' in result ? undefined : result.value;
}

function sourceLabels(record: ExportSourceRecord): SourceLabels {
  const attributes: Attribute[] = [];
  const excluded: CoverageOutcome[] = [];
  const backend = dimension('backend', record.backend);
  if (backend === undefined) excluded.push('excluded-dimension');
  else if (backend !== null) attributes.push([K.backend, backend], [K.providerName, providerNameOf(backend)]);
  const models: readonly (readonly [string, string | null])[] = [
    [K.requestModel, record.modelRequested],
    [K.responseModel, record.modelReported]
  ];
  for (const [key, raw] of models) {
    const model = dimension('model', raw);
    if (model === undefined) excluded.push('excluded-dimension');
    else if (model !== null) attributes.push([key, model]);
  }
  return { attributes, excluded, lists: null };
}

function isOverSafeRange(quantity: string): boolean {
  return quantity.length >= MAX_SAFE_DIGITS && BigInt(quantity) > MAX_SAFE;
}

function unitOf(measure: MappedMeasure, sourceUnit: string): string {
  return measure === 'cost' ? sourceUnit : TOKEN_UNIT;
}

function measureAttributes(entry: ExportMeasure, measure: MappedMeasure, labels: SourceLabels): readonly Attribute[] {
  const choice = `${measure}\n${entry.provenance}\n${entry.completeness}\n${entry.cacheRelation ?? ''}`;
  return listOf(labels, choice, () => {
    const attributes: Attribute[] = [...labels.attributes, [K.provenance, entry.provenance], [K.completeness, entry.completeness]];
    if (measure === 'input_tokens' || measure === 'output_tokens') {
      attributes.push([K.operationName, OPERATION_NAME], [K.tokenType, TOKEN_TYPES[measure]]);
    } else if (measure === 'cache_read_tokens' || measure === 'cache_creation_tokens') {
      attributes.push([K.cacheKind, CACHE_KINDS[measure]]);
      if (entry.cacheRelation !== null) attributes.push([K.cacheRelation, entry.cacheRelation]);
    }
    return attributes;
  });
}

function mapMeasure(entry: ExportMeasure, labels: SourceLabels): MappedObservation | CoverageOutcome {
  if (!isMappedMeasure(entry.measure)) return 'unmapped';
  if (entry.quantity === null || entry.completeness === 'unknown') return 'missing';
  if (isOverSafeRange(entry.quantity)) return 'out-of-range';
  return {
    instrument: MAPPING_REVISION_1.measures[entry.measure].instrument,
    unit: unitOf(entry.measure, entry.unit),
    attributes: measureAttributes(entry, entry.measure, labels),
    value: Number(entry.quantity)
  };
}

function mapUsage(record: UsageSourceRecord, labels: SourceLabels): MappedRecord {
  const observations: MappedObservation[] = [];
  const coverage: CoverageOutcome[] = [...labels.excluded];
  for (const entry of record.measures) {
    const mapped = mapMeasure(entry, labels);
    if (typeof mapped === 'string') {
      coverage.push(mapped);
      continue;
    }
    observations.push(mapped);
    coverage.push('exported');
  }
  return { observations, coverage };
}

function mapOperation(record: OperationSourceRecord, labels: SourceLabels): MappedRecord {
  if (record.durationMs === null) return { observations: [], coverage: [...labels.excluded, 'missing'] };
  if (record.durationMs > Number.MAX_SAFE_INTEGER) return { observations: [], coverage: [...labels.excluded, 'out-of-range'] };
  const { outcome } = record;
  const attributes = listOf(labels, `operation\n${outcome}`, () => {
    const built: Attribute[] = [...labels.attributes, [K.operationName, OPERATION_NAME], [K.operationOutcome, outcome]];
    if (ERROR_OUTCOMES.has(outcome)) built.push([K.errorType, outcome]);
    return built;
  });
  const observation: MappedObservation = {
    instrument: 'operation-duration',
    unit: DURATION_UNIT,
    attributes,
    value: record.durationMs
  };
  return { observations: [observation], coverage: [...labels.excluded, 'exported'] };
}

function mapCorrection(record: CorrectionSourceRecord, labels: SourceLabels): MappedRecord {
  const { measure, unit, previousQuantity, replacementQuantity } = record.correction;
  const none = (outcome: CoverageOutcome): MappedRecord => ({ observations: [], coverage: [...labels.excluded, outcome] });
  if (!isMappedMeasure(measure) || previousQuantity === null || replacementQuantity === null) {
    return none('correction-unquantified');
  }
  if (isOverSafeRange(previousQuantity) || isOverSafeRange(replacementQuantity)) return none('out-of-range');
  const observation: MappedObservation = {
    instrument: MAPPING_REVISION_1.measures[measure].correction,
    unit: unitOf(measure, unit),
    attributes: listOf(labels, `correction\n${measure}`, () => [...labels.attributes, [K.measure, measure]]),
    value: Number(replacementQuantity) - Number(previousQuantity)
  };
  return { observations: [observation], coverage: [...labels.excluded, 'correction'] };
}

/**
 * Maps one parsed source record. The coverage list holds one outcome per measure, operation or
 * correction, preceded by one `excluded-dimension` per label field that was left out.
 */
export function mapRecord(record: ExportSourceRecord): MappedRecord {
  return mapWith(record, sourceLabels(record));
}

function mapWith(record: ExportSourceRecord, labels: SourceLabels): MappedRecord {
  switch (record.kind) {
    case 'usage':
      return mapUsage(record, labels);
    case 'operation':
      return mapOperation(record, labels);
    case 'correction':
      return mapCorrection(record, labels);
  }
}

/**
 * `mapRecord` for a caller that maps many records. Records with the same backend and models
 * share one frozen attribute list per label choice, so equal lists can be told by identity.
 *
 * It keeps at most 256 label sets and starts again when it is full. It keeps none that had a
 * field left out, so a value that failed the dimension rule is never held.
 */
export function createRecordMapper(): RecordMapper {
  const shared = new Map<string, SourceLabels>();

  function labelsOf(record: ExportSourceRecord): SourceLabels {
    const fields = [record.backend, record.modelRequested, record.modelReported];
    if (fields.some((field) => field !== null && field.length > SHARED_LABEL_CHARS_MAX)) return sourceLabels(record);
    const key = JSON.stringify(fields);
    const known = shared.get(key);
    if (known !== undefined) return known;
    const labels = sourceLabels(record);
    if (labels.excluded.length > 0) return labels;
    if (shared.size >= SHARED_LABEL_SETS_MAX) shared.clear();
    const kept: SourceLabels = { ...labels, lists: new Map() };
    shared.set(key, kept);
    return kept;
  }

  return (record) => mapWith(record, labelsOf(record));
}
