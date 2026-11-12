/**
 * FR-R6-F14 (F14-B: FR-001..FR-019; NFR-001..NFR-007; AC-01..AC-10) — editor-independent
 * host telemetry coordinator.
 *
 * This is the single module outside `src/services/telemetry-export/` permitted to import
 * `src/services/telemetry-export` (`tests/lint/expansion-freeze.test.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  COVERAGE_OUTCOMES,
  DROP_REASONS,
  EXPIRY_REASONS,
  TELEMETRY_EXPORT_BOUNDS,
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
  type ExporterClock,
  type ExporterTimers,
  type OfferResult,
  type ProfileEvaluation,
  type ProfileEvaluationContext,
  type ProfileRefusalReason,
  type ResolvedDestination,
  type TelemetryContentPolicy,
  type TelemetryExporter,
  type TelemetryLedgerPort,
  type TelemetryProtocol,
  type TelemetrySecretPort,
  type TelemetryTransport
} from '../../contracts/telemetry-export';
import type {
  AttemptOutcome,
  CacheRelation,
  Measure,
  Provenance
} from '../../contracts/usage-accounting/accounting-types';
import type { SqliteApplicationStore } from '../sqlite-store';
import {
  classifyDelivery,
  createOtlpHttpTransport,
  createTelemetryExporter,
  evaluateProfiles,
  type NameLookup
} from '../telemetry-export';
import {
  createSqliteTelemetryLedger,
  createTelemetrySpoolStore,
  type SqliteTelemetryLedger,
  type TelemetrySpoolStore
} from './telemetry-durable-store';

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

export interface TelemetryExportPreview {
  readonly requestedContentPolicy: string;
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

export interface TelemetryHostStatus {
  readonly evaluation: ProfileEvaluation;
  readonly authorizationGeneration: number;
  readonly health: DeliveryHealth;
  readonly spooledBatches: number;
  readonly spooledBytes: number;
  readonly mappingRevision: typeof TELEMETRY_MAPPING_REVISION;
  readonly protocolRevision: typeof TELEMETRY_PROTOCOL_REVISION;
  readonly semanticConventionsRevision: typeof TELEMETRY_SEMANTIC_CONVENTIONS;
  readonly preview: TelemetryExportPreview;
}

export interface TelemetryHostServiceDeps {
  readonly sqliteStore: SqliteApplicationStore;
  readonly storageRoot: string;
  readonly secrets: TelemetrySecretPort | null;
  readonly isWorkspaceTrusted: () => boolean;
  readonly serviceVersion?: string;
  readonly transport?: TelemetryTransport;
  readonly lookup?: NameLookup;
  readonly clock?: ExporterClock;
  readonly timers?: ExporterTimers;
  readonly random?: () => number;
}

export interface TelemetryHostService {
  configureFromUserSettings(settings: TelemetryUserSettingsInput): ProfileEvaluation;
  configureFromRawProfiles(
    profiles: readonly unknown[],
    previewPolicy?: string
  ): ProfileEvaluation;
  offerRecords(records: readonly unknown[]): OfferResult;
  offerAcceptedObservationById(observationId: string): OfferResult;
  offerAcceptedAttemptOutcome(params: {
    readonly attemptId: string;
    readonly outcome: AttemptOutcome;
    readonly durationMs: number | null;
    readonly revision: number;
  }): OfferResult;
  offerAcceptedCorrection(params: {
    readonly correctionId: number;
    readonly previousQuantity: number | null;
  }): OfferResult;
  reconcileAndReplaySpool(): Promise<{
    readonly replayed: number;
    readonly acknowledged: number;
    readonly dropped: number;
    readonly expired: number;
  }>;
  flush(): void;
  disable(): void;
  idle(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus(): TelemetryHostStatus;
  readonly ledger: SqliteTelemetryLedger;
  readonly spool: TelemetrySpoolStore;
}

const ALLOWLISTED_FIELDS: readonly string[] = Object.freeze([
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

const EXCLUDED_CATEGORIES: readonly string[] = Object.freeze([
  'prompts',
  'responses',
  'tool-arguments',
  'transcript-text',
  'credentials',
  'workspace-paths',
  'home-paths',
  'workspace-root-run-attempt-session-phase-workflow-ids'
]);

const REDACTION_LIMITS_DISCLOSURE =
  'Pattern-based redaction provides risk reduction rather than a guarantee. Mapping revision 1 exports allowlisted aggregate accounting metadata only (`metadata-only`) and refuses `content` export (`content-export-unsupported`). Enabling metadata export never enables prompt or response capture and never alters local transcript retention.';

function emptyDisabledHealth(extraDropped?: Readonly<Partial<Record<DropReason, number>>>, extraExpired?: Readonly<Partial<Record<ExpiryReason, number>>>): DeliveryHealth {
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

export function buildTelemetryExportPreview(
  settings: TelemetryUserSettingsInput,
  context: ProfileEvaluationContext
): TelemetryExportPreview {
  const profile = buildProfileObjectFromUserSettings(settings);
  const evaluation = evaluateProfiles([profile], context);
  return Object.freeze({
    requestedContentPolicy: String(settings.contentPolicy),
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

function stableSourceCorrelationId(prefix: string, rawId: string): string {
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

function destinationMatches(a: ResolvedDestination | null, b: ResolvedDestination | null): boolean {
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

export function createTelemetryHostService(deps: TelemetryHostServiceDeps): TelemetryHostService {
  const clock: ExporterClock = deps.clock ?? { now: () => Date.now() };
  const timers: ExporterTimers = deps.timers ?? {
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const random = deps.random ?? (() => Math.random());

  const ledger = createSqliteTelemetryLedger(deps.sqliteStore, () => clock.now());
  const spool = createTelemetrySpoolStore({
    sqliteStore: deps.sqliteStore,
    storageRoot: deps.storageRoot,
    nowMs: () => clock.now()
  });

  let evaluation: ProfileEvaluation = Object.freeze({ kind: 'disabled' });
  let activeDestination: ResolvedDestination | null = null;
  let authorizationGeneration = ledger.readAuthorizationGeneration();
  let lastPreviewPolicy = 'metadata-only';
  let transport: TelemetryTransport | null = null;
  let exporter: TelemetryExporter | null = null;
  let lastFailedBody: Uint8Array | null = null;

  const spoolDropCounts: Partial<Record<DropReason, number>> = {};
  const spoolExpiryCounts: Partial<Record<ExpiryReason, number>> = {};

  function recordSpoolDrop(batchId: string, reason: DropReason): void {
    spoolDropCounts[reason] = (spoolDropCounts[reason] ?? 0) + 1;
    try {
      ledger.recordDisposition(batchId, 'dropped', reason);
    } catch {
      // Guarded durability write.
    }
  }

  function recordSpoolExpiry(batchId: string, reason: ExpiryReason): void {
    spoolExpiryCounts[reason] = (spoolExpiryCounts[reason] ?? 0) + 1;
    try {
      ledger.recordDisposition(batchId, 'expired', reason);
    } catch {
      // Guarded durability write.
    }
  }

  function evaluationContext(): ProfileEvaluationContext {
    return {
      workspaceTrusted: deps.isWorkspaceTrusted(),
      secretStore: deps.secrets === null ? 'absent' : deps.secrets.availability()
    };
  }

  function ensureTransport(): TelemetryTransport {
    if (transport !== null) return transport;
    if (deps.transport !== undefined) {
      transport = deps.transport;
      return transport;
    }
    transport = createOtlpHttpTransport(deps.lookup === undefined ? {} : { lookup: deps.lookup });
    return transport;
  }

  function ensureExporter(): TelemetryExporter {
    if (exporter !== null) return exporter;
    const underlyingTransport = ensureTransport();
    const wrappedTransport: TelemetryTransport = {
      async send(req) {
        const res = await underlyingTransport.send(req);
        const verdict = classifyDelivery(res);
        if (verdict.outcome === 'retry') {
          lastFailedBody = req.body;
        } else if (verdict.outcome === 'acknowledged') {
          lastFailedBody = null;
        }
        return res;
      }
    };

    const interceptedLedger: TelemetryLedgerPort = {
      rememberCopy(copyId) {
        return ledger.rememberCopy(copyId);
      },
      recordReceipt(receipt) {
        ledger.recordReceipt(receipt);
      },
      recordDisposition(batchId, state, reason) {
        ledger.recordDisposition(batchId, state, reason);
        if (
          state === 'expired' &&
          reason === 'retry-budget-exhausted' &&
          lastFailedBody !== null &&
          activeDestination !== null
        ) {
          const bodyToSpool = lastFailedBody;
          const destSnapshot = activeDestination;
          const genSnapshot = authorizationGeneration;
          lastFailedBody = null;
          void spool
            .spoolBatch({
              batchId,
              destination: destSnapshot,
              authorizationGeneration: genSnapshot,
              body: bodyToSpool
            })
            .then((spooled) => {
              for (const evictedId of spooled.droppedBatchIds) {
                recordSpoolDrop(evictedId, 'queue-saturated');
              }
            });
        }
      }
    };

    exporter = createTelemetryExporter({
      transport: wrappedTransport,
      clock,
      timers,
      random,
      secrets: deps.secrets,
      ledger: interceptedLedger,
      ...(deps.serviceVersion !== undefined ? { serviceVersion: deps.serviceVersion } : {})
    });
    return exporter;
  }

  function applyEvaluation(nextEval: ProfileEvaluation): ProfileEvaluation {
    const nextDest = nextEval.kind === 'authorized' ? nextEval.destination : null;
    const changed = !destinationMatches(activeDestination, nextDest);

    if (changed && (activeDestination !== null || nextDest !== null)) {
      authorizationGeneration = ledger.bumpAuthorizationGeneration();
    }
    evaluation = nextEval;
    activeDestination = nextDest;

    if (nextDest === null) {
      lastFailedBody = null;
      if (exporter !== null) {
        exporter.configure(nextEval, authorizationGeneration);
      }
      // Revoke any spooled batches if any exist in SQLite without creating directories in disabled mode.
      if (spool.stats().spooledBatches > 0) {
        void spool.reconcileForDestination({
          activeDestination: null,
          authorizationGeneration,
          onDropped: recordSpoolDrop,
          onExpired: recordSpoolExpiry
        });
      }
      return evaluation;
    }

    ledger.setActiveProfileId(nextDest.profileId);
    const exp = ensureExporter();
    exp.configure(nextEval, authorizationGeneration);
    if (spool.stats().spooledBatches > 0) {
      void spool.reconcileForDestination({
        activeDestination: nextDest,
        authorizationGeneration,
        onDropped: recordSpoolDrop,
        onExpired: recordSpoolExpiry
      });
    }
    return evaluation;
  }

  function trackDurableCardinality(records: readonly unknown[]): void {
    if (activeDestination === null) return;
    const profileId = activeDestination.profileId;
    for (const raw of records) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const rec = raw as Partial<ExportSourceRecord>;
      if (typeof rec.backend !== 'string') continue;
      const key = JSON.stringify([
        rec.backend,
        rec.modelRequested ?? '',
        rec.modelReported ?? '',
        rec.kind ?? ''
      ]);
      ledger.admitCardinalitySet({
        profileId,
        mappingRevision: TELEMETRY_MAPPING_REVISION,
        instrument: rec.kind === 'operation' ? 'operation-duration' : 'token-usage',
        attributeSetKey: key
      });
    }
  }

  return {
    ledger,
    spool,

    configureFromUserSettings(settings) {
      lastPreviewPolicy = String(settings.contentPolicy);
      const profile = buildProfileObjectFromUserSettings(settings);
      return applyEvaluation(evaluateProfiles([profile], evaluationContext()));
    },

    configureFromRawProfiles(profiles, previewPolicy = 'metadata-only') {
      lastPreviewPolicy = previewPolicy;
      return applyEvaluation(evaluateProfiles(profiles, evaluationContext()));
    },

    offerRecords(records) {
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: Array.isArray(records) ? records.length : 0 };
      }
      try {
        trackDurableCardinality(records);
        return exporter.offer(records);
      } catch {
        return { accepted: 0, duplicate: 0, refused: records.length };
      }
    },

    offerAcceptedObservationById(observationId) {
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: 0 };
      }
      try {
        const record = normalizeAcceptedObservationFromSqlite(deps.sqliteStore, observationId);
        if (record === null) return { accepted: 0, duplicate: 0, refused: 0 };
        trackDurableCardinality([record]);
        return exporter.offer([record]);
      } catch {
        return { accepted: 0, duplicate: 0, refused: 1 };
      }
    },

    offerAcceptedAttemptOutcome(params) {
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: 0 };
      }
      try {
        const attempt = deps.sqliteStore.writerConnection.get<{
          backend: string | null;
          model: string | null;
        }>(
          `SELECT backend, model FROM accounting_attempts WHERE attempt_id = ?`,
          params.attemptId
        );
        const record: ExportSourceRecord = Object.freeze({
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: stableSourceCorrelationId('att', params.attemptId),
          sourceRevision: Math.max(0, params.revision),
          backend: attempt?.backend ?? 'unknown',
          modelRequested: attempt?.model ?? null,
          modelReported: attempt?.model ?? null,
          durationMs: params.durationMs,
          outcome: params.outcome
        });
        trackDurableCardinality([record]);
        return exporter.offer([record]);
      } catch {
        return { accepted: 0, duplicate: 0, refused: 1 };
      }
    },

    offerAcceptedCorrection(params) {
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: 0 };
      }
      try {
        const row = deps.sqliteStore.writerConnection.get<{
          correction_id: number;
          target_observation_id: string;
          measure: Measure;
          replacement_quantity: number | null;
          unit: string;
          revision: number;
        }>(
          `SELECT correction_id, target_observation_id, measure, replacement_quantity, unit, revision
           FROM accounting_corrections
           WHERE correction_id = ?`,
          params.correctionId
        );
        if (row === undefined) return { accepted: 0, duplicate: 0, refused: 0 };
        const obs = deps.sqliteStore.writerConnection.get<{
          backend: string | null;
          model_requested: string | null;
          model_reported: string | null;
        }>(
          `SELECT backend, model_requested, model_reported
           FROM accounting_observations
           WHERE observation_id = ?`,
          row.target_observation_id
        );
        const record: ExportSourceRecord = Object.freeze({
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'correction',
          sourceId: stableSourceCorrelationId('corr', String(row.correction_id)),
          sourceRevision: row.revision,
          backend: obs?.backend ?? 'unknown',
          modelRequested: obs?.model_requested ?? null,
          modelReported: obs?.model_reported ?? null,
          correction: Object.freeze({
            measure: row.measure,
            unit: row.unit,
            previousQuantity:
              params.previousQuantity === null ? null : String(params.previousQuantity),
            replacementQuantity:
              row.replacement_quantity === null ? null : String(row.replacement_quantity)
          })
        });
        trackDurableCardinality([record]);
        return exporter.offer([record]);
      } catch {
        return { accepted: 0, duplicate: 0, refused: 1 };
      }
    },

    async reconcileAndReplaySpool() {
      let acknowledged = 0;
      let dropped = 0;
      let expired = 0;
      const kept = await spool.reconcileForDestination({
        activeDestination,
        authorizationGeneration,
        onDropped: (batchId, reason) => {
          dropped += 1;
          recordSpoolDrop(batchId, reason);
        },
        onExpired: (batchId, reason) => {
          expired += 1;
          recordSpoolExpiry(batchId, reason);
        }
      });

      if (kept.length === 0 || activeDestination === null) {
        return { replayed: 0, acknowledged, dropped, expired };
      }

      const target = activeDestination;
      const genAtStart = authorizationGeneration;
      const net = ensureTransport();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (target.credential !== null) {
        if (deps.secrets === null || deps.secrets.availability() !== 'available') {
          for (const entry of kept) {
            await spool.removeBatch(entry.batchId);
            dropped += 1;
            recordSpoolDrop(entry.batchId, 'credential-unavailable');
          }
          return { replayed: kept.length, acknowledged, dropped, expired };
        }
        const secretValue = await deps.secrets.read(target.credential.reference);
        if (secretValue === null || secretValue.length === 0) {
          for (const entry of kept) {
            await spool.removeBatch(entry.batchId);
            dropped += 1;
            recordSpoolDrop(entry.batchId, 'credential-unavailable');
          }
          return { replayed: kept.length, acknowledged, dropped, expired };
        }
        headers[target.credential.headerName] = secretValue;
      }

      let replayed = 0;
      for (const entry of kept) {
        if (activeDestination !== target || authorizationGeneration !== genAtStart) {
          await spool.removeBatch(entry.batchId);
          dropped += 1;
          recordSpoolDrop(entry.batchId, 'authorization-changed');
          continue;
        }
        const body = await spool.readSpooledPayload(entry);
        if (body === null) {
          await spool.removeBatch(entry.batchId);
          dropped += 1;
          recordSpoolDrop(entry.batchId, 'rejected');
          continue;
        }
        replayed += 1;
        const controller = new AbortController();
        const result = await net.send({
          url: new URL(target.endpoint),
          plaintextLoopback: target.plaintextLoopback,
          headers,
          body,
          deadlineMs: TELEMETRY_EXPORT_BOUNDS.requestDeadlineMs,
          signal: controller.signal
        });
        const verdict = classifyDelivery(result);
        ledger.recordReceipt({
          batchId: entry.batchId,
          attemptId: randomUUID(),
          at: clock.now(),
          outcome: verdict.outcome,
          statusCode: result.kind === 'response' ? result.statusCode : null,
          rejectedDataPoints: verdict.outcome === 'acknowledged' ? verdict.rejectedDataPoints : 0,
          errorClass: null
        });
        if (verdict.outcome === 'acknowledged') {
          await spool.removeBatch(entry.batchId);
          ledger.recordDisposition(entry.batchId, 'acknowledged', null);
          acknowledged += 1;
        } else if (verdict.outcome !== 'retry') {
          await spool.removeBatch(entry.batchId);
          dropped += 1;
          recordSpoolDrop(entry.batchId, verdict.outcome);
        }
      }

      return { replayed, acknowledged, dropped, expired };
    },

    flush() {
      exporter?.flush();
    },

    disable() {
      applyEvaluation(Object.freeze({ kind: 'disabled' }));
    },

    idle() {
      return exporter === null ? Promise.resolve() : exporter.idle();
    },

    async shutdown() {
      if (exporter === null) return;
      await exporter.shutdown();
    },

    getStatus(): TelemetryHostStatus {
      const spoolStats = spool.stats();
      const baseHealth =
        exporter === null
          ? emptyDisabledHealth(spoolDropCounts, spoolExpiryCounts)
          : exporter.health();
      const preview: TelemetryExportPreview = Object.freeze({
        requestedContentPolicy: lastPreviewPolicy,
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
      return Object.freeze({
        evaluation,
        authorizationGeneration,
        health: baseHealth,
        spooledBatches: spoolStats.spooledBatches,
        spooledBytes: spoolStats.spooledBytes,
        mappingRevision: TELEMETRY_MAPPING_REVISION,
        protocolRevision: TELEMETRY_PROTOCOL_REVISION,
        semanticConventionsRevision: TELEMETRY_SEMANTIC_CONVENTIONS,
        preview
      });
    }
  };
}
