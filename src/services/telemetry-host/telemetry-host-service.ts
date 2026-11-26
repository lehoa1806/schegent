/**
 * FR-R6-F14 (F14-B: FR-001..FR-019; NFR-001..NFR-007; AC-01..AC-10) — editor-independent
 * host telemetry coordinator.
 *
 * This is the single module outside `src/services/telemetry-export/` permitted to import
 * `src/services/telemetry-export` (`tests/lint/expansion-freeze.test.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { randomUUID } from 'node:crypto';

import {
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_MAPPING_REVISION,
  TELEMETRY_PROTOCOL_REVISION,
  TELEMETRY_SEMANTIC_CONVENTIONS,
  TELEMETRY_SOURCE_SCHEMA,
  type DeliveryErrorClass,
  type DeliveryHealth,
  type DropReason,
  type ExpiryReason,
  type ExportSourceRecord,
  type ExporterClock,
  type ExporterTimers,
  type OfferResult,
  type ProfileEvaluation,
  type ProfileEvaluationContext,
  type ResolvedDestination,
  type TelemetryExporter,
  type TelemetryLedgerPort,
  type TelemetrySecretPort,
  type TelemetryTransport,
  type TransportResult
} from '../../contracts/telemetry-export';
import type { AttemptOutcome, Measure } from '../../contracts/usage-accounting/accounting-types';
import type { SideEffectFailureReport } from '../../lib/side-effect-failure-reporter';
import type { SqliteApplicationStore } from '../sqlite-store';
import {
  classifyDelivery,
  createOtlpHttpTransport,
  createTelemetryExporter,
  evaluateProfiles,
  type NameLookup
} from '../telemetry-export';
import { isHeaderValue } from '../telemetry-export/credential-reader';
import { CONNECTION_LOST, isTransportResult } from '../telemetry-export/retry-policy';
import { parseSourceRecord } from '../telemetry-export/source-record';
import {
  createSqliteTelemetryLedger,
  createTelemetrySpoolStore,
  type SqliteTelemetryLedger,
  type TelemetrySpoolStore
} from './telemetry-durable-store';
import {
  buildProfileObjectFromUserSettings,
  destinationFingerprintOf,
  destinationMatches,
  emptyDisabledHealth,
  formatTelemetryExportPreview,
  normalizeAcceptedObservationFromSqlite,
  normalizeContentPolicy,
  sanitizedCardinalityDimension,
  stableSourceCorrelationId,
  type NormalizedTelemetryContentPolicy,
  type TelemetryExportPreview,
  type TelemetryUserSettingsInput
} from './telemetry-host-helpers';

export {
  buildProfileObjectFromUserSettings,
  normalizeAcceptedObservationFromSqlite,
  type NormalizedTelemetryContentPolicy,
  type TelemetryExportPreview,
  type TelemetryUserSettingsInput
} from './telemetry-host-helpers';

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
  /**
   * Where a failed background spool or spool reconciliation is reported. Both run unawaited, from
   * a retry timer or a settings change, so without it a failure is dropped here rather than
   * surfacing as an unhandled rejection.
   */
  readonly reportSideEffectFailure?: SideEffectFailureReport;
}

export interface TelemetryHostService {
  configureFromUserSettings(settings: TelemetryUserSettingsInput): ProfileEvaluation;
  configureFromRawProfiles(
    profiles: readonly unknown[],
    previewPolicy?: string
  ): ProfileEvaluation;
  invalidateCredential(reference?: string): void;
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

export function buildTelemetryExportPreview(
  settings: TelemetryUserSettingsInput,
  context: ProfileEvaluationContext
): TelemetryExportPreview {
  const profile = buildProfileObjectFromUserSettings(settings);
  const evaluation = evaluateProfiles([profile], context);
  return formatTelemetryExportPreview(normalizeContentPolicy(settings.contentPolicy), evaluation);
}

export function createTelemetryHostService(deps: TelemetryHostServiceDeps): TelemetryHostService {
  const clock: ExporterClock = deps.clock ?? { now: () => Date.now() };
  const timers: ExporterTimers = deps.timers ?? {
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const random = deps.random ?? (() => Math.random());

  let lastHostNow = 0;
  function readHostNow(): number {
    try {
      const value = clock.now();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        lastHostNow = value;
        return value;
      }
    } catch {
      // Host clock failures must not throw synchronously or reject replay/spool operations.
    }
    return lastHostNow;
  }

  const ledger = createSqliteTelemetryLedger(deps.sqliteStore, () => readHostNow());
  const spool = createTelemetrySpoolStore({
    sqliteStore: deps.sqliteStore,
    storageRoot: deps.storageRoot,
    nowMs: () => readHostNow()
  });

  let evaluation: ProfileEvaluation = Object.freeze({ kind: 'disabled' });
  let activeDestination: ResolvedDestination | null = null;
  let authorizationGeneration = 1;
  try {
    authorizationGeneration = ledger.readAuthorizationGeneration();
  } catch {
    // Store may already be closed in fault-injection tests; keep generation 1.
  }
  let lastPreviewPolicy: NormalizedTelemetryContentPolicy = 'metadata-only';
  let transport: TelemetryTransport | null = null;
  let exporter: TelemetryExporter | null = null;
  let lastFailedBody: Uint8Array | null = null;
  const activeReplayControllers = new Set<AbortController>();
  let activeReplay: Promise<{
    readonly replayed: number;
    readonly acknowledged: number;
    readonly dropped: number;
    readonly expired: number;
  }> | null = null;
  let shutDown = false;
  let pendingReconcileDropped = 0;
  let pendingReconcileExpired = 0;

  /** Unawaited spool work, so `idle()` can wait for it; each entry has already handled its failure. */
  const pendingSpoolWork = new Set<Promise<void>>();
  function trackSpoolWork(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      (err: unknown) => {
        deps.reportSideEffectFailure?.('telemetry-spool', err);
      }
    );
    pendingSpoolWork.add(settled);
    void settled.then(() => pendingSpoolWork.delete(settled));
  }

  async function drainPendingSpoolWork(): Promise<void> {
    while (pendingSpoolWork.size > 0) {
      await Promise.all([...pendingSpoolWork]);
    }
  }

  function abortActiveReplay(): void {
    const controllers = [...activeReplayControllers];
    activeReplayControllers.clear();
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        // Transport abort listener faults must never break revocation or shutdown.
      }
    }
  }

  function safeSpoolStats(): { readonly spooledBatches: number; readonly spooledBytes: number } {
    try {
      return spool.stats();
    } catch {
      return { spooledBatches: 0, spooledBytes: 0 };
    }
  }

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

  function safeSecretAvailability(): ProfileEvaluationContext['secretStore'] {
    if (deps.secrets === null) return 'absent';
    try {
      return deps.secrets.availability() === 'available' ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  function evaluationContext(): ProfileEvaluationContext {
    let workspaceTrusted = false;
    try {
      workspaceTrusted = deps.isWorkspaceTrusted() === true;
    } catch {
      workspaceTrusted = false;
    }
    return {
      workspaceTrusted,
      secretStore: safeSecretAvailability()
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

  function revocationDropReason(): DropReason {
    if (shutDown) return 'shutdown';
    return activeDestination === null ? 'disabled' : 'authorization-changed';
  }

  function isRevokedFor(dest: ResolvedDestination, gen: number): boolean {
    return shutDown || activeDestination !== dest || authorizationGeneration !== gen;
  }

  function ensureExporter(): TelemetryExporter {
    if (exporter !== null) return exporter;
    const underlyingTransport = ensureTransport();
    const wrappedTransport: TelemetryTransport = {
      async send(req) {
        let res: TransportResult;
        try {
          const raw: unknown = await underlyingTransport.send(req);
          res = isTransportResult(raw) ? raw : CONNECTION_LOST;
        } catch {
          res = CONNECTION_LOST;
        }
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
          activeDestination !== null &&
          !shutDown
        ) {
          const bodyToSpool = lastFailedBody;
          const destSnapshot = activeDestination;
          const genSnapshot = authorizationGeneration;
          lastFailedBody = null;
          trackSpoolWork(
            (async () => {
              if (isRevokedFor(destSnapshot, genSnapshot)) {
                recordSpoolDrop(batchId, revocationDropReason());
                return;
              }
              const spooled = await spool.spoolBatch({
                batchId,
                destination: destSnapshot,
                authorizationGeneration: genSnapshot,
                body: bodyToSpool
              });
              for (const evictedId of spooled.droppedBatchIds) {
                recordSpoolDrop(evictedId, 'queue-saturated');
              }
              if (spooled.spooled && isRevokedFor(destSnapshot, genSnapshot)) {
                const removed = await spool.removeBatch(batchId);
                if (removed) {
                  recordSpoolDrop(batchId, revocationDropReason());
                }
              }
            })()
          );
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
    if (shutDown) return evaluation;
    const nextDest = nextEval.kind === 'authorized' ? nextEval.destination : null;
    const changedInMemory = !destinationMatches(activeDestination, nextDest);
    const nextFingerprint = destinationFingerprintOf(nextDest);

    let generationChanged = false;
    try {
      const synced = ledger.syncAuthorizationDestination(nextFingerprint);
      authorizationGeneration = synced.generation;
      generationChanged = synced.changed;
    } catch {
      if (changedInMemory && (activeDestination !== null || nextDest !== null)) {
        authorizationGeneration += 1;
        generationChanged = true;
      }
    }

    if (changedInMemory || nextDest === null || generationChanged) {
      abortActiveReplay();
    }

    evaluation = nextEval;
    activeDestination = nextDest;

    if (nextDest === null) {
      lastFailedBody = null;
      if (exporter !== null) {
        exporter.configure(nextEval, authorizationGeneration);
      }
      // Revoke any spooled batches if any exist in SQLite without creating directories in disabled mode.
      if (safeSpoolStats().spooledBatches > 0) {
        trackSpoolWork(
          spool.reconcileForDestination({
            activeDestination: null,
            authorizationGeneration,
            onDropped: (batchId, reason) => {
              pendingReconcileDropped += 1;
              recordSpoolDrop(batchId, reason);
            },
            onExpired: (batchId, reason) => {
              pendingReconcileExpired += 1;
              recordSpoolExpiry(batchId, reason);
            }
          })
        );
      }
      return evaluation;
    }

    try {
      ledger.setActiveProfileId(nextDest.profileId);
    } catch {
      // Guarded profile-id update.
    }
    const exp = ensureExporter();
    exp.configure(nextEval, authorizationGeneration);
    if (safeSpoolStats().spooledBatches > 0) {
      trackSpoolWork(
        spool.reconcileForDestination({
          activeDestination: nextDest,
          authorizationGeneration,
          onDropped: (batchId, reason) => {
            pendingReconcileDropped += 1;
            recordSpoolDrop(batchId, reason);
          },
          onExpired: (batchId, reason) => {
            pendingReconcileExpired += 1;
            recordSpoolExpiry(batchId, reason);
          }
        })
      );
    }
    return evaluation;
  }

  function trackDurableCardinality(records: readonly unknown[]): void {
    if (activeDestination === null) return;
    const profileId = activeDestination.profileId;
    for (const raw of records) {
      const parsed = parseSourceRecord(raw);
      if (parsed.kind !== 'record') continue;
      const rec = parsed.record;
      const key = JSON.stringify([
        sanitizedCardinalityDimension('backend', rec.backend),
        sanitizedCardinalityDimension('model', rec.modelRequested),
        sanitizedCardinalityDimension('model', rec.modelReported),
        rec.kind
      ]);
      try {
        ledger.admitCardinalitySet({
          profileId,
          mappingRevision: TELEMETRY_MAPPING_REVISION,
          instrument: rec.kind === 'operation' ? 'operation-duration' : 'token-usage',
          attributeSetKey: key
        });
      } catch {
        // Cardinality tracking must never fail or refuse export ingestion.
      }
    }
  }

  return {
    ledger,
    spool,

    configureFromUserSettings(settings) {
      lastPreviewPolicy = normalizeContentPolicy(settings.contentPolicy);
      const profile = buildProfileObjectFromUserSettings(settings);
      return applyEvaluation(evaluateProfiles([profile], evaluationContext()));
    },

    configureFromRawProfiles(profiles, previewPolicy = 'metadata-only') {
      lastPreviewPolicy = normalizeContentPolicy(previewPolicy);
      return applyEvaluation(evaluateProfiles(profiles, evaluationContext()));
    },

    invalidateCredential(reference) {
      if (shutDown) return;
      try {
        exporter?.invalidateCredential(reference);
      } catch {
        // Exporter never throws; defensive host boundary guard.
      }
    },

    offerRecords(records) {
      if (!Array.isArray(records)) {
        return { accepted: 0, duplicate: 0, refused: 0 };
      }
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: records.length };
      }
      try {
        const result = exporter.offer(records);
        if (result.accepted > 0) {
          trackDurableCardinality(records);
        }
        return result;
      } catch {
        return { accepted: 0, duplicate: 0, refused: Array.isArray(records) ? records.length : 0 };
      }
    },

    offerAcceptedObservationById(observationId) {
      if (exporter === null || activeDestination === null) {
        return { accepted: 0, duplicate: 0, refused: 0 };
      }
      try {
        const record = normalizeAcceptedObservationFromSqlite(deps.sqliteStore, observationId);
        if (record === null) return { accepted: 0, duplicate: 0, refused: 0 };
        const result = exporter.offer([record]);
        if (result.accepted > 0) {
          trackDurableCardinality([record]);
        }
        return result;
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
        const result = exporter.offer([record]);
        if (result.accepted > 0) {
          trackDurableCardinality([record]);
        }
        return result;
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
        const result = exporter.offer([record]);
        if (result.accepted > 0) {
          trackDurableCardinality([record]);
        }
        return result;
      } catch {
        return { accepted: 0, duplicate: 0, refused: 1 };
      }
    },

    reconcileAndReplaySpool() {
      if (activeReplay !== null) {
        return activeReplay;
      }

      const runReconcileAndReplaySpool = async (): Promise<{
        readonly replayed: number;
        readonly acknowledged: number;
        readonly dropped: number;
        readonly expired: number;
      }> => {
        let replayed = 0;
        let acknowledged = 0;
        let dropped = 0;
        let expired = 0;

        const drainReconcileDeltas = (): void => {
          dropped += pendingReconcileDropped;
          pendingReconcileDropped = 0;
          expired += pendingReconcileExpired;
          pendingReconcileExpired = 0;
        };

        const dropRemainingEntries = async (
          entries: readonly { readonly batchId: string }[],
          startIndex: number,
          reason: DropReason
        ): Promise<void> => {
          for (let idx = startIndex; idx < entries.length; idx += 1) {
            const entry = entries[idx]!;
            try {
              const removed = await spool.removeBatch(entry.batchId);
              if (removed) {
                dropped += 1;
                recordSpoolDrop(entry.batchId, reason);
              }
            } catch {
              // Store may already be closed during shutdown.
            }
          }
        };

        const settleRevocationAndDrop = async (
          entries: readonly { readonly batchId: string }[],
          startIndex: number
        ): Promise<void> => {
          await drainPendingSpoolWork();
          drainReconcileDeltas();
          await dropRemainingEntries(entries, startIndex, revocationDropReason());
          await drainPendingSpoolWork();
          drainReconcileDeltas();
        };

        try {
          await drainPendingSpoolWork();
          drainReconcileDeltas();

          if (shutDown) {
            return { replayed: 0, acknowledged, dropped, expired };
          }

          const target = activeDestination;
          const genAtStart = authorizationGeneration;
          const isStillAuthorized = (): boolean =>
            !shutDown && target !== null && activeDestination === target && authorizationGeneration === genAtStart;

          const kept = await spool.reconcileForDestination({
            activeDestination: target,
            authorizationGeneration: genAtStart,
            onDropped: (batchId, reason) => {
              dropped += 1;
              recordSpoolDrop(batchId, reason);
            },
            onExpired: (batchId, reason) => {
              expired += 1;
              recordSpoolExpiry(batchId, reason);
            }
          });

          if (kept.length === 0 || target === null) {
            return { replayed: 0, acknowledged, dropped, expired };
          }
          if (!isStillAuthorized()) {
            await settleRevocationAndDrop(kept, 0);
            return { replayed: 0, acknowledged, dropped, expired };
          }

          let targetUrl: URL;
          try {
            targetUrl = new URL(target.endpoint);
          } catch {
            await dropRemainingEntries(kept, 0, 'rejected');
            return { replayed: 0, acknowledged, dropped, expired };
          }

          const net = ensureTransport();
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (target.credential !== null) {
            if (deps.secrets === null || safeSecretAvailability() !== 'available') {
              await dropRemainingEntries(kept, 0, 'credential-unavailable');
              return { replayed: 0, acknowledged, dropped, expired };
            }
            let secretValue: unknown = null;
            let readFailed = false;
            try {
              secretValue = await deps.secrets.read(target.credential.reference);
            } catch {
              readFailed = true;
            }
            if (!isStillAuthorized()) {
              await settleRevocationAndDrop(kept, 0);
              return { replayed: 0, acknowledged, dropped, expired };
            }
            if (readFailed || secretValue === null || typeof secretValue !== 'string') {
              await dropRemainingEntries(kept, 0, 'credential-unavailable');
              return { replayed: 0, acknowledged, dropped, expired };
            }
            if (!isHeaderValue(secretValue)) {
              await dropRemainingEntries(kept, 0, 'credential-invalid');
              return { replayed: 0, acknowledged, dropped, expired };
            }
            headers[target.credential.headerName] = secretValue;
          }

          for (let i = 0; i < kept.length; i += 1) {
            const entry = kept[i]!;
            if (!isStillAuthorized()) {
              await settleRevocationAndDrop(kept, i);
              break;
            }
            let body: Uint8Array | null = null;
            try {
              body = await spool.readSpooledPayload(entry);
            } catch {
              body = null;
            }
            if (!isStillAuthorized()) {
              await settleRevocationAndDrop(kept, i);
              break;
            }
            if (body === null) {
              await dropRemainingEntries([entry], 0, 'rejected');
              continue;
            }
            replayed += 1;
            const controller = new AbortController();
            activeReplayControllers.add(controller);
            let result: TransportResult;
            try {
              const raw: unknown = await net.send({
                url: targetUrl,
                plaintextLoopback: target.plaintextLoopback,
                headers,
                body,
                deadlineMs: TELEMETRY_EXPORT_BOUNDS.requestDeadlineMs,
                signal: controller.signal
              });
              result = isTransportResult(raw) ? raw : CONNECTION_LOST;
            } catch {
              result = CONNECTION_LOST;
            } finally {
              activeReplayControllers.delete(controller);
            }
            if (!isStillAuthorized() || controller.signal.aborted) {
              await settleRevocationAndDrop(kept, i);
              break;
            }
            const verdict = classifyDelivery(result);
            const errorClass: DeliveryErrorClass | null =
              verdict.outcome === 'acknowledged'
                ? verdict.anomaly
                : verdict.outcome === 'redirect-refused'
                  ? 'redirect-refused'
                  : verdict.errorClass;
            try {
              ledger.recordReceipt({
                batchId: entry.batchId,
                attemptId: randomUUID(),
                at: readHostNow(),
                outcome: verdict.outcome,
                statusCode: result.kind === 'response' ? result.statusCode : null,
                rejectedDataPoints: verdict.outcome === 'acknowledged' ? verdict.rejectedDataPoints : 0,
                errorClass
              });
            } catch {
              // Guarded ledger receipt write.
            }
            if (verdict.outcome === 'acknowledged') {
              try {
                await spool.removeBatch(entry.batchId);
              } catch {
                // Guarded spool cleanup.
              }
              try {
                ledger.recordDisposition(entry.batchId, 'acknowledged', null);
              } catch {
                // Guarded ledger disposition write.
              }
              acknowledged += 1;
            } else if (verdict.outcome !== 'retry') {
              await dropRemainingEntries([entry], 0, verdict.outcome);
            }
          }
        } catch (err) {
          deps.reportSideEffectFailure?.('telemetry-spool', err);
        }

        return { replayed, acknowledged, dropped, expired };
      };

      const run = (async () => {
        try {
          return await runReconcileAndReplaySpool();
        } finally {
          activeReplay = null;
        }
      })();
      activeReplay = run;
      return run;
    },

    flush() {
      try {
        exporter?.flush();
      } catch {
        // Exporter never throws; defensive host boundary guard.
      }
    },

    disable() {
      applyEvaluation(Object.freeze({ kind: 'disabled' }));
    },

    async idle() {
      if (exporter !== null) await exporter.idle();
      await drainPendingSpoolWork();
    },

    async shutdown() {
      shutDown = true;
      abortActiveReplay();
      lastFailedBody = null;
      if (exporter === null) return;
      try {
        await exporter.shutdown();
      } catch {
        // Exporter shutdown is guarded to resolve cleanly within its budget.
      }
    },

    getStatus(): TelemetryHostStatus {
      const spoolStats = safeSpoolStats();
      const baseHealth =
        exporter === null
          ? emptyDisabledHealth(spoolDropCounts, spoolExpiryCounts)
          : exporter.health();
      const preview: TelemetryExportPreview = formatTelemetryExportPreview(
        lastPreviewPolicy,
        evaluation
      );
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
