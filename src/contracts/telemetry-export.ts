/**
 * FR-R6-F14 (F14-A; FR-001 to FR-019) — optional OpenTelemetry export: the destination profile
 * and its evaluation, the source record the exporter accepts, the pinned mapping revision, the
 * bounds, the batch dispositions, the delivery receipt, the health projection and the ports.
 *
 * The exporter sends metrics only, as OTLP over HTTP with JSON encoding, and it never listens.
 * It is built and tested against a loopback fixture: no activation path constructs it in this
 * delivery (F14-B owns the settings surface, the secret-store adapter, the SQLite ledger, the
 * file spool and the wiring), and no collector or live provider was observed.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AttemptOutcome, CacheRelation, Measure, Provenance } from './usage-accounting/accounting-types';

/** The mapping revision this build exports (spec FR-003). A change is a new revision, never an edit. */
export const TELEMETRY_MAPPING_REVISION = 1 as const;
/** The only source-record schema mapping revision 1 reads. */
export const TELEMETRY_SOURCE_SCHEMA = 1 as const;
/** OpenTelemetry semantic conventions revision the instrument names, units and buckets come from. */
export const TELEMETRY_SEMANTIC_CONVENTIONS = '1.37.0' as const;
/** OpenTelemetry protocol revision the request shape follows. */
export const TELEMETRY_PROTOCOL_REVISION = '1.7.0' as const;

/** Declared destination protocols. Only the first is supported; the others are refused. */
export const TELEMETRY_PROTOCOLS = Object.freeze(['otlp-http-json', 'otlp-http-protobuf', 'otlp-grpc'] as const);
export type TelemetryProtocol = (typeof TELEMETRY_PROTOCOLS)[number];
export const TELEMETRY_SUPPORTED_PROTOCOL: TelemetryProtocol = 'otlp-http-json';

/** Declared signals. Only exactly `metrics` is supported. */
export const TELEMETRY_SIGNALS = Object.freeze(['metrics', 'traces', 'logs'] as const);
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

export const TELEMETRY_CONTENT_POLICIES = Object.freeze(['metadata-only', 'content'] as const);
export type TelemetryContentPolicy = (typeof TELEMETRY_CONTENT_POLICIES)[number];

export const TELEMETRY_PROFILE_SCOPES = Object.freeze(['user', 'workspace'] as const);
export type TelemetryProfileScope = (typeof TELEMETRY_PROFILE_SCOPES)[number];

const KIB = 1024;
const MIB = 1024 * KIB;
const HOUR_MS = 60 * 60 * 1000;

/** Every bound the exporter enforces (spec NFR-001, NFR-002, NFR-004, NFR-007). */
export const TELEMETRY_EXPORT_BOUNDS = Object.freeze({
  /** Encoded bytes of sealed batches held in memory. */
  memoryQueueBytes: 8 * MIB,
  /** The disk spool's bound. Declared for F14-B; nothing in this delivery writes a spool. */
  diskSpoolBytes: 32 * MIB,
  /** Age at which a batch expires unsent. */
  copyExpiryMs: 24 * HOUR_MS,
  /** Enabled profiles one workspace may have. */
  activeProfilesMax: 1,
  /** Source records in one batch. */
  batchRecordsMax: 256,
  /** Encoded bytes of one batch. */
  batchBytesMax: MIB,
  /** Absolute deadline of one request. */
  requestDeadlineMs: 2_000,
  /** Retries of one batch after its first attempt. */
  retriesMax: 5,
  /** Time from a batch's first attempt inside which every retry must finish. */
  retryBudgetMs: 30_000,
  /** Backoff base: the delay before retry `n` is this times `2^(n-1)`, scaled into `[0.5, 1]`. */
  retryBaseDelayMs: 500,
  /** Time inside which `shutdown()` resolves. */
  shutdownBudgetMs: 250,
  /** Distinct attribute sets of one instrument, the overflow set included. */
  attributeSetsMax: 1_000,
  /** Response bytes read before the socket is destroyed. */
  responseBytesMax: 64 * KIB,
  /** Longest endpoint accepted. */
  endpointCharsMax: 2_048,
  /** Export copy identities the in-memory ledger remembers. */
  rememberedCopiesMax: 16_384,
  /** Measures one usage record may carry. */
  measuresPerRecordMax: 16
});

/** Where the credential value lives and which request header carries it. Never the value. */
export interface TelemetryCredentialRef {
  readonly reference: string;
  readonly headerName: string;
}

/** One configured destination (data-model.md TelemetryProfile). */
export interface TelemetryProfile {
  readonly id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly scope: TelemetryProfileScope;
  readonly protocol: TelemetryProtocol;
  readonly signals: readonly TelemetrySignal[];
  readonly contentPolicy: TelemetryContentPolicy;
  readonly endpoint: string;
  readonly allowPlaintextLoopback: boolean;
  readonly credential: TelemetryCredentialRef | null;
}

/** Why a profile is not in force. A closed list: no endpoint, header or credential text. */
export const PROFILE_REFUSAL_REASONS = Object.freeze([
  'profile-invalid',
  'multiple-active-profiles',
  'scope-not-authorized',
  'workspace-untrusted',
  'protocol-unsupported',
  'signal-unsupported',
  'content-export-unsupported',
  'endpoint-invalid',
  'plaintext-not-loopback',
  'credential-header-invalid',
  'secret-store-unavailable'
] as const);
export type ProfileRefusalReason = (typeof PROFILE_REFUSAL_REASONS)[number];

/** The destination an authorized profile resolves to. */
export interface ResolvedDestination {
  readonly profileId: string;
  readonly profileRevision: number;
  /** The endpoint as the URL parser serializes it; used as written, with no path appended. */
  readonly endpoint: string;
  readonly plaintextLoopback: boolean;
  readonly credential: TelemetryCredentialRef | null;
}

export type ProfileEvaluation =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'refused'; readonly reason: ProfileRefusalReason }
  | { readonly kind: 'authorized'; readonly destination: ResolvedDestination };

export type SecretStoreAvailability = 'available' | 'unavailable';

/** What the host knows when it evaluates profiles. `absent` means it has no secret port at all. */
export interface ProfileEvaluationContext {
  readonly workspaceTrusted: boolean;
  readonly secretStore: SecretStoreAvailability | 'absent';
}

export const EXPORT_RECORD_KINDS = Object.freeze(['usage', 'operation', 'correction'] as const);
export type ExportRecordKind = (typeof EXPORT_RECORD_KINDS)[number];

/** Completeness values a source record may carry. `conflicting` rows are not offered for export. */
export const EXPORT_COMPLETENESS_VALUES = Object.freeze(['known', 'partial', 'unknown'] as const);
export type ExportCompleteness = (typeof EXPORT_COMPLETENESS_VALUES)[number];

/**
 * One measure of a usage record. `quantity` is decimal text (`0`, or a non-zero digit followed
 * by at most 18 digits) or `null`: token measures are counts and `cost` is micros of `unit`.
 */
export interface ExportMeasure {
  readonly measure: Measure;
  readonly quantity: string | null;
  readonly unit: string;
  readonly completeness: ExportCompleteness;
  readonly provenance: Provenance;
  readonly cacheRelation: CacheRelation | null;
}

/** A correction of one measure: what was exported before and what replaces it. */
export interface ExportCorrection {
  readonly measure: Measure;
  readonly unit: string;
  readonly previousQuantity: string | null;
  readonly replacementQuantity: string | null;
}

interface ExportRecordBase {
  readonly sourceSchema: typeof TELEMETRY_SOURCE_SCHEMA;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly backend: string;
  readonly modelRequested: string | null;
  readonly modelReported: string | null;
}

export interface UsageSourceRecord extends ExportRecordBase {
  readonly kind: 'usage';
  readonly measures: readonly ExportMeasure[];
}

export interface OperationSourceRecord extends ExportRecordBase {
  readonly kind: 'operation';
  readonly durationMs: number | null;
  readonly outcome: AttemptOutcome;
}

export interface CorrectionSourceRecord extends ExportRecordBase {
  readonly kind: 'correction';
  readonly correction: ExportCorrection;
}

/**
 * The only shape the exporter queues (source schema 1). A source row's workspace, root, Run,
 * attempt, session, phase and workflow identifiers are not part of it (spec FR-007, FR-008).
 */
export type ExportSourceRecord = UsageSourceRecord | OperationSourceRecord | CorrectionSourceRecord;

/** What the mapper did with one measure, operation or correction. Each is counted and exported. */
export const COVERAGE_OUTCOMES = Object.freeze([
  'exported',
  'missing',
  'unmapped',
  'out-of-range',
  'correction',
  'correction-unquantified',
  'excluded-dimension',
  'overflow'
] as const);
export type CoverageOutcome = (typeof COVERAGE_OUTCOMES)[number];

export const BATCH_STATES = Object.freeze(['queued', 'sending', 'retrying', 'acknowledged', 'expired', 'dropped'] as const);
export type BatchState = (typeof BATCH_STATES)[number];
export type BatchTerminalState = 'acknowledged' | 'expired' | 'dropped';

export const EXPIRY_REASONS = Object.freeze(['age', 'retry-budget-exhausted'] as const);
export type ExpiryReason = (typeof EXPIRY_REASONS)[number];

export const DROP_REASONS = Object.freeze([
  'rejected',
  'redirect-refused',
  'queue-saturated',
  'disabled',
  'authorization-changed',
  'shutdown',
  'credential-unavailable',
  'credential-invalid',
  'batch-oversized'
] as const);
export type DropReason = (typeof DROP_REASONS)[number];

export const DELIVERY_OUTCOMES = Object.freeze(['acknowledged', 'retry', 'rejected', 'redirect-refused'] as const);
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** The bounded class of a delivery problem. The only description of an error the exporter keeps. */
export const DELIVERY_ERROR_CLASSES = Object.freeze([
  'network',
  'tls',
  'deadline',
  'http-retryable',
  'http-rejected',
  'redirect-refused',
  'response-malformed',
  'response-oversized',
  'credential-unavailable',
  'credential-invalid'
] as const);
export type DeliveryErrorClass = (typeof DELIVERY_ERROR_CLASSES)[number];

/** The outcome of one delivery attempt of one batch. Nothing else from the destination is kept. */
export interface DeliveryReceipt {
  readonly batchId: string;
  readonly attemptId: string;
  /** Epoch milliseconds at which the attempt ended. */
  readonly at: number;
  readonly outcome: DeliveryOutcome;
  readonly statusCode: number | null;
  readonly rejectedDataPoints: number;
  readonly errorClass: DeliveryErrorClass | null;
}

export const DELIVERY_HEALTH_STATES = Object.freeze(['disabled', 'healthy', 'retrying', 'degraded'] as const);
export type DeliveryHealthState = (typeof DELIVERY_HEALTH_STATES)[number];

/** What a surface may show (spec FR-011). Counts and closed classes only. */
export interface DeliveryHealth {
  readonly state: DeliveryHealthState;
  readonly mappingRevision: typeof TELEMETRY_MAPPING_REVISION;
  readonly lastSuccessAt: number | null;
  readonly queuedBatches: number;
  readonly queuedBytes: number;
  readonly acknowledgedBatches: number;
  readonly expiredBatches: number;
  readonly droppedBatches: number;
  readonly dropReasons: Readonly<Record<DropReason, number>>;
  readonly expiryReasons: Readonly<Record<ExpiryReason, number>>;
  readonly duplicateRecords: number;
  readonly unsupportedSchemaRecords: number;
  readonly invalidRecords: number;
  readonly refusedOffers: number;
  readonly rejectedDataPoints: number;
  readonly ledgerFaults: number;
  readonly lastError: DeliveryErrorClass | null;
  readonly coverage: Readonly<Record<CoverageOutcome, number>>;
}

/** The protected secret store, reached without an editor import (spec FR-002). */
export interface TelemetrySecretPort {
  availability(): SecretStoreAvailability;
  /** The credential value for `reference`, or `null` when the store has none. */
  read(reference: string): Promise<string | null>;
}

/** Where export-copy references, receipts and dispositions are recorded (spec FR-019). */
export interface TelemetryLedgerPort {
  rememberCopy(copyId: string): 'new' | 'duplicate';
  recordReceipt(receipt: DeliveryReceipt): void;
  recordDisposition(batchId: string, state: BatchTerminalState, reason: ExpiryReason | DropReason | null): void;
}

export interface ExporterClock {
  /** Epoch milliseconds. */
  now(): number;
}

export interface ExporterTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface TransportRequest {
  readonly url: URL;
  readonly plaintextLoopback: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

export type TransportFailureClass = 'network' | 'tls' | 'deadline' | 'aborted';

/** A closed result: no error message, stack or remote text leaves the transport. */
export type TransportResult =
  | {
      readonly kind: 'response';
      readonly statusCode: number;
      readonly retryAfterSeconds: number | null;
      readonly body: Uint8Array;
      readonly bodyTruncated: boolean;
    }
  | { readonly kind: 'failure'; readonly errorClass: TransportFailureClass };

export interface TelemetryTransport {
  /** Sends one request. Never rejects. */
  send(request: TransportRequest): Promise<TransportResult>;
}

export interface OfferResult {
  readonly accepted: number;
  readonly duplicate: number;
  readonly refused: number;
}

export interface TelemetryExporterOptions {
  readonly transport: TelemetryTransport;
  readonly clock: ExporterClock;
  readonly timers: ExporterTimers;
  /** A value in `[0, 1)`, for retry jitter. */
  readonly random: () => number;
  readonly secrets: TelemetrySecretPort | null;
  readonly ledger: TelemetryLedgerPort;
  /** Reported as `service.version` when given. */
  readonly serviceVersion?: string;
}

/** The exporter surface (contracts/telemetry-export.md). No method throws to its caller. */
export interface TelemetryExporter {
  configure(evaluation: ProfileEvaluation, authorizationGeneration: number): void;
  offer(records: readonly unknown[]): OfferResult;
  flush(): void;
  disable(): void;
  shutdown(): Promise<void>;
  health(): DeliveryHealth;
  idle(): Promise<void>;
}
