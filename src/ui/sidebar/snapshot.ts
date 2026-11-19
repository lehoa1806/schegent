// Authoritative sidebar WorkflowSnapshot barrel, idle projection constants,
// and `buildIdleSnapshot` / `findQueueRuntime` helpers.
//
// FR-R7-05 — Snapshot projection interfaces and `SCHEMA_VERSION` are generated
// from `scripts/contracts/snapshot-descriptors.mjs` into
// `src/contracts/generated/snapshot-types.ts` (host) and
// `webview-ui/src/lib/generated/snapshot-mirror.ts` (webview) and re-exported
// here so all host consumers keep importing from `src/ui/sidebar/snapshot`.

import type { DebugLogEntry } from '../../lib/webview-log-sink';
import type { BackendPingState } from '../../services/backend-ping-service';
import type {
  BackendGrantEntryProblems,
  BackendGrantState,
  BackendPosture
} from '../../contracts/sidebar-ipc/uncontained-grant';
import {
  IDLE_EVIDENCE_HEALTH,
  type EvidenceHealthSnapshot
} from '../../services/evidence-health/evidence-health-monitor';
import type {
  ChangedCollectionField,
  ChangedField,
  ChangedFieldSummary,
  ChangedScalarField
} from '../../catalog/changed-fields';
import type { QueueLifecycle, ScheduledStartSource } from '../../queue/feature-request';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../../contracts/backend-kinds';
import { BACKEND_DESCRIPTORS, emptyBackendModels } from '../../contracts/backend-descriptors';
import type { GeneralSettings } from '../../config/general-settings';
// FR-R3-145 (T1572) — value imports, so the idle projection restates neither
// number. Both live in the contract layer precisely so this module and
// `src/state/workspace-state.ts` can read them without depending on each other.
import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../../contracts/queue-identity';
import type {
  AuditTailEntry,
  DelayedRetryState,
  LiveActivity,
  QueueSettingsProjection,
  QueueSummary,
  SessionArtifactsProjection,
  StreamPressureProjection
} from '../../contracts/snapshot-projections';
import {
  SCHEMA_VERSION,
  type GeneralSettingsProjection,
  type HistoryEntry,
  type InFlightRunProjection,
  type PhaseCatalogFieldErrorProjection,
  type PhaseCatalogProjection,
  type PhaseCatalogSourceProjection,
  type PipelineCatalogFieldErrorProjection,
  type PipelineCatalogProjection,
  type PipelineCatalogSourceProjection,
  type QueueItem,
  type QueueProjection,
  type QueueRuntime,
  type TrustProjection,
  type WorkflowCatalogProjection,
  type WorkflowCatalogSourceProjection,
  type WorkflowSnapshot
} from '../../contracts/generated/snapshot-types';

export { SCHEMA_VERSION };
export type {
  GeneralSettingsProjection,
  HistoryEntry,
  InFlightRunProjection,
  PhaseCatalogFieldErrorProjection,
  PhaseCatalogProjection,
  PhaseCatalogSourceProjection,
  PipelineCatalogFieldErrorProjection,
  PipelineCatalogProjection,
  PipelineCatalogSourceProjection,
  QueueItem,
  QueueProjection,
  QueueRuntime,
  TrustProjection,
  WorkflowCatalogProjection,
  WorkflowCatalogSourceProjection,
  WorkflowSnapshot
};

export type { BackendPingState };
export type { BackendGrantEntryProblems, BackendGrantState, BackendPosture };
export type { DebugLogEntry };
export type { EvidenceHealthSnapshot };
export { IDLE_EVIDENCE_HEALTH };
export type { ChangedCollectionField, ChangedField, ChangedFieldSummary, ChangedScalarField };
export type { QueueLifecycle, ScheduledStartSource };
export type { GeneralSettings } from '../../config/general-settings';
export type { TelemetrySnapshot, TelemetryStatus } from '../../telemetry/telemetry-snapshot';

export type {
  ActiveFeatureSummary,
  ActivePipelineSummary,
  AuditCategory,
  CliMonitorState,
  CreditPollingProjection,
  DegradedPhaseEntry,
  DelayedRetryCauseProjection,
  DelayedRetryState,
  EffectiveLimitsProjection,
  FreshnessState,
  LaunchProjection,
  LaunchSection,
  Launchable,
  LaunchablePort,
  LiveActivity,
  MonitorStatus,
  PhaseResultState,
  PhaseState,
  PhaseTile,
  QueueItemStatus,
  RunLivenessProjection,
  RunProgressProjection,
  SessionArtifactsProjection,
  StreamPressureProjection,
  SubProgress,
  TaskPhaseProgressProjection,
  WorkflowCatalogFieldErrorProjection,
  WorkflowStatus,
  AuditTailEntry,
  BuilderVersionEntry,
  QueueSummary,
  QueueSettingsProjection,
  BuilderLifecycle
} from '../../contracts/snapshot-projections';

export const IDLE_TRUST_PROJECTION: TrustProjection = Object.freeze({
  workspaceTrust: false,
  resolvedTrust: Object.freeze({
    phases: false,
    retryConditions: false
  }),
  // FR-R3-143 (T037) — `'workspace-trust'` is the honest idle value, not a
  // placeholder. This projection is what a host with no resolved trust publishes,
  // and what `composeTrustProjection` falls back to when the resolver throws; in
  // both cases nothing is allowed, and the ceiling — not a user or workspace
  // setting — is why.
  resolvedScope: Object.freeze({
    phases: 'workspace-trust',
    retryConditions: 'workspace-trust'
  })
});

export const AUDIT_TAIL_MAX = 50;
export const RECENT_QUEUE_MAX = 5;

export const IDLE_LIVE_ACTIVITY: LiveActivity = Object.freeze({
  summary: null,
  category: null,
  lastEventAt: null,
  freshness: 'idle',
  staleSeconds: null
});

/**
 * Feature 092 (T096, FR-054) — the read-side join, spelled once for the host.
 *
 * v3 let any consumer read "the" Run off the root; v4 requires it to say which
 * queue it means. This is that question and nothing more — no fallback to the
 * first queue, no synthesised runtime, because a consumer that names a queue
 * the registry does not have is asking about something that does not exist and
 * should see `null` rather than another queue's Run.
 */
export function findQueueRuntime(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string
): QueueRuntime | null {
  return snapshot.queues.find((runtime) => runtime.queueId === queueId) ?? null;
}

export function buildIdleSnapshot(opts: {
  isPrimary: boolean;
  producedAt?: string;
}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    isPrimary: opts.isPrimary,
    // Feature 092 (T091) — no registry has been read yet on an idle snapshot,
    // so there is no queue to publish a runtime for. Empty, never a fabricated
    // default entry: the registry is the only thing entitled to say a queue
    // exists.
    queues: Object.freeze([]) as readonly QueueRuntime[],
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      orderedItems: Object.freeze([]) as readonly QueueItem[],
      queues: Object.freeze([]) as readonly QueueSummary[],
      paused: false,
      pausedReason: null,
      lifecycle: 'active-empty' as const,
      scheduledStartAt: null,
      scheduledStartSource: null
    }),
    defaultRunnerKind: DEFAULT_BACKEND,
    auditTail: Object.freeze([]) as readonly AuditTailEntry[],
    debugLogTail: Object.freeze([]) as readonly DebugLogEntry[],
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: opts.producedAt ?? new Date().toISOString(),
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: emptyBackendModels(),
    configuredModels: emptyBackendModels(),
    availableBackends: Object.freeze([] as readonly BackendRunnerKind[]),
    // FR-R3-144 (T020) — empty, not a computed default.
    backendPostures: Object.freeze([] as readonly BackendPosture[]),
    backendGrantProblems: Object.freeze([] as readonly string[]),
    backendPingState: Object.freeze({ status: 'idle' as const }),
    generalSettings: IDLE_GENERAL_SETTINGS,
    queueSettings: IDLE_QUEUE_SETTINGS,
    sessionArtifacts: IDLE_SESSION_ARTIFACTS,
    streamPressure: IDLE_STREAM_PRESSURE,
    evidenceHealth: IDLE_EVIDENCE_HEALTH,
    // Feature 033 — telemetry is ephemeral and absent on idle snapshots.
    telemetry: null,
    // Feature 059 — idle snapshot uses fail-closed trust defaults until
    // the projector composes the first resolver read.
    workspaceTrust: IDLE_TRUST_PROJECTION.workspaceTrust,
    resolvedTrust: IDLE_TRUST_PROJECTION.resolvedTrust,
    resolvedScope: IDLE_TRUST_PROJECTION.resolvedScope
  });
}

export const IDLE_DELAYED_RETRY: DelayedRetryState = Object.freeze({
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0
});

/**
 * FR-R3-145 (T1572) — what the queue settings read as before any store has been
 * opened: exactly what a cold workspace's memento would return, derived from
 * the contract constants so neither restates the numbers.
 */
export const IDLE_QUEUE_SETTINGS: QueueSettingsProjection = Object.freeze({
  globalConcurrencyCap: DEFAULT_GLOBAL_CONCURRENCY_CAP,
  defaultQueueId: DEFAULT_QUEUE_ID
});

/** FR-R3-130 — nothing in flight is nothing held, which is the honest idle value. */
export const IDLE_STREAM_PRESSURE: StreamPressureProjection = Object.freeze({
  liveBuffers: 0,
  retainedBytes: 0,
  ceilingBytes: 0,
  machineMemoryBytes: 0
});

export const IDLE_SESSION_ARTIFACTS: SessionArtifactsProjection = Object.freeze({
  artifactCount: 0,
  totalBytes: 0,
  lastSweepAt: null,
  lastSweepFailures: 0
});

/**
 * Feature 011 — safe defaults for the `generalSettings` projection.
 * Mirrors the `package.json` defaults so the webview can render the
 * Settings surface even before the projector has finished its first
 * `onDidChangeConfiguration` round-trip.
 */
export const IDLE_GENERAL_SETTINGS: GeneralSettings = Object.freeze({
  cliPath: BACKEND_DESCRIPTORS.claude.defaultCliBinary,
  codexPath: BACKEND_DESCRIPTORS.codex.defaultCliBinary,
  agyPath: BACKEND_DESCRIPTORS.agy.defaultCliBinary,
  loggingVerbose: false,
  loopMaxIterations: 10,
  invocationIdleTimeoutSeconds: 5400,
  invocationMaxDurationSeconds: 21600,
  watchdogPollIntervalMinutes: 30,
  auditRotationSizeMB: 5,
  auditRotationMaxAgeDays: 30,
  defaultWorkflowId: '',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  sessionRetentionMaxBytes: 512 * 1024 * 1024,
  rawTranscriptMode: 'errors-only',
  transportCaptureMode: 'inherit',
  retryMaxAttempts: 5,
  retryForceContinueOnCap: false,
  cliInheritEnvironment: true,
  cliEnvironmentMode: 'allowlist',
  cliEnvironmentAllowlist: Object.freeze([]) as readonly string[],
  backendProbeTimeoutSeconds: 5,
  uiConfirmationsEnable: true,
  multiRootSuppressWarning: false,
  backendRunner: DEFAULT_BACKEND,
  spendMaxUsdPerRun: null,
  spendMaxTokensPerRun: null,
  queueHaltOnTaskFailure: 'halt-on-failure',
  scopes: Object.freeze({
    cliPath: 'default',
    codexPath: 'default',
    agyPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationIdleTimeoutSeconds: 'default',
    invocationMaxDurationSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultWorkflowId: 'default',
    fatalSignatures: 'default',
    claudeAutoCompactPctOverride: 'default',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default',
    rawTranscriptMode: 'default',
    transportCaptureMode: 'default',
    retryMaxAttempts: 'default',
    retryForceContinueOnCap: 'default',
    cliInheritEnvironment: 'default',
    cliEnvironmentMode: 'default',
    cliEnvironmentAllowlist: 'default',
    backendProbeTimeoutSeconds: 'default',
    uiConfirmationsEnable: 'default',
    multiRootSuppressWarning: 'default',
    backendRunner: 'default',
    spendMaxUsdPerRun: 'default',
    spendMaxTokensPerRun: 'default',
    queueHaltOnTaskFailure: 'default'
  })
});
