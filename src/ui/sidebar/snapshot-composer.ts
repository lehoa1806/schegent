import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { PhaseDefinition } from '../../contracts/process-definitions';
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
  projectDelayedRetry,
  projectRunOutputs
} from './run-projector';
import { ProjectorBookkeeping } from './projector-bookkeeping';
import { composePipelineCatalogProjection } from './pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from './workflow-catalog-projector';
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

function catalogText(value: string, sanitize: (value: string) => string, max: number): string {
  return sanitize(value).slice(0, max);
}

function projectPhaseDefinition(
  definition: PhaseDefinition,
  sanitize: (value: string) => string
): PhaseDefinition {
  const common = {
    phaseId: catalogText(definition.phaseId, sanitize, 64),
    name: catalogText(definition.name, sanitize, 80),
    version: definition.version,
    ...(definition.description !== undefined
      ? { description: catalogText(definition.description, sanitize, 1024) }
      : {}),
    ...(definition.model !== undefined
      ? { model: catalogText(definition.model, sanitize, 512) }
      : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.timeoutSeconds !== undefined
      ? { timeoutSeconds: definition.timeoutSeconds }
      : {}),
    ...(definition.loopable !== undefined ? { loopable: definition.loopable } : {}),
    ...(definition.retryCondition !== undefined
      ? { retryCondition: catalogText(definition.retryCondition, sanitize, 8192) }
      : {}),
    ...(definition.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
    ...(definition.runner !== undefined ? { runner: definition.runner } : {})
  };
  return Object.freeze(
    definition.instruction !== undefined
      ? { ...common, instruction: catalogText(definition.instruction, sanitize, 8192) }
      : { ...common, skill: catalogText(definition.skill, sanitize, 256) }
  );
}

function projectDisplay(
  display: Readonly<Record<string, unknown>>,
  sanitize: (value: string) => string
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(display)) {
    if (typeof value === 'string') {
      const max = field === 'instruction' || field === 'retryCondition'
        ? 8192
        : field === 'description'
          ? 1024
          : field === 'skill'
            ? 256
            : 512;
      projected[field] = catalogText(value, sanitize, max);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      projected[field] = value;
    }
  }
  return Object.freeze(projected);
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
  const phaseCatalog = deps.getPhaseCatalog?.();
  const availableModels = deps.getAvailableModels?.() ?? {
    claude: catalog.models,
    codex: ['codex-default'],
    agy: ['Gemini 3.1 Pro (High)']
  } as Record<BackendRunnerKind, readonly string[]>;
  const phaseCatalogProjection = phaseCatalog
    ? Object.freeze({
        state: 'ready' as const,
        records: Object.freeze(phaseCatalog.records.map((record) => {
          const definition = record.definition
            ? projectPhaseDefinition(record.definition, sanitize)
            : null;
          const runner = definition?.runner ?? ctx.defaultRunnerKind;
          return Object.freeze({
            key: catalogText(record.key, sanitize, 160),
            phaseId: catalogText(record.phaseId, sanitize, 64),
            scope: record.scope,
            status: record.status,
            definition,
            display: projectDisplay(record.display, sanitize),
            errors: Object.freeze(record.errors.map((error) => Object.freeze({
              field: catalogText(error.field, sanitize, 32),
              code: catalogText(error.code, sanitize, 64),
              message: catalogText(error.message, sanitize, 512)
            }))),
            ...(definition?.model !== undefined
              ? { modelAvailable: (availableModels[runner] ?? []).includes(definition.model) }
              : {})
          });
        })),
        effective: Object.freeze(
          phaseCatalog.effective.map((definition) => projectPhaseDefinition(definition, sanitize))
        ),
        revisions: phaseCatalog.revisions,
        warnings: Object.freeze(phaseCatalog.warnings.map((warning) => Object.freeze({
          code: catalogText(warning.code, sanitize, 64),
          message: catalogText(warning.message, sanitize, 512)
        })))
      })
    : undefined;
  const pipelineCatalogProjection = composePipelineCatalogProjection(deps.getPipelineCatalog, {
    sanitize,
    availableModels,
    defaultRunnerKind: ctx.defaultRunnerKind,
    ...(deps.getWorkflowPipelineRefs !== undefined
      ? { workflowRefs: deps.getWorkflowPipelineRefs() }
      : {}),
    onError: (message) => ctx.logger?.warn(message)
  });
  const workflowCatalog = composeWorkflowCatalogProjection(deps, sanitize, (m) => ctx.logger?.warn(m));
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
      pipelineOverrides: resolved.pipelineOverrides,
      workflowOverrides: resolved.workflowOverrides
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
    availableModels: Object.freeze(availableModels),
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
    ...projectRunOutputs(run, sanitize),
    ...(activePipeline ? { activePipeline } : {}),
    ...(phasePrecedence !== undefined ? { phasePrecedence } : {}),
    ...(phaseCatalogProjection !== undefined ? { phaseCatalog: phaseCatalogProjection } : {}),
    ...(pipelineCatalogProjection !== undefined
      ? { pipelineCatalog: pipelineCatalogProjection }
      : {}),
    ...(workflowCatalog !== undefined ? { workflowCatalog } : {}),
    ...(deps.getConnectedRuns ? { connectedRuns: deps.getConnectedRuns() } : {}),
    ...(confirmSuppression !== undefined ? { confirmSuppression } : {}),
    ...(confirmationsEnabled !== undefined ? { confirmationsEnabled } : {})
  });
}
