import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { SanitizedLogger } from '../../lib/logger';
import { getResolvedCapabilities } from '../../state/capability-trust-resolver';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import type { WorkflowRun } from '../../state/workflow-run';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { HistoryStore } from '../../state/history-store';
import { RUNNER_DEFAULT_MODEL, type WakeUpModelSelection } from '../../wakeup/settings';
import { projectHistory } from './history-projector';
import { projectMonitor } from './monitor-projector';
import { buildPhasesFromRun } from './phase-projector';
import { sanitizeAndCap, projectQueue } from './queue-projector';
import {
  buildActiveFeature,
  computeIsPrimary,
  mapRunStatus,
  projectDelayedRetry
} from './run-projector';
import { ProjectorBookkeeping } from './projector-bookkeeping';
import type { StateProjectorDeps } from './state-projector';
import {
  IDLE_EVIDENCE_HEALTH,
  IDLE_GENERAL_SETTINGS,
  IDLE_SESSION_ARTIFACTS,
  IDLE_TRUST_PROJECTION,
  IDLE_WAKEUP_LOG,
  IDLE_WAKEUP_SETTINGS,
  SCHEMA_VERSION,
  type AuditTailEntry,
  type HistoryEntry,
  type WorkflowSnapshot,
  type WorkflowStatus
} from './snapshot';

type ProjectorStore = Pick<
  WorkspaceStateStore,
  'getRun' | 'getQueue' | 'getLock' | 'subscribe'
> & Partial<Pick<WorkspaceStateStore, 'getQueueRegistry' | 'getConfirmSuppression'>>;

export interface SnapshotComposerContext {
  readonly deps: StateProjectorDeps;
  readonly store: ProjectorStore;
  readonly run: WorkflowRun | null;
  readonly ownerId: string;
  readonly forcedIsPrimary: boolean | null;
  readonly now: () => Date;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;
  readonly externalSanitize: ((value: string | null | undefined) => string) | null;
  readonly monitor: Pick<ClaudeCliMonitor, 'getCurrentState'> | null;
  readonly history: Pick<HistoryStore, 'list'> | null;
  readonly defaultRunnerKind: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly bookkeeping: ProjectorBookkeeping;
  readonly telemetry: TelemetrySnapshot | null;
}

/** Composes the immutable wire snapshot from focused domain projections. */
export function composeWorkflowSnapshot(ctx: SnapshotComposerContext): WorkflowSnapshot {
  const { deps, store } = ctx;
  const run = ctx.run;
  const queue = store.getQueue();
  const registry = store.getQueueRegistry?.();
  const lock = store.getLock();
  const confirmSuppression = store.getConfirmSuppression?.();
  const confirmationsEnabled = deps.getConfirmationsEnabled?.();
  const isPrimary = ctx.forcedIsPrimary !== null
    ? ctx.forcedIsPrimary
    : computeIsPrimary(ctx.ownerId, lock, ctx.now().getTime());
  const status: WorkflowStatus = run ? mapRunStatus(run) : 'idle';
  const phases = buildPhasesFromRun(run);
  ctx.bookkeeping.decoratePhases(phases, run);
  const sanitize = (value: string): string => ctx.logger
    ? ctx.logger.sanitize(value)
    : ctx.externalSanitize
      ? ctx.externalSanitize(value)
      : value;
  const inFlightPhase = run && run.currentPhase !== 'done' ? run.currentPhase : null;
  const queueProjection = projectQueue(queue, {
    sanitize,
    inFlightPhase,
    inFlightId: queue.inFlightId,
    registry,
    inFlightManualPauseCause: run?.manualPauseCause ?? null,
    scheduledStartSource: queue.scheduledStartSource ?? null,
    scheduledStartAt: queue.scheduledStartAt ?? null,
    activeRunTaskId: run?.featureId ?? null,
    activeRunPhase: run?.currentPhase ?? null
  });
  const catalog = deps.getCatalog?.() ?? { phases: [], pipelines: [], models: [] };
  const activePipeline = run?.pipeline && run.pipeline.id !== 'standard'
    ? Object.freeze({ id: run.pipeline.id, name: run.pipeline.name })
    : undefined;
  const phasePrecedence = deps.getPhasePrecedence?.();
  const wakeUp = Object.freeze({
    model: (deps.getWakeupModel?.() ?? RUNNER_DEFAULT_MODEL) as WakeUpModelSelection,
    sessionLogPath: deps.getWakeupSessionLogPath?.() ?? ''
  });

  let workspaceTrust = IDLE_TRUST_PROJECTION.workspaceTrust;
  let resolvedTrust = IDLE_TRUST_PROJECTION.resolvedTrust;
  try {
    const resolved = getResolvedCapabilities();
    workspaceTrust = resolved.workspaceTrust;
    resolvedTrust = Object.freeze({
      phases: resolved.phases,
      retryConditions: resolved.retryConditions,
      pipelineOverrides: resolved.pipelineOverrides
    });
  } catch (error) {
    ctx.logger?.warn(
      `projector: failed to resolve trust capabilities: ${(error as Error).message}`
    );
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    isPrimary,
    status,
    activeFeature: run ? buildActiveFeature(run) : null,
    phases: Object.freeze(phases.map((phase) => Object.freeze(phase))),
    queue: Object.freeze({
      inFlight: queueProjection.inFlight,
      pending: Object.freeze(queueProjection.pending.slice()),
      recent: Object.freeze(queueProjection.recent.slice()),
      orderedItems: Object.freeze(queueProjection.orderedItems.slice()),
      queues: Object.freeze(queueProjection.queues.slice()),
      paused: queue.paused,
      pausedReason: sanitizeAndCap(queue.pausedReason, sanitize),
      lifecycle: queue.queueLifecycle,
      scheduledStartAt: queue.scheduledStartAt,
      scheduledStartSource: queue.scheduledStartSource,
      migrationNotice: queue.migrationNotice
    }),
    phaseOverrides: Object.freeze((run?.phaseOverrides ?? []).map((override) =>
      Object.freeze({ phaseId: override.phaseId, action: override.action })
    )),
    manualPauseAt: run?.manualPauseAt !== null && run?.manualPauseAt !== undefined
      ? new Date(run.manualPauseAt).toISOString() : null,
    manualPauseCause: run?.manualPauseCause ?? null,
    phaseBreakpoints: Object.freeze([...(run?.phaseBreakpoints ?? [])]
      .sort((a, b) => a.setAt - b.setAt)
      .map((breakpoint) => Object.freeze({
        phaseId: breakpoint.phaseId,
        setAt: new Date(breakpoint.setAt).toISOString(),
        actor: breakpoint.actor
      }))),
    resumeTargetPhaseId: run?.resumeTargetPhaseId ?? null,
    activeRunId: run?.id ?? null,
    defaultRunnerKind: ctx.defaultRunnerKind,
    auditTail: Object.freeze([...ctx.auditTail]),
    debugLogTail: Object.freeze(deps.getDebugLogTail?.() ?? []),
    liveActivity: ctx.bookkeeping.liveActivity(status),
    workflowElapsedMs: ctx.bookkeeping.workflowElapsedMs(status),
    monitor: projectMonitor(ctx.monitor),
    history: Object.freeze(projectHistory(ctx.history)) as readonly HistoryEntry[],
    producedAt: ctx.now().toISOString(),
    availablePhases: Object.freeze([...catalog.phases]),
    availablePipelines: Object.freeze([...catalog.pipelines]),
    availableModels: Object.freeze(deps.getAvailableModels?.() ?? {
      claude: catalog.models,
      codex: ['codex-default'],
      agy: ['Gemini 3.1 Pro (High)']
    } as Record<BackendRunnerKind, readonly string[]>),
    availableBackends: Object.freeze(
      deps.getAvailableBackends?.() ?? (['claude'] as readonly BackendRunnerKind[])
    ),
    backendPingState: deps.getBackendPingState?.() ?? Object.freeze({ status: 'idle' as const }),
    delayedRetry: projectDelayedRetry(run),
    generalSettings: deps.getGeneralSettings?.() ?? IDLE_GENERAL_SETTINGS,
    sessionArtifacts: deps.getSessionArtifacts?.() ?? IDLE_SESSION_ARTIFACTS,
    evidenceHealth: deps.getEvidenceHealth?.() ?? IDLE_EVIDENCE_HEALTH,
    wakeUpSettings: deps.getWakeUpSettings?.() ?? IDLE_WAKEUP_SETTINGS,
    wakeUpLog: deps.getWakeUpLog?.() ?? IDLE_WAKEUP_LOG,
    wakeUp,
    telemetry: ctx.telemetry,
    workspaceTrust,
    resolvedTrust,
    ...(activePipeline ? { activePipeline } : {}),
    ...(phasePrecedence !== undefined ? { phasePrecedence } : {}),
    ...(confirmSuppression !== undefined ? { confirmSuppression } : {}),
    ...(confirmationsEnabled !== undefined ? { confirmationsEnabled } : {})
  });
}
