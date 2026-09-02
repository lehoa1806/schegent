import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type { SanitizedLogger } from '../../lib/logger';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import type { WorkflowRun } from '../../state/workflow-run';
import type { RunStateMap } from '../../state/run-state-migrator';
import type { FeatureRequest, QueueState } from '../../queue/feature-request';
import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../../contracts/queue-identity';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { HistoryStore } from '../../state/history-store';
import { projectHistory } from './history-projector';
import { projectMonitor } from './monitor-projector';
import { buildPhasesFromRun, currentPhaseOrNull } from './phase-projector';
import { sanitizeAndCap, projectQueue, projectQueueRows } from './queue-projector';
import {
  buildActiveFeature,
  computeIsPrimary,
  mapRunStatus,
  projectDelayedRetry,
  projectRunLiveness,
  projectRunOutputs,
  projectRunProgress
} from './run-projector';
import type { ProjectorBookkeepingRegistry } from './projector-bookkeeping-registry';
import { NO_BUILDER_LIFECYCLE_BY_KIND } from './builder-lifecycle';
import { composePhaseCatalogProjection } from './phase-catalog-projection';
import { composePipelineCatalogProjection } from './pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from './workflow-catalog-projector';
import { buildLaunchProjection } from './launch-projection';
import { composeTrustProjection } from './trust-projection';
import { composeBackendPostures } from './backend-posture-projection';
import type { StateProjectorDeps } from './state-projector';
import { totalmem } from 'node:os';

import { readStreamPressure } from '../../runner/zipped-stream-buffer';
import {
  IDLE_EVIDENCE_HEALTH,
  IDLE_GENERAL_SETTINGS,
  IDLE_SESSION_ARTIFACTS,
  SCHEMA_VERSION,
  type AuditTailEntry,
  type HistoryEntry,
  type QueueRuntime,
  type WorkflowSnapshot,
  type WorkflowStatus
} from './snapshot';
import {
  composeQueueRuntimes,
  projectStartFailure,
  type QueueRunProjection
} from './queue-runtime-composer';

/**
 * The shape both model fields fall back to when their source is absent.
 * Empty means "nothing known", which every consumer already handles; an
 * invented entry would be indistinguishable from a real one downstream.
 */
const EMPTY_MODELS_BY_BACKEND: Record<BackendRunnerKind, readonly string[]> = Object.freeze({
  claude: Object.freeze([]),
  codex: Object.freeze([]),
  agy: Object.freeze([])
});

type ProjectorStore = Pick<
  WorkspaceStateStore,
  'getRunMap' | 'getQueue' | 'getLock' | 'subscribe'
> & Partial<Pick<
  WorkspaceStateStore,
  | 'getProjectedQueueRegistry' | 'getConfirmSuppression' | 'getRequestsForQueue'
  | 'getGlobalConcurrencyCap' | 'getDefaultQueueId'
>>;

export interface SnapshotComposerContext {
  readonly deps: StateProjectorDeps;
  readonly store: ProjectorStore;
  /**
   * Feature 093 (T051) — every queue's Run, keyed by queue. Replaces the single
   * `run` this took: a window with N executing Runs has no one Run to hand a
   * composer, and picking one would publish that queue's phases beside every
   * other queue's rows.
   */
  readonly runs: Readonly<RunStateMap>;
  readonly ownerId: string;
  readonly forcedIsPrimary: boolean | null;
  readonly now: () => Date;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;
  readonly externalSanitize: ((value: string | null | undefined) => string) | null;
  readonly monitor: Pick<ClaudeCliMonitor, 'getCurrentState'> | null;
  readonly history: Pick<HistoryStore, 'list'> | null;
  readonly defaultRunnerKind: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly bookkeepers: ProjectorBookkeepingRegistry;
  readonly telemetry: TelemetrySnapshot | null;
}

/** Composes the immutable wire snapshot from focused domain projections. */
export function composeWorkflowSnapshot(ctx: SnapshotComposerContext): WorkflowSnapshot {
  const { deps, store } = ctx;
  // FR-R3-002 (T281) — named explicitly. The projections this feeds are
  // already keyed to `DEFAULT_QUEUE_ID` below (the single-queue lifecycle,
  // pause state and `migrationNotice` the sidebar renders), so pinning the
  // read states what the composer already meant rather than changing it.
  const queue = store.getQueue(DEFAULT_QUEUE_ID);
  // FR-R3-011 — the projected registry. Pause state is no longer persisted on
  // a registry entry; `getProjectedQueueRegistry()` fills it in from each
  // queue's `QueueState`, which is the same value the drain gate reads. The
  // composer takes the projection rather than re-deriving one so there is one
  // derivation site, not a second copy of the rule in the UI layer.
  const registry = store.getProjectedQueueRegistry?.();
  const lock = store.getLock();
  const confirmSuppression = store.getConfirmSuppression?.();
  const confirmationsEnabled = deps.getConfirmationsEnabled?.();
  const isPrimary = ctx.forcedIsPrimary !== null
    ? ctx.forcedIsPrimary
    : computeIsPrimary(ctx.ownerId, lock, ctx.now().getTime());
  const sanitize = (value: string): string => ctx.logger
    ? ctx.logger.sanitize(value)
    : ctx.externalSanitize
      ? ctx.externalSanitize(value)
      : value;
  const buildRunProjection = (run: WorkflowRun): QueueRunProjection => {
    const bookkeeping = ctx.bookkeepers.for(run.id);
    const status: WorkflowStatus = mapRunStatus(run);
    const phases = buildPhasesFromRun(run);
    bookkeeping.decoratePhases(phases, run);
    const origin = deps.getRunOrigin?.(run.featureId);
    return {
      run,
      status,
      phases,
      // Feature 098 (FR-008) — every Run that froze a Pipeline names it. The
      // `&& run.pipeline.id !== 'standard'` that stood here suppressed the name
      // of one particular id, back when that id belonged to a built-in Pipeline
      // whose name told the operator nothing they had not already been shown.
      // The catalog is runtime-only now: `standard` is whatever an operator
      // called a document they imported, and hiding its name hides theirs.
      activePipeline: run.pipeline
        ? Object.freeze({ id: run.pipeline.id, name: run.pipeline.name })
        : null,
      liveActivity: bookkeeping.liveActivity(status),
      // FR-R3-008 (T379) — the reload-durable half of the same question
      // `liveActivity` answers from memory, plus progress against the total the
      // Run froze. Both are `null` when the record predates the feature.
      liveness: projectRunLiveness(run),
      progress: projectRunProgress(run),
      elapsedMs: bookkeeping.workflowElapsedMs(status),
      delayedRetry: projectDelayedRetry(run),
      outputs: projectRunOutputs(run, sanitize).runOutputs ?? [],
      activeFeature: buildActiveFeature(run),
      // Feature 103 (T031, FR-003) — the same two provenance readings the
      // finished rows carry, so a Run reads identically in flight and once
      // recorded. Copied off the frozen plan, never re-resolved (FR-010).
      ...(run.pipeline?.catalogVersion !== undefined
        ? { catalogVersion: run.pipeline.catalogVersion }
        : {}),
      ...(origin !== undefined ? { origin } : {})
    };
  };
  // Memoized because two callers ask the same queue: the per-queue runtime list
  // and the row projections below. `decoratePhases` mutates the tiles it is
  // handed, so a second build would hand out a second set of tile objects that
  // must not be allowed to disagree.
  const runProjections = new Map<string, QueueRunProjection | null>();
  const runOf = (queueId: string): QueueRunProjection | null => {
    const memo = runProjections.get(queueId);
    if (memo !== undefined) return memo;
    const run = ctx.runs[queueId];
    const built = run ? buildRunProjection(run) : null;
    runProjections.set(queueId, built);
    return built;
  };
  // Feature 093 (T051) — the row-projection context is per queue, run-scoped
  // readings included. Feature 092 substituted only each queue's `inFlightId`
  // and scheduled-start into one shared context, so every queue's in-flight row
  // inherited the window Run's phase and pause cause. With one Run per queue
  // that is a visible cross-queue leak, not a harmless shared default.
  const rowContextFor = (queueId: string, state: QueueState) => {
    const run = runOf(queueId)?.run ?? null;
    return {
      sanitize,
      registry,
      inFlightPhase: currentPhaseOrNull(run),
      inFlightId: state.inFlightId,
      inFlightManualPauseCause: run?.manualPauseCause ?? null,
      scheduledStartSource: state.scheduledStartSource ?? null,
      scheduledStartAt: state.scheduledStartAt ?? null,
      activeRunTaskId: run?.featureId ?? null,
      activeRunPhase: currentPhaseOrNull(run)
    };
  };
  const requestsOf = (queueId: string): readonly FeatureRequest[] =>
    store.getRequestsForQueue?.(queueId) ??
    (queueId === DEFAULT_QUEUE_ID ? queue.requests ?? [] : []);
  const queueProjection = projectQueue(queue, {
    ...rowContextFor(DEFAULT_QUEUE_ID, queue),
    ...(store.getRequestsForQueue !== undefined
      ? { requestsOf: (queueId: string) => store.getRequestsForQueue!(queueId) }
      : {})
  });
  const catalog = deps.getCatalog?.() ?? {
    phases: [],
    pipelines: [],
    models: EMPTY_MODELS_BY_BACKEND
  };
  const phaseCatalog = deps.getPhaseCatalog?.();
  // Absent means "availability is unknown", which every consumer already reads
  // as "warn about nothing" — so the fallback is empty rather than a guess.
  // It used to invent one (`codex-default`, a Gemini DISPLAY name), which is
  // the same mistake the capability service made for `claude`/`codex`: a
  // fabricated list is indistinguishable from a discovered one downstream.
  const availableModels = deps.getAvailableModels?.() ?? EMPTY_MODELS_BY_BACKEND;
  // The operator's catalog, straight off the resolved configuration — no
  // separate dep, so it cannot drift from the catalog every other projection
  // reads, and it refreshes on the `schegent.models` reload already wired in
  // `extension.ts`.
  const configuredModels = catalog.models;
  const lifecycle = deps.getBuilderLifecycle?.() ?? NO_BUILDER_LIFECYCLE_BY_KIND;
  const phaseCatalogProjection = composePhaseCatalogProjection(phaseCatalog, {
    sanitize,
    availableModels,
    defaultRunnerKind: ctx.defaultRunnerKind,
    lifecycle: lifecycle.phase
  });
  const pipelineCatalogProjection = composePipelineCatalogProjection(deps.getPipelineCatalog, {
    sanitize,
    availableModels,
    defaultRunnerKind: ctx.defaultRunnerKind,
    lifecycle: lifecycle.pipeline,
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
  //
  // Feature 093 (T051, FR-030) — that attribution is now a keyed lookup per
  // queue rather than one Run offered to every queue in turn, which is what
  // makes each queue's Run separately visible. Reading the whole record to
  // build the list is the aggregate SC-012 exempts: the projection names every
  // queue it publishes, so no Run is reached without one.
  const queues: readonly QueueRuntime[] = composeQueueRuntimes({
    summaries: queueProjection.queues,
    runOf,
    lifecycleOf: (queueId) => store.getQueue(queueId).queueLifecycle,
    requestsOf,
    rowsOf: (queueId) =>
      projectQueueRows(requestsOf(queueId), rowContextFor(queueId, store.getQueue(queueId))),
    startFailureOf: (queueId) => projectStartFailure(deps.getQueueStartFailure?.(queueId), sanitize)
  });

  const trust = composeTrustProjection((message) => ctx.logger?.warn(message));
  // Feature 102 (FR-R3-018) — read off the two catalog projections above, never
  // re-resolved from the store; absent while either is still unresolved.
  const launchables = buildLaunchProjection(pipelineCatalogProjection, workflowCatalog);

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
      // FR-R3-011 — derived, not read. The wire field stays a boolean because
      // the webview renders one; the persisted mirror behind it is gone.
      paused: queue.queueLifecycle === 'operator-paused',
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
    configuredModels: Object.freeze(configuredModels),
    availableBackends: Object.freeze(
      deps.getAvailableBackends?.() ?? (['claude'] as readonly BackendRunnerKind[])
    ),
    ...composeBackendPostures(deps.getUncontainedGrantSetting?.()),
    backendPingState: deps.getBackendPingState?.() ?? Object.freeze({ status: 'idle' as const }),
    generalSettings: deps.getGeneralSettings?.() ?? IDLE_GENERAL_SETTINGS,
    // FR-R3-145 (T1572) — `store`, not `deps`: the cap is enforced against the
    // memento, not configuration. See `QueueSettingsProjection`.
    queueSettings: {
      globalConcurrencyCap: store.getGlobalConcurrencyCap?.() ?? DEFAULT_GLOBAL_CONCURRENCY_CAP,
      defaultQueueId: store.getDefaultQueueId?.() ?? DEFAULT_QUEUE_ID
    },
    sessionArtifacts: deps.getSessionArtifacts?.() ?? IDLE_SESSION_ARTIFACTS,
    // FR-R3-130 — read per composition, never cached; `totalmem()` rides with it.
    streamPressure: { ...readStreamPressure(), machineMemoryBytes: totalmem() },
    evidenceHealth: deps.getEvidenceHealth?.() ?? IDLE_EVIDENCE_HEALTH,
    telemetry: ctx.telemetry,
    // Spread: `TrustProjection`'s members ARE the snapshot's trust members.
    ...trust,
    ...(launchables !== undefined ? { launchables } : {}),
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
