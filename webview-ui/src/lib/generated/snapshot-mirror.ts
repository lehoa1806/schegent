// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/snapshot-descriptors.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate
//
// This module imports NOTHING from repo/src/. It is self-contained inside
// webview-ui/ and re-exported by webview-ui/src/lib/snapshot-types.ts.

import type { ActiveFeatureSummary, ActivePipelineSummary, AuditTailEntry, BackendGrantEntryProblems, BackendPosture, BackendRunnerKind, CliMonitorState, ConnectedRunProjection, CreditPollingProjection, DebugLogEntry, DegradedPhaseEntry, DelayedRetryState, EffectiveLimitsProjection, EvidenceOverallStatus, EvidenceSinkHealthProjection, LaunchProjection, LiveActivity, PhaseCatalogSourceRecord, PhaseDefinition, PhaseName, PhaseTile, PipelineCatalogSourceRecord, PipelineDefinition, PortablePhaseDefinition, PortablePipelineDefinition, PortableWorkflowDefinition, QueueItemStatus, QueueLifecycle, QueueSettingsProjection, QueueSummary, RunLivenessProjection, RunOutputRecord, RunProgressProjection, RuntimeLogLevel, ScheduledStartSource, SessionArtifactsProjection, SettingScope, StreamPressureProjection, TaskPhaseProgressProjection, TelemetrySnapshot, WorkflowCatalogSourceProjection, WorkflowStatus } from '../snapshot-types.js';
import type { QueueFailurePolicy } from './queue-failure-policy.js';

export const SCHEMA_VERSION = 4 as const;

/** Closed catalog kind vocabulary mirrored from canonical descriptor. */
type MirrorCatalogKind = 'phase' | 'workflow' | 'pipeline';

type MirrorHistoryTerminalStatus = 'completed' | 'failed' | 'canceled';

type MirrorManualPauseCause = 'operator-paused' | 'queue-paused-mid-run' | 'breakpoint-paused' | 'verify-paused' | 'spend-bound-reached';

type MirrorResolvedScope = 'user' | 'workspace' | 'workspace-trust';

/** Projected CLI transport capture disk usage for the Settings surface. */
type MirrorTransportUsage = {
  readonly version: 1;
  readonly retainedBytes: number;
  readonly runCount: number;
  readonly legacyBytes: number;
  readonly agesOutBy: string | null;
  readonly measuredAt: string;
};

/** Lines and bytes the transport sink refused under backpressure (FR-R3-106). */
export interface TransportDropCounts {
  readonly lines: number;
  readonly bytes: number;
}

/** Closed cause vocabulary for failed backend connectivity probes. */
export type BackendPingFailureCause = 'not-found' | 'not-executable' | 'non-zero-exit' | 'timed-out' | 'already-in-progress' | 'unknown';

/** Discriminated union describing the current backend ping probe lifecycle. */
export type BackendPingState =
  | {
      readonly status: 'idle';
    }
  | {
      readonly status: 'running';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly timeoutSeconds: number;
    }
  | {
      readonly status: 'success';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly completedAt: number;
      readonly latencyMs: number;
      readonly timeoutSeconds: number;
    }
  | {
      readonly status: 'failure';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly completedAt: number;
      readonly latencyMs: number;
      readonly timeoutSeconds: number;
      readonly cause: BackendPingFailureCause;
      readonly exitCode?: number;
    };

/** Published catalog version frozen into a run plan (Feature 103). */
export interface CatalogVersionRef {
  readonly kind: MirrorCatalogKind;
  readonly id: string;
  readonly versionId: string;
}

/** Discriminated provenance describing how a run was started (Feature 103). */
export type RunOriginRef =
  | {
      readonly kind: 'standalone';
    }
  | {
      readonly kind: 'workflow-member';
      readonly workflowId: string;
    };

/** Authoritative source-aware Phase catalog projection. */
export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceRecord[];
  readonly effective: readonly PortablePhaseDefinition[];
  readonly revision: string;
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/** Authoritative source-aware Pipeline catalog projection. */
export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceRecord[];
  readonly effective: readonly PortablePipelineDefinition[];
  readonly revision: string;
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/** Authoritative source-aware Workflow catalog projection. */
export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly PortableWorkflowDefinition[];
  readonly revision: string;
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/** Projected queued/active/historical task item. */
export interface QueueItem {
  readonly id: string;
  readonly label: string;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly status: QueueItemStatus;
  readonly retryCount: number;
  readonly lastErrorSummary: string | null;
  readonly pausedReason: string | null;
  readonly currentPhase: PhaseName | null;
  readonly queueId?: string;
  readonly position: number;
  readonly pauseCause?: 'queue-paused' | 'phase-paused' | 'manually-paused-task' | 'breakpoint' | null;
  /** Pipeline id under which this task is executing or last executed. */
  readonly currentPipelineId?: string | null;
  /** Heuristic flag indicating the task reached phase execution. */
  readonly hasOnDiskLogs?: boolean;
  /** Paused-row enrichment present only while status === paused. */
  readonly paused?: {
    readonly pauseSource: 'operator-paused' | 'system-paused';
    readonly pauseCauseCategory?: 'rate-limit' | 'fatal-signature' | 'operator-canceled';
    readonly resetsAtMs?: number;
  };
  /** Settled-phase progress pair; null means unknown, never 0 of 0. */
  readonly phaseProgress: TaskPhaseProgressProjection | null;
  /** Phases carried past their retry cap; absent when not degraded. */
  readonly degradedPhases?: readonly DegradedPhaseEntry[];
}

/** Top-level queue projection for the default queue and summary buckets. */
export interface QueueProjection {
  readonly inFlight: QueueItem | null;
  readonly pending: readonly QueueItem[];
  readonly recent: readonly QueueItem[];
  readonly orderedItems: readonly QueueItem[];
  readonly queues?: readonly QueueSummary[];
  readonly paused: boolean;
  readonly pausedReason?: string | null;
  readonly lifecycle?: QueueLifecycle;
  readonly scheduledStartAt?: number | null;
  readonly scheduledStartSource?: ScheduledStartSource | null;
  readonly migrationNotice?: 'pending' | 'dismissed';
}

/** Recorded terminal run entry projected for the History surface. */
export interface HistoryEntry {
  readonly runId: string;
  readonly featureId: string;
  readonly descriptionPreview: string;
  readonly terminalStatus: MirrorHistoryTerminalStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly lastErrorSummary: string | null;
  readonly auditLogPointer: string;
  readonly queueId: string;
  readonly catalogVersion?: CatalogVersionRef;
  readonly origin?: RunOriginRef;
  readonly descriptionLength?: number;
}

/** Typed read of scalar schegent.* settings projected with effective scopes. */
export interface GeneralSettings {
  readonly cliPath: string;
  readonly loggingVerbose: boolean;
  readonly loopMaxIterations: number;
  readonly invocationIdleTimeoutSeconds: number;
  readonly invocationMaxDurationSeconds: number;
  readonly watchdogPollIntervalMinutes: number;
  readonly auditRotationSizeMB: number;
  readonly auditRotationMaxAgeDays: number;
  readonly defaultWorkflowId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly runtimeLogLevel: RuntimeLogLevel;
  readonly runtimeLogFilePath: string;
  readonly retryMaxAttempts: number;
  readonly codexPath: string;
  readonly agyPath: string;
  readonly runtimeLogMaxBytes: number;
  readonly runtimeLogMaxGenerations: number;
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
  readonly rawTranscriptMode: 'always' | 'errors-only' | 'off';
  readonly transportCaptureMode: 'inherit' | 'off' | 'errors-only' | 'on';
  readonly retryForceContinueOnCap: boolean;
  readonly cliInheritEnvironment: boolean;
  readonly cliEnvironmentMode: string;
  readonly cliEnvironmentAllowlist: readonly string[];
  readonly backendProbeTimeoutSeconds: number;
  readonly uiConfirmationsEnable: boolean;
  readonly multiRootSuppressWarning: boolean;
  readonly backendRunner: BackendRunnerKind;
  readonly spendMaxUsdPerRun: number | null;
  readonly spendMaxTokensPerRun: number | null;
  readonly queueHaltOnTaskFailure: QueueFailurePolicy;
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationIdleTimeoutSeconds: SettingScope;
    readonly invocationMaxDurationSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly defaultWorkflowId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly runtimeLogLevel: SettingScope;
    readonly runtimeLogFilePath: SettingScope;
    readonly retryMaxAttempts: SettingScope;
    readonly codexPath: SettingScope;
    readonly agyPath: SettingScope;
    readonly runtimeLogMaxBytes: SettingScope;
    readonly runtimeLogMaxGenerations: SettingScope;
    readonly sessionRetentionMaxAgeDays: SettingScope;
    readonly sessionRetentionMaxBytes: SettingScope;
    readonly rawTranscriptMode: SettingScope;
    readonly transportCaptureMode: SettingScope;
    readonly retryForceContinueOnCap: SettingScope;
    readonly cliInheritEnvironment: SettingScope;
    readonly cliEnvironmentMode: SettingScope;
    readonly cliEnvironmentAllowlist: SettingScope;
    readonly backendProbeTimeoutSeconds: SettingScope;
    readonly uiConfirmationsEnable: SettingScope;
    readonly multiRootSuppressWarning: SettingScope;
    readonly backendRunner: SettingScope;
    readonly spendMaxUsdPerRun: SettingScope;
    readonly spendMaxTokensPerRun: SettingScope;
    readonly queueHaltOnTaskFailure: SettingScope;
  };
}

/** GeneralSettings projection plus optional measured transport capture disk usage. */
export type GeneralSettingsProjection = GeneralSettings & {
  readonly transportUsage?: MirrorTransportUsage;
};

/** Per-queue active Run projection nested under QueueRuntime.inFlightRun. */
export interface InFlightRunProjection {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly feature: ActiveFeatureSummary | null;
  readonly pipeline: ActivePipelineSummary | null;
  readonly elapsedMs: number | null;
  readonly liveActivity: LiveActivity;
  readonly liveness?: RunLivenessProjection | null;
  readonly progress?: RunProgressProjection | null;
  readonly delayedRetry: DelayedRetryState;
  readonly resumeTargetPhaseId: string | null;
  readonly outputs: readonly RunOutputRecord[];
  readonly catalogVersion?: CatalogVersionRef;
  readonly origin?: RunOriginRef;
  readonly creditPolling?: CreditPollingProjection | null;
  readonly effectiveLimits?: EffectiveLimitsProjection | null;
}

/** Per-queue published runtime state (Feature 092), including discriminated startFailure union. */
export interface QueueRuntime {
  readonly queueId: string;
  readonly name: string;
  readonly position: number;
  readonly lifecycle: QueueLifecycle;
  readonly inFlightRun: InFlightRunProjection | null;
  readonly phases: readonly PhaseTile[];
  readonly phaseOverrides: readonly ({
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  })[];
  readonly manualPause: {
    readonly at: string;
    readonly cause: MirrorManualPauseCause;
  } | null;
  readonly phaseBreakpoints: readonly ({
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  })[];
  readonly startFailure: 
    | {
        readonly kind: 'admission';
        readonly admission: 'admitNew' | 'admitResume';
        readonly at: string;
        readonly summary: string | null;
      }
    | {
        readonly kind: 'halted';
        readonly taskId: string;
        readonly taskName: string;
        readonly at: string;
      }
    | {
        readonly kind: 'stranded-run';
        readonly runId: string;
        readonly phase: string;
        readonly at: string;
      } | null;
  readonly pendingCount: number;
  readonly tasks: readonly QueueItem[];
  readonly scheduledStartAt: number | null;
  readonly scheduledStartSource: ScheduledStartSource | null;
}

/** Per-sink evidence durability and transport backpressure drop counts. */
export interface EvidenceHealthProjection {
  readonly overall: EvidenceOverallStatus;
  readonly audit: EvidenceSinkHealthProjection;
  readonly rawTranscript: EvidenceSinkHealthProjection;
  readonly runtimeLog: EvidenceSinkHealthProjection;
  readonly metricsRollup: EvidenceSinkHealthProjection;
  readonly historyPointer: EvidenceSinkHealthProjection;
  readonly auditCheckpoint?: EvidenceSinkHealthProjection;
  readonly transport?: EvidenceSinkHealthProjection;
  readonly verboseDiagnostics?: EvidenceSinkHealthProjection;
  /**
   * Transport lines/bytes dropped under backpressure (optional in webview for legacy host tolerance).
   */
  readonly transportDrops?: TransportDropCounts;
}

/** Authoritative v4 sidebar state snapshot envelope pushed via STATE_SNAPSHOT. */
export interface WorkflowSnapshot {
  readonly schemaVersion: 4;
  readonly isPrimary: boolean;
  readonly queues: readonly QueueRuntime[];
  readonly queue: QueueProjection;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly debugLogTail?: readonly DebugLogEntry[];
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly availablePipelines: readonly PipelineDefinition[];
  readonly availablePhases: readonly PhaseDefinition[];
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  readonly configuredModels?: Record<BackendRunnerKind, readonly string[]>;
  readonly workspaceModelCatalog?: {
    readonly revision: string;
    readonly models: Record<BackendRunnerKind, readonly string[]>;
  };
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly backendPostures?: readonly BackendPosture[];
  readonly backendGrantProblems?: BackendGrantEntryProblems;
  readonly backendPingState?: BackendPingState;
  readonly generalSettings?: GeneralSettingsProjection;
  readonly queueSettings?: QueueSettingsProjection;
  readonly sessionArtifacts?: SessionArtifactsProjection;
  readonly streamPressure?: StreamPressureProjection;
  readonly evidenceHealth?: EvidenceHealthProjection;
  readonly phaseCatalog?: PhaseCatalogProjection;
  readonly pipelineCatalog?: PipelineCatalogProjection;
  readonly workflowCatalog?: WorkflowCatalogProjection;
  readonly launchables?: LaunchProjection;
  readonly defaultWorkflowId?: string;
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  readonly telemetry?: TelemetrySnapshot | null;
  readonly workspaceTrust?: boolean;
  readonly resolvedTrust?: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
  };
  readonly resolvedScope?: {
    readonly phases: MirrorResolvedScope;
    readonly retryConditions: MirrorResolvedScope;
  };
  readonly confirmSuppression?: {
    readonly version: 1;
    readonly suppressedActionKeys: readonly string[];
  };
  readonly confirmationsEnabled?: boolean;
}
