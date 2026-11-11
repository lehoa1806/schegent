/**
 * FR-R6-F14 (FR-003, FR-004, FR-006, FR-010; research R2, R4) — one batch of metrics and its
 * OTLP/HTTP JSON encoding (opentelemetry-proto 1.7.0): delta temporality, one data point per
 * attribute set, 64-bit integers as decimal text, and a fixed order so the same observations
 * always encode to the same bytes.
 *
 * The batch keeps values in source units and applies the instrument's divisor when it encodes.
 * Its size estimate is an upper bound that does not depend on the values, so an observation
 * joining a data point that exists never grows it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  COVERAGE_OUTCOMES,
  TELEMETRY_MAPPING_REVISION,
  TELEMETRY_SEMANTIC_CONVENTIONS,
  TELEMETRY_SOURCE_SCHEMA,
  type CoverageOutcome
} from '../../contracts/telemetry-export';
import {
  ATTRIBUTE_KEYS,
  COVERAGE_UNIT,
  INSTRUMENT_IDS,
  MAPPING_REVISION_1,
  type InstrumentDefinition,
  type InstrumentId
} from './mapping-revision';

export type BatchAttribute = readonly [key: string, value: string | boolean];

export interface BatchObservation {
  readonly instrument: InstrumentId;
  /** Used only by an instrument whose unit is the currency code of the measure. */
  readonly unit: string;
  readonly attributes: readonly BatchAttribute[];
  /** In source units: tokens, milliseconds or micros. Signed for an adjustment. */
  readonly value: number;
}

/** `out-of-range`: the value, or the sum it would make, cannot be written exactly; nothing changed. */
export type AddResult = 'added' | 'out-of-range';

export interface EncodeWindow {
  readonly startTimeMs: number;
  readonly timeMs: number;
}

export interface MetricsBatch {
  add(observation: BatchObservation): AddResult;
  /** How far these observations would grow the estimate, were all of them added. */
  growthOf(observations: readonly BatchObservation[]): number;
  /** Never below the size of `encode()`, whatever the values and the window. */
  estimatedBytes(): number;
  isEmpty(): boolean;
  encode(window: EncodeWindow): Uint8Array;
}

export interface MetricsBatchOptions {
  /** Sent as `service.version` when it is a plain version string; left out otherwise. */
  readonly serviceVersion?: string;
}

const SERVICE_NAME = 'schegent';
const SCOPE_NAME = 'schegent.telemetry-export';
const SCHEMA_URL = `https://opentelemetry.io/schemas/${TELEMETRY_SEMANTIC_CONVENTIONS}`;
const SERVICE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** `AGGREGATION_TEMPORALITY_DELTA` in opentelemetry-proto. */
const DELTA_TEMPORALITY = 1;
const NANOS_PER_MS = 1_000_000n;

/** The longest text each kind of field can encode to; the estimate budgets a field at this. */
const TIME_TEXT_MAX = 24;
const INTEGER_TEXT_MAX = 20;
const NUMBER_TEXT_MAX = 25;
const SEPARATOR_BYTES = 1;
const EMPTY_LIST_BYTES = 2;

type WireValue = { readonly stringValue: string } | { readonly boolValue: boolean };

interface WireAttribute {
  readonly key: string;
  readonly value: WireValue;
}

interface PointState {
  readonly attributes: readonly WireAttribute[];
  count: number;
  sum: number;
  min: number;
  max: number;
  /** One count per bucket of a histogram; empty for a sum. */
  readonly bucketCounts: number[];
}

interface MetricState {
  readonly definition: InstrumentDefinition;
  readonly unit: string;
  readonly points: Map<string, PointState>;
}

interface WireSet {
  readonly attributes: readonly WireAttribute[];
  /** The JSON text of the attributes: the data point's key and what the attributes encode to. */
  readonly pointKey: string;
}

interface Placement extends WireSet {
  readonly definition: InstrumentDefinition;
  readonly unit: string;
  readonly metricKey: string;
}

/** Wire forms of lists that cannot change: a list frozen with every entry is converted once. */
const WIRE_SETS = new WeakMap<readonly BatchAttribute[], WireSet>();

function metricKeyOf(definition: InstrumentDefinition, unit: string): string {
  return `${definition.name}\n${unit}`;
}

/** The metric key of each instrument whose unit is fixed, built once. */
const FIXED_METRIC_KEYS: ReadonlyMap<InstrumentId, string> = new Map(
  INSTRUMENT_IDS.flatMap((id): [InstrumentId, string][] => {
    const definition = MAPPING_REVISION_1.instruments[id];
    return definition.unit === null ? [] : [[id, metricKeyOf(definition, definition.unit)]];
  })
);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stringAttribute(key: string, value: string): WireAttribute {
  return { key, value: { stringValue: value } };
}

function wireAttributes(attributes: readonly BatchAttribute[]): readonly WireAttribute[] {
  return [...attributes]
    .sort((left, right) => compare(left[0], right[0]))
    .map(([key, value]) => ({ key, value: typeof value === 'string' ? { stringValue: value } : { boolValue: value } }));
}

function wireSetOf(list: readonly BatchAttribute[]): WireSet {
  const known = WIRE_SETS.get(list);
  if (known !== undefined) return known;
  const attributes = wireAttributes(list);
  const made: WireSet = { attributes, pointKey: JSON.stringify(attributes) };
  if (Object.isFrozen(list) && list.every((attribute) => Object.isFrozen(attribute))) WIRE_SETS.set(list, made);
  return made;
}

function place(observation: BatchObservation): Placement {
  const definition = MAPPING_REVISION_1.instruments[observation.instrument];
  const unit = definition.unit ?? observation.unit;
  const { attributes, pointKey } = wireSetOf(observation.attributes);
  const metricKey = FIXED_METRIC_KEYS.get(observation.instrument) ?? metricKeyOf(definition, unit);
  return { definition, unit, metricKey, attributes, pointKey };
}

function metricShell(definition: InstrumentDefinition, unit: string, dataPoints: readonly unknown[]): unknown {
  const head = { name: definition.name, unit };
  if (definition.kind === 'histogram') {
    return { ...head, histogram: { aggregationTemporality: DELTA_TEMPORALITY, dataPoints } };
  }
  return { ...head, sum: { aggregationTemporality: DELTA_TEMPORALITY, isMonotonic: definition.monotonic, dataPoints } };
}

/** The most one data point of this instrument can encode to, its attributes aside. */
function pointBudgetOf(definition: InstrumentDefinition): number {
  const time = '9'.repeat(TIME_TEXT_MAX);
  const integer = '9'.repeat(INTEGER_TEXT_MAX);
  const number = '9'.repeat(NUMBER_TEXT_MAX);
  const head = { attributes: [], startTimeUnixNano: time, timeUnixNano: time };
  const shell =
    definition.kind === 'histogram'
      ? {
          ...head,
          count: integer,
          sum: number,
          bucketCounts: Array.from({ length: definition.bounds.length + 1 }, () => integer),
          explicitBounds: definition.bounds,
          min: number,
          max: number
        }
      : { ...head, [definition.valueField]: number };
  return jsonBytes(shell) - EMPTY_LIST_BYTES + SEPARATOR_BYTES;
}

const POINT_BUDGETS: ReadonlyMap<InstrumentId, number> = new Map(
  INSTRUMENT_IDS.map((id) => [id, pointBudgetOf(MAPPING_REVISION_1.instruments[id])])
);

function metricBudgetOf(placement: Placement): number {
  return jsonBytes(metricShell(placement.definition, placement.unit, [])) + SEPARATOR_BYTES;
}

function pointBudgetFor(observation: BatchObservation, placement: Placement): number {
  return (POINT_BUDGETS.get(observation.instrument) ?? 0) + Buffer.byteLength(placement.pointKey, 'utf8');
}

/** Whether the value can join the data point and still be written exactly. */
function accepts(definition: InstrumentDefinition, point: PointState | undefined, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const signed = definition.kind === 'sum' && !definition.monotonic;
  if (value < 0 && !signed) return false;
  if (definition.kind === 'sum' && definition.valueField === 'asInt' && !Number.isInteger(value)) return false;
  const sum = (point === undefined ? 0 : point.sum) + value;
  return Math.abs(sum) <= Number.MAX_SAFE_INTEGER;
}

/** The first bucket whose upper bound the value does not pass; the last bucket has no bound. */
function bucketOf(bounds: readonly number[], value: number): number {
  const index = bounds.findIndex((bound) => value <= bound);
  return index === -1 ? bounds.length : index;
}

function newPoint(definition: InstrumentDefinition, attributes: readonly WireAttribute[]): PointState {
  const buckets = definition.kind === 'histogram' ? definition.bounds.length + 1 : 0;
  return { attributes, count: 0, sum: 0, min: 0, max: 0, bucketCounts: Array.from({ length: buckets }, () => 0) };
}

function record(definition: InstrumentDefinition, point: PointState, value: number): void {
  point.min = point.count === 0 ? value : Math.min(point.min, value);
  point.max = point.count === 0 ? value : Math.max(point.max, value);
  point.count += 1;
  point.sum += value;
  if (definition.kind !== 'histogram') return;
  const bucket = bucketOf(definition.bounds, value / definition.divisor);
  point.bucketCounts.splice(bucket, 1, (point.bucketCounts.at(bucket) ?? 0) + 1);
}

/** Milliseconds as nanoseconds in decimal text; a value that is not a time encodes as zero. */
function nanosOf(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0';
  const whole = Math.min(Math.trunc(ms), Number.MAX_SAFE_INTEGER);
  return String(BigInt(whole) * NANOS_PER_MS);
}

function wirePoint(definition: InstrumentDefinition, point: PointState, start: string, time: string): unknown {
  const head = { attributes: point.attributes, startTimeUnixNano: start, timeUnixNano: time };
  if (definition.kind === 'histogram') {
    return {
      ...head,
      count: String(point.count),
      sum: point.sum / definition.divisor,
      bucketCounts: point.bucketCounts.map((count) => String(count)),
      explicitBounds: definition.bounds,
      min: point.min / definition.divisor,
      max: point.max / definition.divisor
    };
  }
  if (definition.valueField === 'asInt') return { ...head, asInt: String(point.sum) };
  return { ...head, asDouble: point.sum / definition.divisor };
}

function wireMetric(metric: MetricState, start: string, time: string): unknown {
  const dataPoints = [...metric.points.entries()]
    .sort((left, right) => compare(left[0], right[0]))
    .map(([, point]) => wirePoint(metric.definition, point, start, time));
  return metricShell(metric.definition, metric.unit, dataPoints);
}

function byNameThenUnit(left: MetricState, right: MetricState): number {
  return compare(left.definition.name, right.definition.name) || compare(left.unit, right.unit);
}

function envelope(serviceVersion: string | undefined, metrics: readonly unknown[]): unknown {
  const resource = [stringAttribute('service.name', SERVICE_NAME)];
  if (serviceVersion !== undefined) resource.push(stringAttribute('service.version', serviceVersion));
  const scope = {
    name: SCOPE_NAME,
    version: String(TELEMETRY_MAPPING_REVISION),
    attributes: [
      stringAttribute('schegent.export.mapping_revision', String(TELEMETRY_MAPPING_REVISION)),
      stringAttribute('schegent.export.source_schema', String(TELEMETRY_SOURCE_SCHEMA))
    ]
  };
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope, schemaUrl: SCHEMA_URL, metrics }] }] };
}

function coverageOf(outcome: CoverageOutcome): BatchObservation {
  const attributes = Object.freeze([Object.freeze([ATTRIBUTE_KEYS.coverageOutcome, outcome] as const)]);
  return Object.freeze({ instrument: 'coverage', unit: COVERAGE_UNIT, attributes, value: 1 });
}

const COVERAGE_OBSERVATIONS: ReadonlyMap<CoverageOutcome, BatchObservation> = new Map(
  COVERAGE_OUTCOMES.map((outcome) => [outcome, coverageOf(outcome)])
);

/** One count of a coverage outcome, for the coverage instrument: one frozen observation per outcome. */
export function coverageObservation(outcome: CoverageOutcome): BatchObservation {
  return COVERAGE_OBSERVATIONS.get(outcome) ?? coverageOf(outcome);
}

export function createMetricsBatch(options: MetricsBatchOptions = {}): MetricsBatch {
  const { serviceVersion: offered } = options;
  const serviceVersion = offered !== undefined && SERVICE_VERSION.test(offered) ? offered : undefined;
  const metrics = new Map<string, MetricState>();
  let estimate = jsonBytes(envelope(serviceVersion, []));

  function add(observation: BatchObservation): AddResult {
    const placement = place(observation);
    const known = metrics.get(placement.metricKey);
    const knownPoint = known === undefined ? undefined : known.points.get(placement.pointKey);
    if (!accepts(placement.definition, knownPoint, observation.value)) return 'out-of-range';
    let metric = known;
    if (metric === undefined) {
      metric = { definition: placement.definition, unit: placement.unit, points: new Map() };
      metrics.set(placement.metricKey, metric);
      estimate += metricBudgetOf(placement);
    }
    let point = knownPoint;
    if (point === undefined) {
      point = newPoint(placement.definition, placement.attributes);
      metric.points.set(placement.pointKey, point);
      estimate += pointBudgetFor(observation, placement);
    }
    record(placement.definition, point, observation.value);
    return 'added';
  }

  function growthOf(observations: readonly BatchObservation[]): number {
    const newMetrics = new Set<string>();
    const newPoints = new Set<string>();
    let growth = 0;
    for (const observation of observations) {
      const placement = place(observation);
      const known = metrics.get(placement.metricKey);
      if (known === undefined && !newMetrics.has(placement.metricKey)) {
        newMetrics.add(placement.metricKey);
        growth += metricBudgetOf(placement);
      }
      if (known !== undefined && known.points.has(placement.pointKey)) continue;
      const pointId = `${placement.metricKey}\n${placement.pointKey}`;
      if (newPoints.has(pointId)) continue;
      newPoints.add(pointId);
      growth += pointBudgetFor(observation, placement);
    }
    return growth;
  }

  function encode(window: EncodeWindow): Uint8Array {
    const start = nanosOf(window.startTimeMs);
    const time = nanosOf(window.timeMs);
    const encoded = [...metrics.values()].sort(byNameThenUnit).map((metric) => wireMetric(metric, start, time));
    return new TextEncoder().encode(JSON.stringify(envelope(serviceVersion, encoded)));
  }

  return { add, growthOf, estimatedBytes: () => estimate, isEmpty: () => metrics.size === 0, encode };
}
