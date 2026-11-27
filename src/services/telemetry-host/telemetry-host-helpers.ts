/**
 * Pure and SQLite-normalization helpers shared by `telemetry-host-service.ts`.
 *
 * Intentionally does NOT import `src/services/telemetry-export` (`expansion-freeze.test.ts`)
 * and has zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';

import {
  COVERAGE_OUTCOMES,
  DROP_REASONS,
  EXPIRY_REASONS,
  TELEMETRY_MAPPING_REVISION,
  TELEMETRY_PROTOCOL_REVISION,
  TELEMETRY_SEMANTIC_CONVENTIONS,
  TELEMETRY_SOURCE_SCHEMA,
  type CoverageOutcome,
  type DeliveryHealth,
  type DropReason,
  type ExpiryReason,
  type ExportCompleteness,
  type ExportMeasure,
  type ExportSourceRecord,
  type ProfileEvaluation,
  type ProfileRefusalReason,
  type ResolvedDestination,
  type TelemetryContentPolicy,
  type TelemetryProtocol
} from '../../contracts/telemetry-export';
import type {
  CacheRelation,
  Measure,
  Provenance
} from '../../contracts/usage-accounting/accounting-types';
import type { SqliteApplicationStore } from '../sqlite-store';
import { sanitizeDimension } from '../usage-accounting/dimension-sanitizer';

export interface TelemetryUserSettingsInput {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly protocol: TelemetryProtocol | string;
  readonly allowPlaintextLoopback: boolean;
  readonly credentialSecretKey: string;
  readonly credentialHeaderName: string;
  readonly contentPolicy: TelemetryContentPolicy | string;
  readonly profileRevision?: number;
}

export type NormalizedTelemetryContentPolicy = TelemetryContentPolicy | 'invalid';

export interface TelemetryExportPreview {
  readonly requestedContentPolicy: NormalizedTelemetryContentPolicy;
  readonly effectiveStatus: 'disabled' | 'authorized-metadata-only' | 'refused';
  readonly refusalReason: ProfileRefusalReason | null;
  readonly contentExportSupported: false;
  readonly mappingRevision: typeof TELEMETRY_MAPPING_REVISION;
  readonly protocolRevision: typeof TELEMETRY_PROTOCOL_REVISION;
  readonly semanticConventionsRevision: typeof TELEMETRY_SEMANTIC_CONVENTIONS;
  readonly allowlistedFields: readonly string[];
  readonly excludedCategories: readonly string[];
  readonly redactionLimitsDisclosure: string;
}

export const ALLOWLISTED_FIELDS: readonly string[] = Object.freeze([
  'sourceSchema',
  'kind',
  'sourceId(hashed-correlation-id)',
  'sourceRevision',
  'backend',
  'modelRequested',
  'modelReported',
  'measures(measure,quantity,unit,completeness,provenance,cacheRelation)',
  'durationMs',
  'outcome',
  'correction(measure,unit,previousQuantity,replacementQuantity)'
]);

export const EXCLUDED_CATEGORIES: readonly string[] = Object.freeze([
  'prompts',
  'responses',
  'tool-arguments',
  'transcript-text',
  'credentials',
  'workspace-paths',
  'home-paths',
  'workspace-root-run-attempt-session-phase-workflow-ids'
]);

export const REDACTION_LIMITS_DISCLOSURE =
  'Pattern-based redaction provides risk reduction rather than a guarantee. Mapping revision 1 exports allowlisted aggregate accounting metadata only (`metadata-only`) and refuses `content` export (`content-export-unsupported`). Enabling metadata export never enables prompt or response capture and never alters local transcript retention.';

export function emptyDisabledHealth(
  extraDropped?: Readonly<Partial<Record<DropReason, number>>>,
  extraExpired?: Readonly<Partial<Record<ExpiryReason, number>>>
): DeliveryHealth {
  const dropReasons = Object.fromEntries(
    DROP_REASONS.map((r) => [r, extraDropped?.[r] ?? 0])
  ) as Record<DropReason, number>;
  const expiryReasons = Object.fromEntries(
    EXPIRY_REASONS.map((r) => [r, extraExpired?.[r] ?? 0])
  ) as Record<ExpiryReason, number>;
  const coverage = Object.fromEntries(
    COVERAGE_OUTCOMES.map((c) => [c, 0])
  ) as Record<CoverageOutcome, number>;
  const droppedBatches = Object.values(dropReasons).reduce((a, b) => a + b, 0);
  const expiredBatches = Object.values(expiryReasons).reduce((a, b) => a + b, 0);
  return Object.freeze({
    state: 'disabled',
    mappingRevision: TELEMETRY_MAPPING_REVISION,
    lastSuccessAt: null,
    queuedBatches: 0,
    queuedBytes: 0,
    acknowledgedBatches: 0,
    expiredBatches,
    droppedBatches,
    dropReasons: Object.freeze(dropReasons),
    expiryReasons: Object.freeze(expiryReasons),
    duplicateRecords: 0,
    unsupportedSchemaRecords: 0,
    invalidRecords: 0,
    refusedOffers: 0,
    rejectedDataPoints: 0,
    ledgerFaults: 0,
    lastError: null,
    coverage: Object.freeze(coverage)
  });
}

export function buildProfileObjectFromUserSettings(
  settings: TelemetryUserSettingsInput
): Record<string, unknown> {
  const secretRef = settings.credentialSecretKey.trim();
  const credential =
    secretRef.length > 0
      ? {
          reference: secretRef,
          headerName: settings.credentialHeaderName
        }
      : null;
  return {
    id: 'user-default',
    revision: settings.profileRevision ?? 1,
    enabled: settings.enabled === true,
    scope: 'user',
    protocol: settings.protocol,
    signals: ['metrics'],
    contentPolicy: settings.contentPolicy,
    endpoint: settings.endpoint.trim(),
    allowPlaintextLoopback: settings.allowPlaintextLoopback === true,
    credential
  };
}

export function normalizeContentPolicy(raw: unknown): NormalizedTelemetryContentPolicy {
  if (raw === 'metadata-only' || raw === 'content') return raw;
  return 'invalid';
}

export function formatTelemetryExportPreview(
  requestedContentPolicy: NormalizedTelemetryContentPolicy,
  evaluation: ProfileEvaluation
): TelemetryExportPreview {
  return Object.freeze({
    requestedContentPolicy,
    effectiveStatus:
      evaluation.kind === 'authorized'
        ? 'authorized-metadata-only'
        : evaluation.kind === 'refused'
          ? 'refused'
          : 'disabled',
    refusalReason: evaluation.kind === 'refused' ? evaluation.reason : null,
    contentExportSupported: false,
    mappingRevision: TELEMETRY_MAPPING_REVISION,
    protocolRevision: TELEMETRY_PROTOCOL_REVISION,
    semanticConventionsRevision: TELEMETRY_SEMANTIC_CONVENTIONS,
    allowlistedFields: ALLOWLISTED_FIELDS,
    excludedCategories: EXCLUDED_CATEGORIES,
    redactionLimitsDisclosure: REDACTION_LIMITS_DISCLOSURE
  });
}

export function stableSourceCorrelationId(prefix: string, rawId: string): string {
  const hex = createHash('sha256').update(`${prefix}\n${rawId}`, 'utf8').digest('hex').slice(0, 32);
  return `${prefix}-${hex}`;
}

export function normalizeAcceptedObservationFromSqlite(
  sqliteStore: SqliteApplicationStore,
  observationId: string
): ExportSourceRecord | null {
  const conn = sqliteStore.writerConnection;
  const obs = conn.get<{
    observation_id: string;
    observation_revision: number;
    backend: string | null;
    model_requested: string | null;
    model_reported: string | null;
  }>(
    `SELECT observation_id, observation_revision, backend, model_requested, model_reported
     FROM accounting_observations
     WHERE observation_id = ?`,
    observationId
  );
  if (obs === undefined) return null;

  const measureRows = conn.all<{
    measure: Measure;
    quantity: number | null;
    unit: string;
    completeness: ExportCompleteness;
    provenance: Provenance;
    cache_relation: CacheRelation | null;
  }>(
    `SELECT measure, quantity, unit, completeness, provenance, cache_relation
     FROM accounting_observation_measures
     WHERE observation_id = ?
     ORDER BY measure ASC`,
    observationId
  );

  const measures: ExportMeasure[] = measureRows.map((m) =>
    Object.freeze({
      measure: m.measure,
      quantity: m.quantity === null ? null : String(m.quantity),
      unit: m.unit,
      completeness: m.completeness,
      provenance: m.provenance,
      cacheRelation: m.cache_relation
    })
  );

  return Object.freeze({
    sourceSchema: TELEMETRY_SOURCE_SCHEMA,
    kind: 'usage',
    sourceId: stableSourceCorrelationId('obs', obs.observation_id),
    sourceRevision: obs.observation_revision,
    backend: obs.backend ?? 'unknown',
    modelRequested: obs.model_requested,
    modelReported: obs.model_reported,
    measures: Object.freeze(measures)
  });
}

export function destinationMatches(a: ResolvedDestination | null, b: ResolvedDestination | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.profileId === b.profileId &&
    a.profileRevision === b.profileRevision &&
    a.endpoint === b.endpoint &&
    a.plaintextLoopback === b.plaintextLoopback &&
    (a.credential?.reference ?? null) === (b.credential?.reference ?? null) &&
    (a.credential?.headerName ?? null) === (b.credential?.headerName ?? null)
  );
}

/** Metadata-only fingerprint of an authorized destination. Never includes secret values. */
export function destinationFingerprintOf(dest: ResolvedDestination | null): string | null {
  if (dest === null) return null;
  const payload = JSON.stringify([
    'telemetry-auth-dest/1',
    dest.profileId,
    dest.profileRevision,
    dest.endpoint,
    dest.plaintextLoopback,
    dest.credential?.reference ?? '',
    dest.credential?.headerName ?? ''
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function sanitizedCardinalityDimension(name: 'backend' | 'model', raw: unknown): string {
  const result = sanitizeDimension(name, raw);
  if ('excluded' in result || result.value === null) return '';
  return result.value;
}

