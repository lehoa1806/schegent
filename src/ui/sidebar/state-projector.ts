import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { PhasePrecedenceProjection } from '../../config/phase-precedence';
import type { PhaseDef, PipelineDef } from '../../config/pipeline-config';
import type { SanitizedLogger } from '../../lib/logger';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { EvidenceHealthSnapshot } from '../../services/evidence-health/evidence-health-monitor';
import type { BackendPingState } from '../../services/backend-ping-service';
import type { Disposable, WorkspaceStateStore } from '../../state/workspace-state';
import type { HistoryStore } from '../../state/history-store';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { WakeUpModelSelection } from '../../wakeup/settings';
import { StateProjectorRuntime } from './state-projector-runtime';
import type {
  AuditTailEntry,
  DebugLogEntry,
  GeneralSettings,
  SessionArtifactsProjection,
  WakeUpLogProjection,
  WakeUpSettings,
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
    models: readonly string[];
  };
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly getGeneralSettings?: () => GeneralSettings;
  readonly getSessionArtifacts?: () => SessionArtifactsProjection;
  readonly getEvidenceHealth?: () => EvidenceHealthSnapshot;
  readonly getWakeUpSettings?: () => WakeUpSettings;
  readonly getWakeUpLog?: () => WakeUpLogProjection;
  readonly getWakeupModel?: () => WakeUpModelSelection;
  readonly getWakeupSessionLogPath?: () => string;
  readonly getPhasePrecedence?: () => PhasePrecedenceProjection | undefined;
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
