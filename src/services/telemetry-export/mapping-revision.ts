/**
 * FR-R6-F14 (FR-003, FR-004, FR-006; research R2, R3) — mapping revision 1: the instruments,
 * their units, bucket boundaries and label allowlists, and where a correction goes. The names,
 * units and boundaries of the two `gen_ai.*` histograms are those of OpenTelemetry semantic
 * conventions 1.37.0, where they are at Development stability.
 *
 * A change to anything here is a new mapping revision, never an edit of this one.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  TELEMETRY_MAPPING_REVISION,
  TELEMETRY_PROTOCOL_REVISION,
  TELEMETRY_SEMANTIC_CONVENTIONS,
  TELEMETRY_SOURCE_SCHEMA,
  TELEMETRY_SUPPORTED_PROTOCOL
} from '../../contracts/telemetry-export';

export const INSTRUMENT_IDS = Object.freeze([
  'token-usage',
  'operation-duration',
  'cache-tokens',
  'cost',
  'token-adjustment',
  'cost-adjustment',
  'coverage'
] as const);
export type InstrumentId = (typeof INSTRUMENT_IDS)[number];

/** Every attribute key this mapping can send. */
export const ATTRIBUTE_KEYS = Object.freeze({
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  tokenType: 'gen_ai.token.type',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  errorType: 'error.type',
  backend: 'schegent.backend',
  provenance: 'schegent.usage.provenance',
  completeness: 'schegent.usage.completeness',
  cacheKind: 'schegent.usage.cache_kind',
  cacheRelation: 'schegent.usage.cache_relation',
  measure: 'schegent.usage.measure',
  operationOutcome: 'schegent.operation.outcome',
  coverageOutcome: 'schegent.export.outcome',
  /** The one attribute of the overflow set (OpenTelemetry metrics SDK specification 1.48.0). */
  overflow: 'otel.metric.overflow'
} as const);

export const OPERATION_NAME = 'invoke_agent';
export const TOKEN_UNIT = '{token}';
export const DURATION_UNIT = 's';
export const COVERAGE_UNIT = '{outcome}';

const TOKEN_USAGE_BOUNDS = Object.freeze([
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
]);
const OPERATION_DURATION_BOUNDS = Object.freeze([
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92
]);

interface InstrumentBase {
  readonly name: string;
  /** The unit, or `null` when the unit is the currency code of the measure. */
  readonly unit: string | null;
  /** What a source quantity is divided by on the wire: micros to units, milliseconds to seconds. */
  readonly divisor: 1 | 1_000 | 1_000_000;
  /** The only attribute keys a data point of this instrument may carry, the overflow key aside. */
  readonly labels: readonly string[];
}

export interface HistogramInstrument extends InstrumentBase {
  readonly kind: 'histogram';
  readonly bounds: readonly number[];
}

export interface SumInstrument extends InstrumentBase {
  readonly kind: 'sum';
  readonly monotonic: boolean;
  readonly valueField: 'asInt' | 'asDouble';
}

export type InstrumentDefinition = HistogramInstrument | SumInstrument;

const K = ATTRIBUTE_KEYS;
const SOURCE_LABELS = [K.providerName, K.requestModel, K.responseModel, K.backend] as const;
const USAGE_LABELS = [...SOURCE_LABELS, K.provenance, K.completeness] as const;

const INSTRUMENTS: Readonly<Record<InstrumentId, InstrumentDefinition>> = Object.freeze({
  'token-usage': Object.freeze({
    name: 'gen_ai.client.token.usage',
    kind: 'histogram',
    unit: TOKEN_UNIT,
    divisor: 1,
    bounds: TOKEN_USAGE_BOUNDS,
    labels: Object.freeze([K.operationName, K.tokenType, ...USAGE_LABELS])
  }),
  'operation-duration': Object.freeze({
    name: 'gen_ai.client.operation.duration',
    kind: 'histogram',
    unit: DURATION_UNIT,
    divisor: 1_000,
    bounds: OPERATION_DURATION_BOUNDS,
    labels: Object.freeze([K.operationName, K.errorType, K.operationOutcome, ...SOURCE_LABELS])
  }),
  'cache-tokens': Object.freeze({
    name: 'schegent.usage.cache_tokens',
    kind: 'sum',
    monotonic: true,
    valueField: 'asInt',
    unit: TOKEN_UNIT,
    divisor: 1,
    labels: Object.freeze([K.cacheKind, K.cacheRelation, ...USAGE_LABELS])
  }),
  cost: Object.freeze({
    name: 'schegent.usage.cost',
    kind: 'sum',
    monotonic: true,
    valueField: 'asDouble',
    unit: null,
    divisor: 1_000_000,
    labels: Object.freeze([...USAGE_LABELS])
  }),
  'token-adjustment': Object.freeze({
    name: 'schegent.usage.token_adjustment',
    kind: 'sum',
    monotonic: false,
    valueField: 'asInt',
    unit: TOKEN_UNIT,
    divisor: 1,
    labels: Object.freeze([K.measure, ...SOURCE_LABELS])
  }),
  'cost-adjustment': Object.freeze({
    name: 'schegent.usage.cost_adjustment',
    kind: 'sum',
    monotonic: false,
    valueField: 'asDouble',
    unit: null,
    divisor: 1_000_000,
    labels: Object.freeze([K.measure, ...SOURCE_LABELS])
  }),
  coverage: Object.freeze({
    name: 'schegent.export.coverage',
    kind: 'sum',
    monotonic: true,
    valueField: 'asInt',
    unit: COVERAGE_UNIT,
    divisor: 1,
    labels: Object.freeze([K.coverageOutcome])
  })
});

/**
 * Where each source measure goes, and where its corrections go. A measure that is absent here
 * is not exported and is counted `unmapped`. A correction never changes a usage instrument: its
 * signed difference goes to the adjustment instrument (research R3).
 */
const MEASURE_ROUTES = Object.freeze({
  input_tokens: Object.freeze({ instrument: 'token-usage', correction: 'token-adjustment' }),
  output_tokens: Object.freeze({ instrument: 'token-usage', correction: 'token-adjustment' }),
  cache_read_tokens: Object.freeze({ instrument: 'cache-tokens', correction: 'token-adjustment' }),
  cache_creation_tokens: Object.freeze({ instrument: 'cache-tokens', correction: 'token-adjustment' }),
  cost: Object.freeze({ instrument: 'cost', correction: 'cost-adjustment' })
} as const);

export type MappedMeasure = keyof typeof MEASURE_ROUTES;

export function isMappedMeasure(measure: string): measure is MappedMeasure {
  return Object.hasOwn(MEASURE_ROUTES, measure);
}

/** Backends whose provider has a well-known `gen_ai.provider.name`; any other keeps its own name. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({ claude: 'anthropic', codex: 'openai' });

export function providerNameOf(backend: string): string {
  return Object.hasOwn(PROVIDER_NAMES, backend) ? (PROVIDER_NAMES[backend] ?? backend) : backend;
}

export const MAPPING_REVISION_1 = Object.freeze({
  mappingRevision: TELEMETRY_MAPPING_REVISION,
  sourceSchema: TELEMETRY_SOURCE_SCHEMA,
  semanticConventions: TELEMETRY_SEMANTIC_CONVENTIONS,
  protocolRevision: TELEMETRY_PROTOCOL_REVISION,
  protocol: TELEMETRY_SUPPORTED_PROTOCOL,
  temporality: 'delta',
  instruments: INSTRUMENTS,
  measures: MEASURE_ROUTES
} as const);
