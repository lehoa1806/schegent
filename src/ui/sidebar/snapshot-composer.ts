import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { SanitizedLogger } from '../../lib/logger';
import { getResolvedCapabilities } from '../../state/capability-trust-resolver';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import type { WorkflowRun } from '../../state/workflow-run';
import type { FeatureRequest } from '../../queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../queue/queue-registry';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { HistoryStore } from '../../state/history-store';
import { projectHistory } from './history-projector';
import { projectMonitor } from './monitor-projector';
import { buildPhasesFromRun } from './phase-projector';
import { sanitizeAndCap, projectQueue, projectQueueRows } from './queue-projector';
import {
  buildActiveFeature,
  computeIsPrimary,
  mapRunStatus,
  projectDelayedRetry,
  projectRunOutputs
} from './run-projector';
import { ProjectorBookkeeping } from './projector-bookkeeping';
import { composePhaseCatalogProjection } from './phase-catalog-projection';
import { composePipelineCatalogProjection } from './pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from './workflow-catalog-projector';
import type { StateProjectorDeps } from './state-projector';
import {
  IDLE_EVIDENCE_HEALTH,
  IDLE_GENERAL_SETTINGS,
  IDLE_SESSION_ARTIFACTS,
  IDLE_TRUST_PROJECTION,
  SCHEMA_VERSION,
  type AuditTailEntry,
  type HistoryEntry,
  type QueueRuntime,
  type WorkflowSnapshot,
  type WorkflowStatus
} from './snapshot';
import { composeQueueRuntimes } from './queue-runtime-composer';

type ProjectorStore = Pick<
  WorkspaceStateStore,
  'getRun' | 'getQueue' | 'getLock' | 'subscribe'
> & Partial<Pick<
  WorkspaceStateStore,
  'getQueueRegistry' | 'getConfirmSuppression' | 'getRequestsForQueue'
>>;

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
  // Feature 092 (T108) — one row-projection context, reused per queue with that
  // queue's own in-flight and scheduled-start readings substituted in. The rest
  // (sanitizer, registry, active-run attribution) is workspace-wide and shared.
  const rowContext = {
    sanitize,
    inFlightPhase,
    inFlightId: queue.inFlightId,
    registry,
    inFlightManualPauseCause: run?.manualPauseCause ?? null,
    scheduledStartSource: queue.scheduledStartSource ?? null,
    scheduledStartAt: queue.scheduledStartAt ?? null,
    activeRunTaskId: run?.featureId ?? null,
    activeRunPhase: run?.currentPhase ?? null
  };
  const requestsOf = (queueId: string): readonly FeatureRequest[] =>
    store.getRequestsForQueue?.(queueId) ??
    (queueId === DEFAULT_QUEUE_ID ? queue.requests ?? [] : []);
  const queueProjection = projectQueue(queue, {
    ...rowContext,
    ...(store.getRequestsForQueue !== undefined
      ? { requestsOf: (queueId: string) => store.getRequestsForQueue!(queueId) }
      : {})
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
  const phaseCatalogProjection = composePhaseCatalogProjection(phaseCatalog, {
    sanitize,
    availableModels,
    defaultRunnerKind: ctx.defaultRunnerKind
  });
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
  // Feature 092 (T092, T093, T095, FR-048/FR-051/FR-053) — one runtime per
  // registry entry, composed from projections that already exist rather than
  // rebuilt: `queueProjection.queues` is the registry read, and
  // `getRequestsForQueue` the per-queue rows. The run-scoped readings attach to
  // the one queue that owns the Run and to no other, so an idle queue publishes
  // an empty runtime instead of borrowing its neighbour's.
  const queues: readonly QueueRuntime[] = composeQueueRuntimes({
    summaries: queueProjection.queues,
    run,
    status,
    phases,
    activePipeline: activePipeline ?? null,
    liveActivity: ctx.bookkeeping.liveActivity(status),
    elapsedMs: ctx.bookkeeping.workflowElapsedMs(status),
    delayedRetry: projectDelayedRetry(run),
    outputs: projectRunOutputs(run, sanitize).runOutputs ?? [],
    activeFeature: run ? buildActiveFeature(run) : null,
    lifecycleOf: (queueId) => store.getQueue(queueId).queueLifecycle,
    requestsOf,
    rowsOf: (queueId) => {
      const state = store.getQueue(queueId);
      return projectQueueRows(requestsOf(queueId), {
        ...rowContext,
        inFlightId: state.inFlightId,
        scheduledStartSource: state.scheduledStartSource ?? null,
        scheduledStartAt: state.scheduledStartAt ?? null
      });
    }
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
    queues,
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
    defaultRunnerKind: ctx.defaultRunnerKind,
    auditTail: Object.freeze([...ctx.auditTail]),
    debugLogTail: Object.freeze(deps.getDebugLogTail?.() ?? []),
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
    generalSettings: deps.getGeneralSettings?.() ?? IDLE_GENERAL_SETTINGS,
    sessionArtifacts: deps.getSessionArtifacts?.() ?? IDLE_SESSION_ARTIFACTS,
    evidenceHealth: deps.getEvidenceHealth?.() ?? IDLE_EVIDENCE_HEALTH,
    telemetry: ctx.telemetry,
    workspaceTrust,
    resolvedTrust,
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
