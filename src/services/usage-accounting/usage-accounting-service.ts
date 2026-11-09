/**
 * FR-R6-F06 (contracts/accounting-service.md) — the accounting facade, the only writer of the
 * `accounting_*` tables.
 *
 * Every method returns an `AccountingResult`. A domain refusal is a value, never a throw. An
 * unexpected store error is caught here, once, and returned as `store-error`; the log line
 * carries `operation` and `errorCode` only, never the error object or the payload.
 *
 * Construction applies any projection intents a crash left pending.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  type AccountingBounds,
  type AccountingResult,
  type GapKind,
  type IngestDisposition,
  DEFAULT_ACCOUNTING_BOUNDS
} from '../../contracts/usage-accounting/accounting-types';
import { PROVIDER_QUALIFICATIONS, type ProviderQualification } from '../../contracts/usage-accounting/provider-qualifications';
import type { AccountingQueryResponse, ReadGapsResponse } from '../../contracts/usage-accounting/query-contract';
import { validateAccountingQueryRequest, validateReadGapsRequest } from '../../contracts/validators/usage-accounting';
import { historyErrorCode } from '../history/error-code';
import type { NodeSqliteConnection } from '../sqlite-store';
import { readGapsPage, runAccountingQuery } from './accounting-query';
import { type PruneResult, isNearRetentionBound, pruneExpired } from './accounting-retention';
import { inImmediateTransaction } from './accounting-transaction';
import { type AcpAttemptBinding, type AcpUsageUpdate, acpUsageObservation } from './acp-usage-mapping';
import { type CorrectionResult, applyCorrection } from './corrections';
import { type AttemptOutcomeResult, type RootOutcomeResult, recordAttemptOutcome, recordRootOutcome } from './execution-outcomes';
import { GLOBAL_GAP_SCOPE, recordGap } from './gap-counter';
import type { AccountingObservationInput } from './observation-normalizer';
import { type PhaseEndSnapshot, phaseEndObservation } from './phase-end-ingestion';
import { type LegacyEpochResult, type LegacyRollupSource, importLegacyEpoch } from './legacy-epoch';
import { ingestObservationRecord } from './observation-store';
import { type ProjectionContext, applyProjectionIntent, rebuildPendingProjections } from './projection';

/** The narrow logging surface the facade needs; the host passes its sanitized logger. */
export interface AccountingLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface UsageAccountingServiceDeps {
  /** F04 connection with schema version >= 3. */
  readonly conn: NodeSqliteConnection;
  readonly nowUtc: () => string;
  readonly monotonicMs: () => number;
  readonly workspaceId: string;
  /** Default 90. */
  readonly horizonDays?: number | undefined;
  /** Tests only. */
  readonly bounds?: Partial<AccountingBounds> | undefined;
  readonly logger?: AccountingLogger | undefined;
  /** Tests only: throwing here aborts a projection apply after its writes. */
  readonly projectionFailpoint?: ProjectionContext['failpoint'];
  /** Tests only: throwing here interrupts the legacy import after a committed batch. */
  readonly legacyImportFailpoint?: ((batch: number) => void) | undefined;
}

export interface IngestResult {
  readonly observationId: string;
  readonly disposition: IngestDisposition;
  /** The revision the observation's projection committed, or `null` when none did. */
  readonly revision: number | null;
}

export interface RebuildResult {
  readonly applied: number;
  readonly stillPending: number;
}

export interface UsageAccountingService {
  ingestObservation(input: AccountingObservationInput): AccountingResult<IngestResult>;
  /** One copied `phase-end` row (research R9), ingested as an `invocation-delta` observation. */
  ingestPhaseEnd(snapshot: PhaseEndSnapshot): AccountingResult<IngestResult>;
  /** One ACP usage update (research R12) and its admitted attempt binding, if any. */
  ingestAcpUsageUpdate(update: AcpUsageUpdate, binding: AcpAttemptBinding | null): AccountingResult<IngestResult>;
  rebuildPendingProjections(): AccountingResult<RebuildResult>;
  /**
   * Counts `count` occurrences of a gap at `global` scope, in one transaction; a count that is
   * not a positive safe integer writes nothing. The wiring calls
   * it for the failures it sees outside the store: admission overflow and failed ingestion.
   */
  recordGaps(kind: GapKind, count: number): AccountingResult<void>;
  /**
   * Records `{ attemptId, outcome }` (FR-012). A malformed request is `invalid-observation`, an
   * unseen attempt `unknown-attempt`; an unchanged outcome answers the latest revision.
   */
  recordAttemptOutcome(request: unknown): AccountingResult<AttemptOutcomeResult>;
  /**
   * Appends `{ rootId, outcome, terminalUtc }` as the root's next terminal transition (FR-012).
   * A malformed request is `invalid-observation`; a legacy run id `legacy-epoch-overlap`.
   */
  recordRootOutcome(request: unknown): AccountingResult<RootOutcomeResult>;
  /**
   * Replaces one contribution under a `correction` revision (FR-010, FR-019). A missing or
   * expired target is `beyond-correction-horizon`; a bad field `invalid-correction`.
   */
  applyCorrection(request: unknown): AccountingResult<CorrectionResult>;
  /**
   * Prunes expired, non-authoritative detail at the injected clock (FR-016, research R10).
   * Ingestion also calls it once the retained count is within 1% of the bound.
   */
  pruneExpired(): AccountingResult<PruneResult>;
  /**
   * Imports the first-terminal rollup once into the legacy epoch (FR-013, research R8). The
   * service's constructor calls it once; a complete epoch answers its stored result, an
   * interrupted one resumes. The rollup file is only read.
   */
  importLegacyEpoch(source: LegacyRollupSource): Promise<AccountingResult<LegacyEpochResult>>;
  /** Validates `request` (the shared validator) and reads one revision-pinned page. */
  query(request: unknown, signal?: AbortSignal): AccountingResult<AccountingQueryResponse>;
  readGaps(request?: unknown): AccountingResult<ReadGapsResponse>;
  /** The static qualification registry (FR-020), never mixed into observed data. */
  readQualifications(): AccountingResult<readonly ProviderQualification[]>;
}

const LOG_MESSAGE = 'usage-accounting: store error';

export function createUsageAccountingService(deps: UsageAccountingServiceDeps): UsageAccountingService {
  const bounds: AccountingBounds = {
    ...DEFAULT_ACCOUNTING_BOUNDS,
    ...(deps.horizonDays !== undefined ? { horizonDays: deps.horizonDays } : {}),
    ...(deps.bounds ?? {})
  };

  function projectionContext(nowUtc: string): ProjectionContext {
    return { nowUtc, maxGapKeys: bounds.maxGapKeys, failpoint: deps.projectionFailpoint };
  }

  function storeError<T>(operation: string, error: unknown): AccountingResult<T> {
    try {
      deps.logger?.warn(LOG_MESSAGE, { operation, errorCode: historyErrorCode(error) });
    } catch {
      // A failing sink must not turn a sanitized refusal into a throw.
    }
    return { ok: false, refusal: { code: 'store-error', detail: operation } };
  }

  function guarded<T>(operation: string, work: () => AccountingResult<T>): AccountingResult<T> {
    try {
      return work();
    } catch (error) {
      return storeError(operation, error);
    }
  }

  async function guardedAsync<T>(operation: string, work: () => Promise<AccountingResult<T>>): Promise<AccountingResult<T>> {
    try {
      return await work();
    } catch (error) {
      return storeError(operation, error);
    }
  }

  const service: UsageAccountingService = {
    ingestObservation(input) {
      return guarded('ingestObservation', () => {
        const nowUtc = deps.nowUtc();
        if (isNearRetentionBound(deps.conn, bounds.maxRetainedObservations)) pruneExpired(deps.conn, nowUtc, bounds.horizonDays);
        const stored = ingestObservationRecord(deps.conn, input, {
          workspaceId: deps.workspaceId,
          nowUtc,
          monotonicMs: deps.monotonicMs(),
          bounds
        });
        if (!stored.ok) return stored;
        const { observationId, disposition, intentId } = stored.value;
        if (intentId === null) return { ok: true, value: { observationId, disposition, revision: null } };
        const applied = applyProjectionIntent(deps.conn, intentId, 'ingest', projectionContext(nowUtc));
        return { ok: true, value: { observationId, disposition, revision: applied.applied ? applied.revision : null } };
      });
    },

    ingestPhaseEnd(snapshot) {
      return guarded('ingestPhaseEnd', () => service.ingestObservation(phaseEndObservation(snapshot, deps.nowUtc())));
    },

    ingestAcpUsageUpdate(update, binding) {
      return guarded('ingestAcpUsageUpdate', () =>
        service.ingestObservation(acpUsageObservation(update, binding, deps.nowUtc()))
      );
    },

    rebuildPendingProjections() {
      return guarded('rebuildPendingProjections', () => ({
        ok: true,
        value: rebuildPendingProjections(deps.conn, projectionContext(deps.nowUtc()))
      }));
    },

    recordGaps(kind, count) {
      return guarded('recordGaps', () => {
        if (!Number.isSafeInteger(count) || count < 1) return { ok: true, value: undefined };
        const nowUtc = deps.nowUtc();
        inImmediateTransaction(deps.conn, () => {
          recordGap(deps.conn, kind, GLOBAL_GAP_SCOPE, nowUtc, bounds.maxGapKeys, count);
        });
        return { ok: true, value: undefined };
      });
    },

    recordAttemptOutcome(request) {
      return guarded('recordAttemptOutcome', () => recordAttemptOutcome(deps.conn, request, deps.nowUtc()));
    },

    recordRootOutcome(request) {
      return guarded('recordRootOutcome', () => recordRootOutcome(deps.conn, request, deps.nowUtc()));
    },

    applyCorrection(request) {
      return guarded('applyCorrection', () => applyCorrection(deps.conn, request, deps.nowUtc(), bounds));
    },

    pruneExpired() {
      return guarded('pruneExpired', () => ({ ok: true, value: pruneExpired(deps.conn, deps.nowUtc(), bounds.horizonDays) }));
    },

    importLegacyEpoch(source) {
      return guardedAsync('importLegacyEpoch', () =>
        importLegacyEpoch(deps.conn, source, { nowUtc: deps.nowUtc(), failpoint: deps.legacyImportFailpoint })
      );
    },

    query(request, signal) {
      return guarded('query', () => {
        const validated = validateAccountingQueryRequest(request);
        if (!validated.ok) return validated;
        return runAccountingQuery(deps.conn, validated.value, { bounds, monotonicMs: deps.monotonicMs, signal });
      });
    },

    readGaps(request) {
      return guarded('readGaps', () => {
        const validated = validateReadGapsRequest(request);
        if (!validated.ok) return validated;
        return readGapsPage(deps.conn, validated.value);
      });
    },

    readQualifications() {
      return { ok: true, value: PROVIDER_QUALIFICATIONS };
    }
  };

  service.rebuildPendingProjections();
  return service;
}
