// Feature 092 (T096) — test support for the v4 snapshot shape. Not a test file:
// `vitest.config.ts` collects `src/**/*.test.ts`, so this module is only ever
// imported, never run as a suite (same arrangement as
// `components/hover-text/__tests__/HoverTextHarness.svelte`).
//
// v3 fixtures spelled run state as top-level snapshot fields (`status`,
// `activeFeature`, `phases`, `liveActivity`, `workflowElapsedMs`, ...). v4 folds
// all of them under the queue that owns the Run (FR-048, FR-049). These builders
// take the v3 vocabulary a test already reads naturally and produce the folded
// shape, so a fixture migrates by wrapping its old fields rather than by being
// rewritten.

import type {
  ActiveFeatureSummary,
  ActivePipelineSummary,
  DelayedRetryState,
  InFlightRunProjection,
  LiveActivity,
  PhaseTile,
  QueueItem,
  QueueLifecycle,
  QueueRuntime,
  RunOutputRecord,
  WorkflowStatus
} from '../snapshot-types';
import { IDLE_DELAYED_RETRY } from '../snapshot-types';

/** The registry's always-present first queue, and the id every v3 fixture implies. */
export const DEFAULT_QUEUE_ID = 'default';

export const IDLE_LIVE_ACTIVITY: LiveActivity = Object.freeze({
  summary: null,
  category: null,
  lastEventAt: null,
  freshness: 'idle',
  staleSeconds: null
});

export interface InFlightRunOverrides {
  readonly runId?: string;
  readonly status?: WorkflowStatus;
  readonly feature?: ActiveFeatureSummary | null;
  readonly pipeline?: ActivePipelineSummary | null;
  readonly elapsedMs?: number | null;
  readonly liveActivity?: LiveActivity;
  readonly delayedRetry?: DelayedRetryState;
  readonly resumeTargetPhaseId?: string | null;
  readonly outputs?: readonly RunOutputRecord[];
}

/**
 * One queue's in-flight Run. `runId` defaults to the owning feature's id because
 * that is what the host projector stamps for a single-Task run, and the webview
 * surfaces that resolve a tail by task id rely on the equality.
 */
export function buildInFlightRun(overrides: InFlightRunOverrides = {}): InFlightRunProjection {
  const feature = overrides.feature ?? null;
  return Object.freeze({
    runId: overrides.runId ?? feature?.id ?? 'run-1',
    status: overrides.status ?? 'running',
    feature,
    pipeline: overrides.pipeline ?? null,
    elapsedMs: overrides.elapsedMs ?? null,
    liveActivity: overrides.liveActivity ?? IDLE_LIVE_ACTIVITY,
    delayedRetry: overrides.delayedRetry ?? IDLE_DELAYED_RETRY,
    resumeTargetPhaseId: overrides.resumeTargetPhaseId ?? null,
    outputs: Object.freeze(overrides.outputs ?? [])
  }) as InFlightRunProjection;
}

export interface QueueRuntimeOverrides {
  readonly queueId?: string;
  readonly name?: string;
  readonly position?: number;
  readonly lifecycle?: QueueLifecycle;
  readonly inFlightRun?: InFlightRunProjection | null;
  readonly phases?: readonly PhaseTile[];
  readonly phaseOverrides?: QueueRuntime['phaseOverrides'];
  readonly manualPause?: QueueRuntime['manualPause'];
  readonly phaseBreakpoints?: QueueRuntime['phaseBreakpoints'];
  /** Feature 187 — a queue whose last start attempt threw at admission. */
  readonly startFailure?: QueueRuntime['startFailure'];
  readonly pendingCount?: number;
  /** Feature 092 (T108, FR-057) — this queue's own rows, as the Queue Detail tier lists them. */
  readonly tasks?: readonly QueueItem[];
}

/**
 * One registered queue's runtime. Defaults describe an idle default queue that
 * owns no Run — the reading every v3 fixture had before it set `status` or
 * `activeFeature`, so a fixture that overrides nothing keeps its old meaning.
 */
export function buildQueueRuntime(overrides: QueueRuntimeOverrides = {}): QueueRuntime {
  return Object.freeze({
    queueId: overrides.queueId ?? DEFAULT_QUEUE_ID,
    name: overrides.name ?? 'Default',
    position: overrides.position ?? 0,
    lifecycle: overrides.lifecycle ?? 'active-empty',
    inFlightRun: overrides.inFlightRun ?? null,
    phases: Object.freeze(overrides.phases ?? []),
    phaseOverrides: Object.freeze(overrides.phaseOverrides ?? []),
    manualPause: overrides.manualPause ?? null,
    phaseBreakpoints: Object.freeze(overrides.phaseBreakpoints ?? []),
    // Defaulted rather than omitted: the field is required-and-nullable on the
    // wire, so a fixture that left it off would hand components `undefined` —
    // a value the host cannot produce and the surfaces are entitled not to guard.
    startFailure: overrides.startFailure ?? null,
    pendingCount: overrides.pendingCount ?? 0,
    tasks: Object.freeze(overrides.tasks ?? [])
  }) as QueueRuntime;
}

/**
 * The `queues` array for a workspace that has only the default queue — the
 * single-queue reading v3 fixtures assumed. Pass the v3 top-level fields and get
 * the folded v4 equivalent.
 */
export function buildDefaultQueues(
  overrides: QueueRuntimeOverrides & { readonly run?: InFlightRunOverrides | null } = {}
): readonly QueueRuntime[] {
  const { run, ...runtime } = overrides;
  return Object.freeze([
    buildQueueRuntime({
      ...runtime,
      inFlightRun:
        runtime.inFlightRun !== undefined
          ? runtime.inFlightRun
          : run
            ? buildInFlightRun(run)
            : null
    })
  ]);
}

/**
 * The v3 top-level run fields, exactly as fixtures spelled them. A migrated
 * `buildSnapshot` accepts these alongside `Partial<WorkflowSnapshot>` and hands
 * them to `foldLegacyRun`, so the test's own call sites keep their old wording.
 */
export interface LegacyRunFields {
  readonly status?: WorkflowStatus;
  readonly activeFeature?: ActiveFeatureSummary | null;
  readonly activePipeline?: ActivePipelineSummary | null;
  readonly activeRunId?: string | null;
  readonly phases?: readonly PhaseTile[];
  /** `null` is accepted because some v3 fixtures spelled "no activity" that way. */
  readonly liveActivity?: LiveActivity | null;
  readonly workflowElapsedMs?: number | null;
  readonly delayedRetry?: DelayedRetryState;
  readonly resumeTargetPhaseId?: string | null;
  readonly runOutputs?: readonly RunOutputRecord[];
  readonly manualPauseAt?: string | null;
  readonly manualPauseCause?: NonNullable<QueueRuntime['manualPause']>['cause'];
  readonly phaseOverrides?: QueueRuntime['phaseOverrides'];
  readonly phaseBreakpoints?: QueueRuntime['phaseBreakpoints'];
  readonly queueLifecycle?: QueueLifecycle;
  readonly queueId?: string;
}

/**
 * Fold a fixture's v3 top-level run fields into the v4 single-default-queue
 * `queues` array.
 *
 * A Run is projected exactly when the fixture said something about one: a
 * non-null `activeRunId` or `activeFeature`, a `status` other than `'idle'`, a
 * non-null `workflowElapsedMs`, a non-idle `liveActivity`, a scheduled
 * `delayedRetry`, or a non-empty `runOutputs`. That reproduces what v3 consumers
 * actually read — `hasActiveRun` was `activeRunId !== null`, and an idle
 * snapshot naming no feature had no Run to speak of — so a fixture keeps its
 * meaning without each test having to restate it.
 *
 * `phases`, the phase overrides, the breakpoints and the manual pause sit beside
 * `inFlightRun` on the runtime rather than under it, matching v4: a queue's
 * phase strip is still projected when that queue owns no Run.
 */
export function foldLegacyRun(fields: LegacyRunFields = {}): readonly QueueRuntime[] {
  const hasRun =
    (fields.activeRunId ?? null) !== null ||
    (fields.activeFeature ?? null) !== null ||
    (fields.status !== undefined && fields.status !== 'idle') ||
    (fields.workflowElapsedMs ?? null) !== null ||
    (fields.liveActivity != null && fields.liveActivity.freshness !== 'idle') ||
    (fields.delayedRetry !== undefined && fields.delayedRetry.pendingRetryAt !== null) ||
    (fields.runOutputs !== undefined && fields.runOutputs.length > 0);
  return buildDefaultQueues({
    queueId: fields.queueId,
    lifecycle: fields.queueLifecycle ?? (hasRun ? 'running' : 'active-empty'),
    phases: fields.phases,
    phaseOverrides: fields.phaseOverrides,
    phaseBreakpoints: fields.phaseBreakpoints,
    manualPause:
      fields.manualPauseAt != null
        ? { at: fields.manualPauseAt, cause: fields.manualPauseCause ?? 'operator-paused' }
        : null,
    inFlightRun: hasRun
      ? buildInFlightRun({
          runId: fields.activeRunId ?? undefined,
          status: fields.status,
          feature: fields.activeFeature ?? null,
          pipeline: fields.activePipeline ?? null,
          elapsedMs: fields.workflowElapsedMs ?? null,
          liveActivity: fields.liveActivity ?? undefined,
          delayedRetry: fields.delayedRetry,
          resumeTargetPhaseId: fields.resumeTargetPhaseId ?? null,
          outputs: fields.runOutputs
        })
      : null
  });
}
