import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { PhaseDef, PipelineDef } from '../../config/pipeline-config';
import type { ResolvedPipelineCatalog } from '../../config/pipeline-catalog';
import type { ResolvedPhaseCatalog } from '../../config/process-catalog';
import type { SanitizedLogger } from '../../lib/logger';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type { EvidenceHealthSnapshot } from '../../services/evidence-health/evidence-health-monitor';
import type { BackendPingState } from '../../services/backend-ping-service';
import type { Disposable, WorkspaceStateStore } from '../../state/workspace-state';
import type { HistoryStore } from '../../state/history-store';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { WorkflowCatalogResolution } from '../../contracts/workflow-definitions';
import type { ConnectedRunProjection } from '../../contracts/sidebar-ipc';
// Feature 103 — by path, not through the contracts barrel; see the note on the
// same import in `snapshot.ts`.
import type { RunOriginRef } from '../../contracts/run-origin';
import type { WorkflowPipelineReference } from './commands/router-types';
import type { BuilderLifecycleByKind } from './builder-lifecycle';
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
  // Feature 093 (T025) — `getRunMap` replaces `getRun` in the projector's slice
  // of the store. The projection is the pattern-D aggregate case: it wants every
  // queue's Run, not one queue's, so it never has a queue id to pass and the
  // queue-addressed accessor is the wrong shape for it.
  readonly store?: Pick<
    WorkspaceStateStore,
    'getRunMap' | 'getQueue' | 'getLock' | 'subscribe'
  > & Partial<Pick<WorkspaceStateStore, 'getProjectedQueueRegistry' | 'getConfirmSuppression'>>;
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
   * Feature 101 (FR-005, FR-007) — the catalog store's lifecycle facts, one
   * lookup per kind. Read fresh on every compose so a save that turns an Active
   * definition into `active-with-draft` is visible on the next projection.
   * Absent on a host with no catalog store wired; every Builder row then omits
   * `lifecycle` rather than claiming a state the host cannot know.
   */
  readonly getBuilderLifecycle?: () => BuilderLifecycleByKind;
  /**
   * Feature 088 — the connected runs, already projected. The host folds them
   * (aggregate + child-run states) rather than handing the composer the raw
   * aggregates, because the same fold answers the continuation handler's gate 4
   * and there must be exactly one. Absent on a host with no connected-run
   * wiring; the snapshot then omits the field entirely.
   */
  readonly getConnectedRuns?: () => readonly ConnectedRunProjection[];
  /**
   * Feature 103 (T031, FR-003) — how the Run holding this Task was started.
   *
   * A separate port from `getConnectedRuns` on purpose. That one hands over a
   * fold of node states, which cannot answer this: `ConnectedNodeProjection`
   * keeps only the *latest* attempt's queue item, so a Run from an earlier
   * attempt would read as standalone. This port runs the same `resolveRunOrigin`
   * the history recorder uses, so a Run in flight and the same Run once recorded
   * cannot disagree about where it came from.
   *
   * Absent on a host with no connected-run wiring; the projection then omits
   * `origin` rather than asserting `'standalone'` on a question it cannot ask.
   */
  readonly getRunOrigin?: (taskId: string) => RunOriginRef;
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
