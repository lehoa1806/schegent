import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { PhasePrecedenceProjection } from '../../config/phase-precedence';
import type { PhaseDef, PipelineDef } from '../../config/pipeline-config';
import type { ResolvedPipelineCatalog } from '../../config/pipeline-catalog';
import type { ResolvedPhaseCatalog } from '../../config/process-catalog';
import type { SanitizedLogger } from '../../lib/logger';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { EvidenceHealthSnapshot } from '../../services/evidence-health/evidence-health-monitor';
import type { BackendPingState } from '../../services/backend-ping-service';
import type { Disposable, WorkspaceStateStore } from '../../state/workspace-state';
import type { HistoryStore } from '../../state/history-store';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { WorkflowCatalogResolution } from '../../contracts/workflow-definitions';
import type { ConnectedRunProjection } from '../../contracts/sidebar-ipc';
import type { WorkflowPipelineReference } from './commands/router-types';
import { StateProjectorRuntime } from './state-projector-runtime';
import type {
  AuditTailEntry,
  DebugLogEntry,
  GeneralSettings,
  SessionArtifactsProjection,
  
  WorkflowSnapshot
} from './snapshot';

export { sanitizeAndCap, PAUSED_REASON_MAX_LENGTH } from './queue-projector';
export { projectAuditEntry } from './audit-tail-projector';

export interface ProjectorTimer {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface StateProjectorDeps {
  readonly store?: Pick<
    WorkspaceStateStore,
    'getRun' | 'getQueue' | 'getLock' | 'subscribe'
  > & Partial<Pick<WorkspaceStateStore, 'getQueueRegistry' | 'getConfirmSuppression'>>;
  readonly audit?: Pick<AuditLogWriter, 'subscribe' | 'logPath' | 'workspaceRoot'>;
  readonly ownerId?: string;
  readonly isPrimary?: boolean;
  readonly sanitize?: (value: string | null | undefined) => string;
  readonly debounceMs?: number;
  readonly tickIntervalMs?: number;
  readonly timer?: ProjectorTimer;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly logger?: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'>;
  readonly monitor?: Pick<
    ClaudeCliMonitor,
    'getCurrentState' | 'subscribe' | 'onWorkflowPaused' | 'onWorkflowResumed'
  > | null;
  readonly history?: Pick<HistoryStore, 'list' | 'subscribe'> | null;
  readonly getCatalog?: () => {
    phases: readonly PhaseDef[];
    pipelines: readonly PipelineDef[];
    models: Record<BackendRunnerKind, readonly string[]>;
  };
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly getGeneralSettings?: () => GeneralSettings;
  readonly getSessionArtifacts?: () => SessionArtifactsProjection;
  readonly getEvidenceHealth?: () => EvidenceHealthSnapshot;
  readonly getPhasePrecedence?: () => PhasePrecedenceProjection | undefined;
  readonly getPhaseCatalog?: () => ResolvedPhaseCatalog | undefined;
  /** Feature 082 — resolved Pipeline catalog; throwing projects `state: 'error'`. */
  readonly getPipelineCatalog?: () => ResolvedPipelineCatalog | undefined;
  /**
   * Feature 082 (FR-002) — Workflow → Pipeline references for the Library's
   * consuming-Workflow list, from `collectWorkflowPipelineRefs`. Absent on a
   * host with no queue wiring; the Library then shows no consumers.
   */
  readonly getWorkflowPipelineRefs?: () => readonly WorkflowPipelineReference[];
  /**
   * Feature 083 — resolved Workflow catalog (the definition sense). Read fresh
   * on every compose; throwing projects `state: 'error'` rather than failing the
   * snapshot. Absent until the host has resolved a catalog, which the Builder
   * renders as a loading state (FR-036).
   */
  readonly getWorkflowCatalog?: () => WorkflowCatalogResolution | undefined;
  /**
   * Feature 088 — the connected runs, already projected. The host folds them
   * (aggregate + child-run states) rather than handing the composer the raw
   * aggregates, because the same fold answers the continuation handler's gate 4
   * and there must be exactly one. Absent on a host with no connected-run
   * wiring; the snapshot then omits the field entirely.
   */
  readonly getConnectedRuns?: () => readonly ConnectedRunProjection[];
  readonly getConfirmationsEnabled?: () => boolean;
  readonly getDebugLogTail?: () => readonly DebugLogEntry[];
  readonly getAvailableModels?: () => Record<BackendRunnerKind, readonly string[]>;
  readonly getAvailableBackends?: () => readonly BackendRunnerKind[];
  readonly getBackendPingState?: () => BackendPingState;
}

export type ProjectorListener = (snapshot: WorkflowSnapshot) => void;

/** Public facade: lifecycle, subscription, telemetry sanitization, composition. */
export class StateProjector {
  private readonly runtime: StateProjectorRuntime;

  constructor(deps: StateProjectorDeps) {
    this.runtime = new StateProjectorRuntime(deps);
  }

  public start(): void { this.runtime.start(); }
  public getCurrentSnapshot(): WorkflowSnapshot { return this.runtime.getCurrentSnapshot(); }
  public kick(): void { this.runtime.kick(); }
  public updateTelemetry(snapshot: TelemetrySnapshot | null): void {
    this.runtime.updateTelemetry(snapshot);
  }
  public subscribe(listener: ProjectorListener): Disposable {
    return this.runtime.subscribe(listener);
  }
  public seedAuditTail(entries: readonly AuditTailEntry[]): void {
    this.runtime.seedAuditTail(entries);
  }
  public project(): WorkflowSnapshot { return this.runtime.project(); }
  public dispose(): void { this.runtime.dispose(); }
}
