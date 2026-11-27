// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/snapshot-descriptors.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import type { GeneralSettings } from '../../config/general-settings';
import type { PhaseDef } from '../../config/pipeline-config';
import type { ScheduledStartSource } from '../../queue/feature-request';
import type { BackendPingState } from '../../services/backend-ping-service';
import type { EvidenceHealthSnapshot } from '../../services/evidence-health/evidence-health-monitor';
import type { ManualPauseCause } from '../../state/workflow-run';
import type { BackendRunnerKind } from '../backend-kinds';
import type { CatalogVersionRef } from '../catalog-version';
import type { PhaseName } from '../phase-identity';
import type { PipelineDefinition, PipelineSourceStatus } from '../pipeline-definitions';
import type { PhaseDefinition, PhaseSourceStatus } from '../process-definitions';
import type { RunOriginRef } from '../run-origin';
import type { RunOutputRecord } from '../run-results';
import type { ConnectedRunProjection } from '../sidebar-ipc';
import type { TransportUsage } from '../sidebar-ipc/transport-usage';
import type { ResolvedScope } from '../sidebar-ipc/trust';
import type { BackendGrantEntryProblems, BackendPosture } from '../sidebar-ipc/uncontained-grant';
import type { ActiveFeatureSummary, ActivePipelineSummary, AuditTailEntry, BuilderLifecycle, CliMonitorState, CreditPollingProjection, DegradedPhaseEntry, DelayedRetryState, EffectiveLimitsProjection, LaunchProjection, LiveActivity, PhaseTile, QueueItemStatus, QueueSettingsProjection, QueueSummary, RunLivenessProjection, RunProgressProjection, SessionArtifactsProjection, StreamPressureProjection, TaskPhaseProgressProjection, WorkflowCatalogFieldErrorProjection, WorkflowStatus } from '../snapshot-projections';
import type { DebugLogEntry, PipelineDef, QueueLifecycle, TelemetrySnapshot } from '../snapshot-vocabulary';
import type { WorkflowDefinition, WorkflowDerivedPort, WorkflowSourceStatus } from '../workflow-definitions';

export const SCHEMA_VERSION = 4 as const;

/** Per-field validation error on a Phase catalog record. */
export interface PhaseCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** One resolved or draft-only Phase record in the Phase catalog projection. */
export interface PhaseCatalogSourceProjection {
  readonly key: string;
  readonly phaseId: string;
  readonly status: PhaseSourceStatus;
  readonly definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PhaseCatalogFieldErrorProjection[];
  readonly modelAvailable?: boolean;
  readonly lifecycle?: BuilderLifecycle;
}

/** Authoritative source-aware Phase catalog projection. */
export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceProjection[];
  readonly effective: readonly PhaseDefinition[];
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

/** Per-field validation error on a Pipeline catalog record. */
export interface PipelineCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** One resolved or draft-only Pipeline record in the Pipeline catalog projection. */
export interface PipelineCatalogSourceProjection {
  readonly key: string;
  readonly pipelineId: string;
  readonly status: PipelineSourceStatus;
  readonly definition: PipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PipelineCatalogFieldErrorProjection[];
  readonly modelAvailable?: boolean;
  readonly consumingWorkflowIds?: readonly string[];
  readonly lifecycle?: BuilderLifecycle;
}

/** Authoritative source-aware Pipeline catalog projection. */
export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceProjection[];
  readonly effective: readonly PipelineDefinition[];
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

/** One resolved or draft-only Workflow record in the Workflow catalog projection. */
export interface WorkflowCatalogSourceProjection {
  readonly key: string;
  readonly workflowId: string;
  readonly status: WorkflowSourceStatus;
  readonly definition: WorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowCatalogFieldErrorProjection[];
  readonly derivedInputs: readonly WorkflowDerivedPort[];
  readonly derivedOutputs: readonly WorkflowDerivedPort[];
  readonly lifecycle?: BuilderLifecycle;
}

/** Authoritative source-aware Workflow catalog projection. */
export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly WorkflowDefinition[];
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
  readonly queueId: string;
  readonly position: number;
  readonly pauseCause: 'queue-paused' | 'phase-paused' | 'manually-paused-task' | 'breakpoint' | null;
  /** Pipeline id under which this task is executing or last executed. */
  readonly currentPipelineId: string | null;
  /** Heuristic flag indicating the task reached phase execution. */
  readonly hasOnDiskLogs: boolean;
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
  readonly queues: readonly QueueSummary[];
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly lifecycle: QueueLifecycle;
  readonly scheduledStartAt: number | null;
  readonly scheduledStartSource: ScheduledStartSource | null;
  readonly migrationNotice?: 'pending' | 'dismissed';
}

/** Recorded terminal run entry projected for the History surface. */
export interface HistoryEntry {
  readonly runId: string;
  readonly featureId: string;
  readonly descriptionPreview: string;
  readonly terminalStatus: 'completed' | 'failed' | 'canceled';
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

/** GeneralSettings projection plus optional measured transport capture disk usage. */
export type GeneralSettingsProjection = GeneralSettings & {
  readonly transportUsage?: TransportUsage;
};

/** Per-queue active Run projection nested under QueueRuntime.inFlightRun. */
export interface InFlightRunProjection {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly feature: ActiveFeatureSummary | null;
  readonly pipeline: ActivePipelineSummary | null;
  readonly elapsedMs: number | null;
  readonly liveActivity: LiveActivity;
  readonly liveness: RunLivenessProjection | null;
  readonly progress: RunProgressProjection | null;
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
    readonly cause: ManualPauseCause;
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

/** Fail-closed Workspace Trust and per-capability trust resolution projection. */
export interface TrustProjection {
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
  };
  readonly resolvedScope: {
    readonly phases: ResolvedScope;
    readonly retryConditions: ResolvedScope;
  };
}

/** Authoritative v4 sidebar state snapshot envelope pushed via STATE_SNAPSHOT. */
export interface WorkflowSnapshot {
  readonly schemaVersion: 4;
  readonly isPrimary: boolean;
  readonly queues: readonly QueueRuntime[];
  readonly queue: QueueProjection;
  readonly defaultRunnerKind: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly debugLogTail: readonly DebugLogEntry[];
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly availablePipelines: readonly PipelineDef[];
  readonly availablePhases: readonly PhaseDef[];
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  readonly configuredModels: Record<BackendRunnerKind, readonly string[]>;
  readonly workspaceModelCatalog?: {
    readonly revision: string;
    readonly models: Record<BackendRunnerKind, readonly string[]>;
  };
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly backendPostures: readonly BackendPosture[];
  readonly backendGrantProblems: BackendGrantEntryProblems;
  readonly backendPingState: BackendPingState;
  readonly generalSettings: GeneralSettingsProjection;
  readonly queueSettings: QueueSettingsProjection;
  readonly sessionArtifacts: SessionArtifactsProjection;
  readonly streamPressure: StreamPressureProjection;
  readonly evidenceHealth: EvidenceHealthSnapshot;
  readonly phaseCatalog?: PhaseCatalogProjection;
  readonly pipelineCatalog?: PipelineCatalogProjection;
  readonly workflowCatalog?: WorkflowCatalogProjection;
  readonly launchables?: LaunchProjection;
  readonly defaultWorkflowId?: string;
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  readonly telemetry: TelemetrySnapshot | null;
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
  };
  readonly resolvedScope: {
    readonly phases: ResolvedScope;
    readonly retryConditions: ResolvedScope;
  };
  readonly confirmSuppression?: {
    readonly version: 1;
    readonly suppressedActionKeys: readonly string[];
  };
  readonly confirmationsEnabled?: boolean;
}
