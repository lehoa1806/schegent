import type { SanitizedLogger } from '../../../lib/logger';
import type { AuditEventType } from '../../../contracts/audit-events';
import type { BackendPingService } from '../../../services/backend-ping-service';
import type { WritablePhaseDefinitionScope } from '../../../contracts/process-definitions';
import type { WorkflowDefinitionScope } from '../../../contracts/workflow-definitions';
import type { PipelineCatalog } from '../../../config/pipeline-config';
import type { RunOutputRecord } from '../../../contracts/run-results';
import type { BackendRunnerKind } from '../../../runner/backend-runner-factory';
import type { ConnectedWorkflowRun } from '../../../state/connected-workflow-run';
import type { ConnectedRunWriteResult } from '../../../state/workspace-state';
import type { ChildRunStateReader } from '../connected-run-projector';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../../services/guarded-run-service';
import type {
  CommandAckMessage,
  ExportProcessYamlResult,
  ReadMetricsRequest,
  ReadMetricsResponse,
  ReadPhaseLogRequest,
  ReadPhaseLogResponse,
  StartPhaseLogTailRequest,
  StartPhaseLogTailResponse,
  StopPhaseLogTailRequest,
  StopPhaseLogTailResponse
} from '../messages';

export interface QueueRemover {
  remove(id: string): Promise<boolean>;
}

export interface QueueOps {
  retry(id: string): Promise<{ ok: boolean; reason?: string }>;
  moveUp(id: string): Promise<{ ok: boolean; reason?: string }>;
  moveDown(id: string): Promise<{ ok: boolean; reason?: string }>;
  clearCompleted(): Promise<{ removed: number }>;
  clearFailed(): Promise<{ removed: number }>;
  setQueuePausedState(
    paused: boolean,
    queueId?: string,
    reason?: string | null,
    pauseSource?: 'operator' | 'cascade' | 'retry-cap',
    resumePrompt?: string
  ): Promise<{ ok: boolean; reason?: string; queueId?: string }>;
  modifyTask?(
    taskId: string,
    description: string
  ): Promise<{ ok: boolean; reason?: string; queueId?: string }>;
  removeTask?(
    taskId: string
  ): Promise<{
    ok: boolean;
    reason?: string;
    queueId?: string;
    taskId?: string;
    priorStatus?: string;
    runId?: string | null;
    sessionCleaned?: boolean;
  }>;
  reorderTask?(
    taskId: string,
    newPosition: number
  ): Promise<{ ok: boolean; reason?: string; queueId?: string }>;
  // Feature 065 BUG-009 T078 (FR-030) — `newPosition` is interpreted as
  // an index into the projector's flattened `orderedItems` array (global
  // sequence). `fromPosition` / `toPosition` are PENDING-ARRAY indices
  // (audit coordinate); `fromGlobalPosition` exposes the source row's
  // global index for the arrow-move handler's `globalPos + delta` math.
  reorderTaskInUnifiedQueue?(
    taskId: string,
    newPosition: number
  ): Promise<{
    outcome: 'success' | 'rejected';
    cause?: 'task-not-pending' | 'invalid-position' | 'no-op';
    fromPosition: number;
    toPosition: number;
    fromGlobalPosition: number;
    newOrder: readonly string[];
  }>;
}

export interface PhaseOps {
  skipPhase(phaseId: string): Promise<{ ok: boolean; reason?: string }>;
  disablePhase(phaseId: string): Promise<{ ok: boolean; reason?: string }>;
  enablePhase(phaseId: string): Promise<{ ok: boolean; reason?: string }>;
  deleteTask?(
    taskId: string
  ): Promise<{
    ok: boolean;
    reason?: string;
    queueId?: string;
    taskId?: string;
    priorStatus?: string;
    runId?: string | null;
    sessionCleaned?: boolean;
  }>;
  removeTaskPhase?(
    taskId: string,
    phaseId: string
  ): Promise<{ ok: boolean; reason?: string; priorPhaseState?: string; runId?: string }>;
  setPhaseBreakpoint?(
    runId: string,
    phaseId: string
  ): Promise<{ ok: boolean; reason?: string }>;
  clearPhaseBreakpoint?(
    runId: string,
    phaseId: string
  ): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * One Workflow → Pipeline reference the removal gate must not break (FR-022a,
 * 083 FR-041). Two senses of "Workflow" reach this type and the discriminant
 * keeps them apart: a queued run request waiting on a Pipeline, and a stored
 * Workflow *definition* whose node names one.
 *
 * A union rather than one shape with an optional `scope`, because the two
 * senses differ in exactly that field: a definition reference must name the
 * layer that blocked (the same identifier may exist in more than one scope,
 * FR-041), and a queued request has no layer at all. Narrowing on `kind`
 * yields `scope` without a fallback for a state that cannot occur.
 *
 * Host-internal: never persisted, never sent over IPC.
 */
export interface WorkflowRunRequestPipelineReference {
  readonly kind: 'run-request';
  readonly workflowId: string;
  readonly pipelineId: string;
}

export interface WorkflowDefinitionPipelineReference {
  readonly kind: 'workflow-definition';
  readonly workflowId: string;
  readonly pipelineId: string;
  /** The layer that holds the referencing record — the one worth editing. */
  readonly scope: WorkflowDefinitionScope;
}

export type WorkflowPipelineReference =
  | WorkflowRunRequestPipelineReference
  | WorkflowDefinitionPipelineReference;

/**
 * Feature 088 (T036, T037) — the connected-run store, as the two connected-run
 * commands need it: one read, one compare-and-set write, and one oracle for the
 * state of a child Pipeline Run.
 *
 * `readChildState` is a single reader rather than a pair, even though the launcher
 * wants a settled/not-settled boolean and the projector wants a state. Two ports
 * would be two answers to one question, and the FR-044 gate and the action set the
 * view renders would drift apart the first time one of them changed; the boolean is
 * derived from the state at the call site instead.
 */
export interface ConnectedRunPort {
  get(connectedRunId: string): ConnectedWorkflowRun | null;
  compareAndSetConnectedRun(
    next: ConnectedWorkflowRun,
    expectedRevision: number
  ): Promise<ConnectedRunWriteResult>;
  readChildState: ChildRunStateReader;
}

export interface RouterDeps {
  readonly executeCommand: <T = unknown>(commandId: string, ...args: unknown[]) => Thenable<T> | Promise<T>;
  readonly queueRemover: QueueRemover;
  readonly queueOps?: QueueOps;
  readonly phaseOps?: PhaseOps;
  readonly isPrimary?: () => boolean;
  /**
   * Reports whether the current workspace is trusted (VS Code Workspace Trust).
   * When the callback returns `false`, mutating commands are rejected before
   * any handler runs — closes the gap where an operator who opens a malicious
   * untrusted workspace could still trigger writes to `schegent.*` settings
   * (e.g. `CMD_SAVE_PHASES` to inject a hostile custom prompt). Read-only
   * commands (snapshot reads, phase-log reads) are unaffected.
   *
   * Optional for the same reason as `isPrimary`: absent in unit tests, the
   * gate defaults to trusted.
   */
  readonly isTrusted?: () => boolean;
  readonly notifyWarning?: (message: string) => void;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn' | 'error' | 'debug' | 'sanitize'>;
  readonly audit?: {
    append(entry: {
      runId: string;
      phase: string;
      iteration: number;
      eventType: AuditEventType;
      payload: Record<string, unknown>;
      outcome: 'info' | 'success' | 'failure';
      correlationId?: string;
    }): Promise<unknown>;
  };
  readonly updateConfig?: (
    key: 'phases' | 'pipelines' | 'models' | 'workflows',
    value: unknown,
    scope?: WritablePhaseDefinitionScope
  ) => Promise<void>;
  readonly readPhaseConfig?: () => {
    readonly user: readonly unknown[];
    readonly workspace: readonly unknown[];
  };
  readonly readPipelineConfig?: () => {
    readonly user: readonly unknown[];
    readonly workspace: readonly unknown[];
  };
  /** Feature 083 — the two writable Workflow layers, read fresh on every save. */
  readonly readWorkflowConfig?: () => {
    readonly user: readonly unknown[];
    readonly workspace: readonly unknown[];
  };
  readonly getCatalog?: () => PipelineCatalog;
  /**
   * Feature 087 (T044, US3, plan D3) — the one seam `CMD_LAUNCH_PIPELINE`
   * submits through: the `GuardedRunService` itself, narrowed to the single
   * method the handler calls. A composed run therefore passes every foreign-lock,
   * pause, and horizon guard the pre-existing start paths pass, and the
   * `no-direct-run-start` allowlist does not grow.
   *
   * Deliberately NOT routed through `executeCommand('schegent.enqueue', …)` the
   * way `cmd-start.ts` reaches the same service. That command is registered with
   * VS Code and is therefore callable by any other extension in the window;
   * carrying a `FrozenRunPlan` on it would let a third party submit arbitrary
   * Phase instructions, runner, and model without the catalog being consulted at
   * all. Keeping the composed path host-internal keeps that surface where it is.
   *
   * Optional so unit tests that do not exercise this command can omit it.
   */
  readonly guardedRun?: {
    scheduleOrEnqueue(request: GuardedScheduleRequest): Promise<GuardedScheduleResult>;
  };
  /**
   * Feature 087 (FR-030) — the effective global backend, as the run factory and
   * the runner already receive it. The composed run freezes its Phase snapshot
   * here rather than at drain, so the default a Phase inherits when it names no
   * runner has to be the same value those two see; taking `DEFAULT_BACKEND`
   * instead would make a composed run diverge from every other run the moment an
   * operator configures a different backend (FR-037).
   */
  readonly defaultRunnerKind?: BackendRunnerKind;
  /**
   * Feature 087 (FR-028) — the outputs a completed Run recorded, for a
   * supplemental `prior-output` reference.
   *
   * Optional, and a host that supplies none answers `prior-run-not-found` —
   * which is also the honest answer today. `run-output-resolver.ts` shipped
   * with 087 T063 and resolves correctly in isolation, but nothing calls it at
   * run completion, so no Run has ever written `runOutputs`. Feature 089
   * records that as its one coverage gap (`FR-R2-007-S06`); until the
   * completion path invokes the resolver, supplying this seam would only hand
   * back an always-empty list. Wiring is one line here once a Run writes them;
   * nothing in the handler changes.
   */
  readonly readPriorRunOutputs?: (runId: string) => readonly RunOutputRecord[] | null;
  /**
   * Feature 082 (US7, FR-022a) — the only data source behind
   * `consumingWorkflowIdsReferencing(...)` in `cmd-save-pipelines.ts`, which
   * decides whether removing a Pipeline source would leave a consuming
   * Workflow's reference unresolved.
   *
   * "Consuming Workflow" is not a persisted catalog entity in this slice, so
   * the host supplies the references it can see today: queued Workflow
   * requests that pin a `pipelineId` and have not yet frozen a Pipeline
   * contract. An in-flight or finished Run already froze its contract
   * (FR-027) and is therefore never a consumer. A future Workflow catalog
   * supplies the same pairs through this same hook; the save algebra above it
   * does not change (research R5).
   *
   * Optional: a host that exposes no Workflow references reports none, which
   * is the same answer as an empty queue.
   */
  readonly readWorkflowPipelineRefs?: () => readonly WorkflowPipelineReference[];
  /**
   * Feature 088 — the connected-run store behind `CMD_LAUNCH_WORKFLOW` and
   * `CMD_CONTINUE_WORKFLOW`. Optional like every other port here; a host that
   * supplies none refuses both commands as `queue-refused`, which is the same
   * answer `startPipelineRun` already gives when `guardedRun` is absent.
   */
  readonly connectedRuns?: ConnectedRunPort;
  readonly writeGeneralSettings?: (
    updates: Readonly<Record<string, unknown>>
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Feature 063 — `CMD_SET_CONFIRM_SUPPRESSION` handler hook. Persists
   * the per-action "Don't ask again" preference to the
   * `schegent.ui.confirmSuppression` memento. The handler validates the
   * action key against the closed `KNOWN_ACTION_KEYS` set before
   * invoking this; an unknown key is rejected without a memento touch.
   * Optional so unit tests that do not exercise this command can omit
   * the wiring.
   */
  readonly setConfirmSuppression?: (
    actionKey: string,
    suppressed: boolean
  ) => Promise<void>;
  /**
   * Feature 065 (T054a / FR-020) — `CMD_DISMISS_MIGRATION_NOTICE` handler
   * hook. Flips the persisted queue state's `migrationNotice` field from
   * `'pending'` to `'dismissed'` via a single persisted-state write.
   * MUST NOT touch `scheduledStartSource` on any queue record (those
   * clear only on the operator's next explicit start, per FR-020).
   * Optional so unit tests that do not exercise this command can omit
   * the wiring.
   */
  readonly dismissMigrationNotice?: () => Promise<void>;
  readonly phaseLogService?: {
    read(req: ReadPhaseLogRequest): Promise<ReadPhaseLogResponse>;
  };
  readonly phaseLogTailService?: {
    start(req: StartPhaseLogTailRequest): Promise<StartPhaseLogTailResponse>;
    stop(req: StopPhaseLogTailRequest): Promise<StopPhaseLogTailResponse>;
  };
  /**
   * Feature 084 (FR-018, FR-019, research R3) — hands a serialized document to
   * the host's own save flow. This directory is vscode-free, so the dialog and
   * the write live in an adapter wired in `src/extension.ts`.
   *
   * `suggestedFileName` is a bare name the dialog seeds its field with, never a
   * location; the adapter decides where to anchor it and never reports back
   * where the operator put it. `'unavailable'` is not in the return type
   * because resolving the resource is the handler's job, not the adapter's.
   */
  readonly saveProcessYamlDocument?: (request: {
    readonly suggestedFileName: string;
    readonly text: string;
  }) => Promise<Exclude<ExportProcessYamlResult, { readonly outcome: 'unavailable' }>>;
  /**
   * Feature 084 (FR-020, FR-020a, research R3) — the mirror of
   * `saveProcessYamlDocument` for import preflight. The host opens its own open
   * dialog and does its own read, so no location is supplied by the webview and
   * none is returned to it.
   *
   * Returns BYTES, not text: the decode is the parser's job, because "not valid
   * UTF-8" and "has a byte-order mark" are refusals this format states rather
   * than repairs (FR-004). Reads the chosen file exactly once and retains
   * nothing — no lock, no watch, no copy (FR-031, FR-045).
   */
  readonly openProcessYamlDocument?: () => Promise<
    | { readonly outcome: 'read'; readonly bytes: Uint8Array }
    | { readonly outcome: 'canceled' }
    | { readonly outcome: 'failed'; readonly message: string }
  >;
  readonly metricsService?: {
    read(req: ReadMetricsRequest): Promise<ReadMetricsResponse>;
  };
  readonly backendPingService?: Pick<BackendPingService, 'ping'>;
  /**
   * Feature 073 — existing session-scoped correlation id reused (not newly
   * minted) for the `metrics-view-opened` audit payload
   * (contracts/metrics-view-opened-event.md). Sourced from the same
   * `ownerId` already computed once at extension activation.
   */
  readonly sessionId?: string;
  /**
   * Feature 073 — tracks whether `metrics-view-opened` has already been
   * appended this session (first CMD_READ_METRICS dispatch only).
   * Constructed once in wireStage2() alongside sessionId so its lifetime
   * matches "session" per contracts/metrics-view-opened-event.md.
   */
  readonly metricsViewOpenedState?: { emitted: boolean };
}

export type AckPoster = (msg: CommandAckMessage) => Thenable<boolean> | Promise<boolean>;
