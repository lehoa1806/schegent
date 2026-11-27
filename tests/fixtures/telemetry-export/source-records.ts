// FR-R6-F14 T003 — builders for synthetic source records (source schema 1). Every value here
// is made up for the tests; none comes from a provider, a workspace or a Run.
import type {
  CorrectionSourceRecord,
  ExportCorrection,
  ExportMeasure,
  OperationSourceRecord,
  UsageSourceRecord
} from '../../../src/contracts/telemetry-export';

const BASE = {
  sourceSchema: 1,
  sourceRevision: 0,
  backend: 'claude',
  modelRequested: 'model-large',
  modelReported: 'model-large-20260101'
} as const;

export function measure(overrides: Partial<ExportMeasure> = {}): ExportMeasure {
  return {
    measure: 'input_tokens',
    quantity: '1024',
    unit: 'count',
    completeness: 'known',
    provenance: 'provider-reported',
    cacheRelation: null,
    ...overrides
  };
}

export function cost(quantity: string | null, unit = 'USD', overrides: Partial<ExportMeasure> = {}): ExportMeasure {
  return measure({ measure: 'cost', quantity, unit, ...overrides });
}

export function usageRecord(overrides: Partial<UsageSourceRecord> = {}): UsageSourceRecord {
  return { ...BASE, kind: 'usage', sourceId: 'usage-0001', measures: [measure()], ...overrides };
}

export function operationRecord(overrides: Partial<OperationSourceRecord> = {}): OperationSourceRecord {
  return { ...BASE, kind: 'operation', sourceId: 'attempt-0001', durationMs: 1500, outcome: 'succeeded', ...overrides };
}

export function correctionRecord(
  correction: Partial<ExportCorrection> = {},
  overrides: Partial<CorrectionSourceRecord> = {}
): CorrectionSourceRecord {
  return {
    ...BASE,
    kind: 'correction',
    sourceId: 'usage-0001',
    sourceRevision: 1,
    correction: { measure: 'output_tokens', unit: 'count', previousQuantity: '10', replacementQuantity: '12', ...correction },
    ...overrides
  };
}

/** `count` usage records with distinct source identities, one input-token measure each. */
export function usageRecords(count: number, prefix = 'usage'): UsageSourceRecord[] {
  return Array.from({ length: count }, (_unused, index) => usageRecord({ sourceId: `${prefix}-${String(index).padStart(5, '0')}` }));
}
