export const SCHEMA_VERSION = 4 as const;

export type BackendRunnerKind = 'claude' | 'codex' | 'agy';
export type BackendPingFailureCause =
  | 'not-found'
  | 'not-executable'
  | 'non-zero-exit'
  | 'timed-out'
  | 'already-in-progress'
  | 'unknown';
export type BackendPingState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly timeoutSeconds: number }
  | { readonly status: 'success'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly completedAt: number; readonly latencyMs: number; readonly timeoutSeconds: number }
  | { readonly status: 'failure'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly completedAt: number; readonly latencyMs: number; readonly timeoutSeconds: number; readonly cause: BackendPingFailureCause; readonly exitCode?: number };

export const BUILT_IN_PHASE_NAMES = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-analyze',
  'speckit-implement',
  'finalize'
] as const;

export const PHASE_NAMES = BUILT_IN_PHASE_NAMES;

export type BuiltInPhaseName = (typeof BUILT_IN_PHASE_NAMES)[number];

export type PhaseName = string;

export type PhaseState = 'not-started' | 'active' | 'completed' | 'skipped' | 'disabled';

export type PhaseResultState =
  | 'clean'
  | 'ambiguities-remain'
  | 'issues-remain'
  | 'failed'
  | 'timed-out';

export type WorkflowStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type QueueItemStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

export type AuditCategory =
  | 'phase-transition'
  | 'file-write'
  | 'cli-invocation'
  | 'error'
  | 'warning'
  | 'system';

/** Debug log entry projected from the host's WebviewLogSink ring buffer. */
export interface DebugLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly message: string;
}

export type FreshnessState = 'live' | 'slowing' | 'stalled' | 'paused' | 'idle';

export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'paused';

export interface SubProgress {
  readonly current: number;
  readonly total: number;
  readonly label: 'task' | 'iteration';
}

export interface PhaseTile {
  readonly name: PhaseName;
  readonly order: number;
  readonly state: PhaseState;
  readonly iteration: number;
  readonly lastResult: PhaseResultState | null;
  readonly elapsedMs: number;
  readonly subProgress: SubProgress | null;
  /**
   * Feature 061 — operator-configured display name from `PhaseDef.name`.
   * Purely cosmetic; MUST NOT be used as a lookup key. When undefined or
   * empty, consumers fall back to `formatPhaseLabel(tile.name)`.
   */
  readonly displayName?: string;
  readonly isRequired?: boolean;
  readonly phaseMessage?: {
    readonly fromPhaseId: string;
    readonly entryCount: number;
    readonly byteSize: number;
    readonly truncated: boolean;
    readonly invalidReason: string | null;
  } | null;
  /**
   * Feature 010 (FR-028) — operator-visible projection of the most recent
   * retryCondition evaluation's missing keys.
   */
  readonly lastRetryDecision?: {
    readonly missingKeys: readonly string[];
  };
}

export interface ActiveFeatureSummary {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
}

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
  readonly queueId?: string;
  readonly position: number;
  readonly pauseCause?:
    | 'queue-paused'
    | 'phase-paused'
    | 'manually-paused-task'
    | 'breakpoint'
    | null;
  /** Feature 020 — pipeline id under which the task is/was running. */
  readonly currentPipelineId?: string | null;
  /**
   * BUG-006 (063) — Activity Feed cold-start fallback predicate. `true`
   * when the task has entered the phase machinery at least once and may
   * have audit-log iterations on disk. Optional for back-compat with
   * snapshots emitted before the field landed.
   */
  readonly hasOnDiskLogs?: boolean;
  /**
   * Feature 065 / BUG-006 — paused-row enrichment for the webview. Present
   * only on tasks with `status === 'paused'`. Drives the QueueItem badge
   * (operator-paused vs. system-paused/rate-limit) and the auto-resume
   * countdown. `resetsAtMs` carries the resolved restoration target.
   */
  readonly paused?: {
    readonly pauseSource: 'operator-paused' | 'system-paused';
    readonly pauseCauseCategory?: 'rate-limit' | 'fatal-signature' | 'operator-canceled';
    readonly resetsAtMs?: number;
  };
}

export interface QueueSummary {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly state: 'active' | 'manually-paused';
  /**
   * Feature 028 — `'cascade'` when the queue was paused as a side effect
   * of a phase pause (or breakpoint fire); `'operator'` when the operator
   * paused the queue directly; `null` when the queue is active.
   */
  readonly pauseSource: 'operator' | 'cascade' | null;
  readonly schedule: {
    readonly expression: string;
    readonly kind: 'relative' | 'absolute';
    readonly targetAt: string;
  } | null;
  readonly taskCount: number;
}

// Feature 065 — webview mirror of the host `QueueLifecycle` / `ScheduledStartSource`
// literals. Kept in sync with repo/src/queue/feature-request.ts.
export type QueueLifecycle =
  | 'running'
  | 'operator-paused'
  | 'idle-pending'
  | 'active-empty';

export type ScheduledStartSource =
  | 'operator-chooser'
  | 'operator-restart'
  | 'programmatic-now'
  | 'programmatic-scheduled'
  | 'migration-default'
  | 'system-rate-limit-recovery';

export interface QueueProjection {
  readonly inFlight: QueueItem | null;
  readonly pending: readonly QueueItem[];
  readonly recent: readonly QueueItem[];
  /**
   * Feature 065 / BUG-009 (FR-029) — flattened single-source-of-truth row
   * order for queue-surface rendering. Contains every `FeatureRequest`
   * from `QueueState.requests` regardless of status (pending, in-flight,
   * paused, completed, canceled, failed). The legacy `inFlight`/`pending`/
   * `recent` bucket fields remain populated for backward compatibility,
   * but new code MUST consume `orderedItems` and treat the buckets as
   * derived/legacy.
   */
  readonly orderedItems: readonly QueueItem[];
  readonly queues?: readonly QueueSummary[];
  readonly paused: boolean;
  readonly pausedReason?: string | null;
  // Feature 065 — additive lifecycle / scheduled-start projection.
  readonly lifecycle?: QueueLifecycle;
  readonly scheduledStartAt?: number | null;
  readonly scheduledStartSource?: ScheduledStartSource | null;
  // Feature 065 (T054a / FR-020) — one-time post-migration operator notice.
  readonly migrationNotice?: 'pending' | 'dismissed';
}

export interface AuditTailEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly phase: PhaseName | null;
  readonly category: AuditCategory;
  readonly summary: string;
  // --- Feature 064 additive fields ---
  readonly runId: string;
  readonly scope: 'task' | 'system';
  // --- Feature 068 additive fields ---
  readonly taskId?: string;
  readonly phaseId?: string;
  readonly outcome?: 'success' | 'error' | 'pending';
  readonly runner?: string;
}

export interface LiveActivity {
  readonly summary: string | null;
  readonly category: AuditCategory | null;
  readonly lastEventAt: string | null;
  readonly freshness: FreshnessState;
  readonly staleSeconds: number | null;
}

export interface CliMonitorState {
  readonly runId: string;
  readonly phase: PhaseName;
  readonly status: MonitorStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly lastStdoutAt: string | null;
  readonly lastStderrAt: string | null;
  readonly lastProgressAt: string | null;
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  readonly msSinceLastStdout: number | null;
  readonly msSinceLastStderr: number | null;
}

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
}

export interface ActivePipelineSummary {
  readonly id: string;
  readonly name: string;
}

/**
 * Feature 087 (FR-040, FR-040a, FR-042) — one declared output of a completed
 * Run, mirroring the host's `contracts/run-results.ts`.
 *
 * `reference` is a workspace-relative **location**; artifact content never
 * enters the snapshot. An `unresolved` entry has no reference and is shown
 * beside the resolved ones rather than hidden.
 */
export interface RunOutputRecord {
  readonly name: string;
  readonly status: 'resolved' | 'unresolved';
  readonly reference?: string;
}

/**
 * Feature 088 (FR-055, FR-055a, FR-057, FR-058) — the connected-run read model,
 * mirroring the host's `contracts/sidebar-ipc/workflow-run.ts`.
 *
 * Derived on read and never stored: the first four node states are readings of
 * the node's most recent child run, and the last three are a fold over the
 * recorded routing decisions. `actions` is what the host would accept at this
 * `revision` — the view renders controls from it rather than inferring them, so
 * a stale view offers nothing the host would refuse (FR-057).
 *
 * `in-flight` is the vocabulary of this family deliberately: the pinned
 * `'running'` status literal belongs to the per-task projection paths and this
 * feature does not widen that allowlist.
 */
export type ConnectedNodeState =
  | 'completed'
  | 'in-flight'
  | 'failed'
  | 'canceled'
  | 'available'
  | 'blocked'
  | 'unvisited';

export type ConnectedNodeAction = 'start' | 'restart';

export interface ConnectedNodeProjection {
  readonly nodeId: string;
  readonly pipelineId: string;
  readonly state: ConnectedNodeState;
  readonly actions: readonly ConnectedNodeAction[];
  readonly attemptCount: number;
  /** The most recent attempt's queue item, so the existing Run surfaces can be reused (FR-056). */
  readonly latestQueueItemId?: string;
}

export interface ConnectedRunProjection {
  readonly connectedRunId: string;
  readonly workflowId: string;
  /** The compare-and-set token to echo back on the next continuation (FR-046). */
  readonly revision: number;
  /** True until the aggregate and every referenced child run have loaded (FR-058). */
  readonly hydrating: boolean;
  readonly nodes: readonly ConnectedNodeProjection[];
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface PhaseDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
}

export interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
  /**
   * Feature 082 — contract fields carried by the runtime selection list. Every
   * one is optional so a pre-082 snapshot deserializes unchanged.
   */
  readonly description?: string;
  readonly version?: number;
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
  readonly sourceScope?: PipelineDefinitionScope;
}

/**
 * Feature 026 — projected layer per (phaseId, fieldKey) tuple for
 * the merged phase catalog. Composite key shape:
 * `"<phaseId>::<fieldKey>"`. The webview consumes only `model` and
 * `effort` today; the remaining tunable keys (`timeoutSeconds`,
 * `loopable`, `retryCondition`) are forward-compatible reservations.
 * Never persisted; UI-only.
 */
export type PhasePrecedenceLayer = 'built-in' | 'user' | 'workspace' | 'unset';

export type PhasePrecedenceProjection = Readonly<Record<string, PhasePrecedenceLayer>>;

export type PhaseDefinitionScope = 'built-in' | 'user' | 'workspace';
export type WritablePhaseDefinitionScope = Exclude<PhaseDefinitionScope, 'built-in'>;
export type PhaseSourceStatus = 'effective' | 'shadowed' | 'invalid';

export interface PortablePhaseDefinition {
  readonly phaseId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
}

export interface PhaseCatalogSourceRecord {
  readonly key: string;
  readonly phaseId: string;
  readonly scope: PhaseDefinitionScope;
  readonly status: PhaseSourceStatus;
  readonly definition: PortablePhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly modelAvailable?: boolean;
}

export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceRecord[];
  readonly effective: readonly PortablePhaseDefinition[];
  readonly revisions: Readonly<Record<WritablePhaseDefinitionScope, string>>;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/*
 * Feature 082 — webview mirror of the portable Pipeline contract in
 * `src/contracts/pipeline-definitions.ts`. Types and closed unions only; the
 * host remains the sole authority for validation and resolution.
 */

export type PipelineDefinitionScope = 'built-in' | 'user' | 'workspace';
export type WritablePipelineDefinitionScope = Exclude<PipelineDefinitionScope, 'built-in'>;
export type PipelineSourceStatus = 'effective' | 'shadowed' | 'invalid';

/**
 * Session-input port types (FR-012). `pipeline-output` is the declared type an
 * input port uses when an earlier Phase's output feeds it rather than the
 * operator at session start.
 */
export const PIPELINE_INPUT_PORT_TYPES = [
  'text',
  'source',
  'source-list',
  'local-file',
  'local-folder',
  'web-url',
  'pipeline-output',
  'repository-context'
] as const;
export type PipelineInputPortType = (typeof PIPELINE_INPUT_PORT_TYPES)[number];

/** Declared artifact types a Pipeline produces (FR-013). */
export const PIPELINE_OUTPUT_PORT_TYPES = [
  'markdown',
  'file',
  'file-set',
  'structured-data',
  'run-request',
  'external-reference'
] as const;
export type PipelineOutputPortType = (typeof PIPELINE_OUTPUT_PORT_TYPES)[number];

export interface PipelineInputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType;
  readonly required?: boolean;
  readonly description?: string;
}

export interface PipelineOutputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineOutputPortType;
  readonly description?: string;
}

/**
 * Bindings address a Phase *position* rather than a bare phase id because a
 * Pipeline's `phaseIds` may repeat the same Phase.
 */
export interface PhaseInputBinding {
  readonly kind: 'input';
  readonly phaseIndex: number;
  readonly inputKey: string;
  readonly source:
    | { readonly from: 'pipeline-input'; readonly portId: string }
    | { readonly from: 'phase-output'; readonly phaseIndex: number; readonly portId: string };
}

export interface PhaseOutputBinding {
  readonly kind: 'output';
  readonly phaseIndex: number;
  readonly portId: string;
  readonly outputKey: string;
}

export type PhaseBinding = PhaseInputBinding | PhaseOutputBinding;

/** Advisory Run-creation defaults; host-owned runtime policy is not authorable. */
export interface PipelineExecutionDefaults {
  readonly runner?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
}

export interface PortablePipelineDefinition {
  readonly pipelineId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly phaseIds: readonly string[];
  readonly inputs: readonly PipelineInputPort[];
  readonly outputs: readonly PipelineOutputPort[];
  readonly bindings: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext: readonly string[];
}

export type PipelineCatalogMutation =
  | { readonly kind: 'create'; readonly pipelineId: string }
  /**
   * Feature 085 (FR-043) — the Pipeline half of a package import, written after
   * the Phase layer (FR-038) and gated on its own expected revision. Mirrors
   * `SavePhasesMutation['import-package']`.
   */
  | { readonly kind: 'import-package'; readonly pipelineIds: readonly string[] }
  | { readonly kind: 'edit'; readonly pipelineId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourceScope: PipelineDefinitionScope;
      readonly sourcePipelineId: string;
      readonly pipelineId: string;
    }
  | { readonly kind: 'remove'; readonly pipelineId: string }
  | { readonly kind: 'reset' };

export interface PipelineCatalogSourceRecord {
  readonly key: string;
  readonly pipelineId: string;
  readonly scope: PipelineDefinitionScope;
  readonly status: PipelineSourceStatus;
  readonly definition: PortablePipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly modelAvailable?: boolean;
  /**
   * FR-002 — Workflows that still resolve this `pipelineId` from the catalog.
   * Absent on a host that exposes no Workflow references; the editor renders an
   * empty list rather than asserting there are none.
   */
  readonly consumingWorkflowIds?: readonly string[];
}

export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceRecord[];
  readonly effective: readonly PortablePipelineDefinition[];
  readonly revisions: Readonly<Record<WritablePipelineDefinitionScope, string>>;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/*
 * Feature 083 — webview mirror of the portable Workflow contract in
 * `src/contracts/workflow-definitions.ts` and the projection in
 * contracts/workflow-catalog-snapshot.md. Types and closed unions only; the
 * host remains the sole authority for validation and resolution.
 *
 * "Workflow" here is the *definition* sense — a reusable acyclic graph of
 * Pipeline nodes. The run-side sense (`WorkflowSnapshot`, `workflowId` on a
 * queued request) keeps every surface it already owns in this file; neither
 * vocabulary is renamed.
 */

export type WorkflowDefinitionScope = 'built-in' | 'user' | 'workspace';
export type WritableWorkflowDefinitionScope = Exclude<WorkflowDefinitionScope, 'built-in'>;
export type WorkflowSourceStatus = 'effective' | 'shadowed' | 'invalid';

/** Collection selection rules; `exactlyOne` fails at run time on any size but one. */
export const WORKFLOW_SELECTION_RULES = ['first', 'last', 'exactlyOne'] as const;
export type WorkflowSelectionRule = (typeof WORKFLOW_SELECTION_RULES)[number];

/**
 * Closed comparison operator set. Adding a member is a contract change, not a
 * configuration change — there is no operator registry and no way for an
 * authored definition to introduce one.
 */
export const WORKFLOW_CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'exists',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
] as const;
export type WorkflowConditionOperator = (typeof WORKFLOW_CONDITION_OPERATORS)[number];

/** Terminal run statuses a `node-status` operand may be compared against. */
export const WORKFLOW_NODE_TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;
export type WorkflowNodeTerminalStatus = (typeof WORKFLOW_NODE_TERMINAL_STATUSES)[number];

/**
 * A condition is structured data, never an expression string. The Builder edits
 * these fields directly; there is no text to compile, evaluate, or sandbox.
 */
export type WorkflowConditionOperand =
  | { readonly source: 'node-output'; readonly nodeId: string; readonly field: string }
  | { readonly source: 'node-status'; readonly nodeId: string };

export type WorkflowConditionLiteral = string | number | boolean;

export interface WorkflowCondition {
  readonly left: WorkflowConditionOperand;
  readonly operator: WorkflowConditionOperator;
  readonly right?: WorkflowConditionLiteral | readonly WorkflowConditionLiteral[];
}

/**
 * `nodeId` is the address, not `pipelineId`: two nodes may reference the same
 * Pipeline and are distinguished solely by `nodeId`. Reorder, insert, and remove
 * preserve every surviving `nodeId`, so no connection endpoint needs remapping —
 * deliberately unlike Pipeline bindings, which address a Phase by position.
 */
export interface WorkflowNode {
  readonly nodeId: string;
  readonly pipelineId: string;
  readonly label?: string;
}

/**
 * A connection carries no identifier of its own: defects address it by position
 * in the authored list (`connections[2].to`), while its endpoints address nodes
 * by `nodeId`. It carries no fan-out marker either — several outgoing
 * connections on one node are mutually exclusive alternatives.
 */
export interface WorkflowConnection {
  readonly from: { readonly nodeId: string; readonly portId: string };
  readonly to: { readonly nodeId: string; readonly portId: string };
  readonly condition?: WorkflowCondition;
  /** Integer; ascending evaluation order, then authored order for ties. */
  readonly priority?: number;
  /** At most one per source node; considered last. */
  readonly isDefault?: boolean;
  readonly selection?: WorkflowSelectionRule;
}

export interface PortableWorkflowDefinition {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  /** Authored order preserved; carries no execution semantics. */
  readonly nodes: readonly WorkflowNode[];
  /** Authored order preserved; the equal-priority tie-break only. */
  readonly connections: readonly WorkflowConnection[];
  /** Non-empty; every entry names an existing node. */
  readonly startNodeIds: readonly string[];
}

export type WorkflowCatalogMutation =
  | { readonly kind: 'create'; readonly workflowId: string }
  /**
   * Feature 086 (FR-045) — the Workflow half of a package import, written last
   * because its nodes only resolve once the Pipelines they name are effective,
   * and gated on its own expected revision. Mirrors
   * `PipelineCatalogMutation['import-package']`. There is no single-id `import`
   * kind to mirror: the Workflow catalog has no standalone import form, so every
   * Workflow import is a package write, even one carrying a single Workflow.
   */
  | { readonly kind: 'import-package'; readonly workflowIds: readonly string[] }
  | { readonly kind: 'edit'; readonly workflowId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourceScope: WorkflowDefinitionScope;
      readonly sourceWorkflowId: string;
      readonly workflowId: string;
    }
  | { readonly kind: 'remove'; readonly workflowId: string }
  | { readonly kind: 'reset' };

/** `field` is wider than the Pipeline cap so it can hold `connections[12].to`. */
export interface WorkflowCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Derived at projection time and absent from the persisted row: a Workflow's
 * inputs are the node input ports no connection binds, and its outputs are the
 * node output ports no connection consumes.
 */
export interface WorkflowCatalogPortProjection {
  readonly nodeId: string;
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType | PipelineOutputPortType;
}

export interface WorkflowCatalogSourceProjection {
  readonly key: string;
  readonly workflowId: string;
  readonly scope: WorkflowDefinitionScope;
  readonly status: WorkflowSourceStatus;
  readonly definition: PortableWorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowCatalogFieldErrorProjection[];
  readonly derivedInputs: readonly WorkflowCatalogPortProjection[];
  readonly derivedOutputs: readonly WorkflowCatalogPortProjection[];
}

export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly PortableWorkflowDefinition[];
  readonly revisions: Readonly<Record<WritableWorkflowDefinitionScope, string>>;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Feature 011 — webview mirror of `DelayedRetryState` in
 * src/ui/sidebar/snapshot.ts. The host always emits this object (even
 * idle); the field is marked optional here for legacy-tolerance per
 * contracts/general-settings-ipc.md — a host running an older bundle
 * will not include it, and the webview must fall back to the IDLE
 * defaults.
 */
export type DelayedRetryCauseProjection = 'transient_error' | 'rate_limit' | null;

export interface DelayedRetryState {
  readonly pendingRetryAt: string | null;
  readonly pendingRetryCause: DelayedRetryCauseProjection;
  readonly delayedRetryCount: number;
}

export const IDLE_DELAYED_RETRY: DelayedRetryState = Object.freeze({
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0
});

/**
 * Feature 011 — webview mirror of `GeneralSettings` in
 * src/config/general-settings.ts. Each scalar `schegent.*` key is
 * surfaced as a typed field; the `scopes` map indicates the source
 * (workspace > user > default). The Settings surface reads this and
 * dispatches CMD_SAVE_GENERAL_SETTINGS to persist edits.
 */
export type SettingScope = 'workspace' | 'user' | 'default';

/**
 * Feature 019 — runtime debug log severity floor. Mirrors
 * `RuntimeLogLevel` in src/lib/runtime-log/runtime-log-level.ts; kept as
 * a local union here because the webview bundle cannot import from the
 * host `src/lib/` tree.
 */
export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface GeneralSettings {
  readonly cliPath: string;
  readonly loggingVerbose: boolean;
  readonly loopMaxIterations: number;
  readonly invocationTimeoutSeconds: number;
  readonly watchdogPollIntervalMinutes: number;
  readonly auditRotationSizeMB: number;
  readonly auditRotationMaxAgeDays: number;
  readonly defaultPipelineId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly queueGlobalConcurrencyCap: number;
  readonly queueDefaultQueueId: string;
  readonly runtimeLogLevel: RuntimeLogLevel;
  readonly runtimeLogFilePath: string;
  readonly retryMaxAttempts: number;
  readonly codexPath: string;
  readonly agyPath: string;
  readonly runtimeLogMaxBytes: number;
  readonly runtimeLogMaxGenerations: number;
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
  readonly rawTranscriptMode: 'always' | 'errors-only' | 'off';
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationTimeoutSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly defaultPipelineId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly queueGlobalConcurrencyCap: SettingScope;
    readonly queueDefaultQueueId: SettingScope;
    readonly runtimeLogLevel: SettingScope;
    readonly runtimeLogFilePath: SettingScope;
    readonly retryMaxAttempts: SettingScope;
    readonly codexPath: SettingScope;
    readonly agyPath: SettingScope;
    readonly runtimeLogMaxBytes: SettingScope;
    readonly runtimeLogMaxGenerations: SettingScope;
    readonly sessionRetentionMaxAgeDays: SettingScope;
    readonly sessionRetentionMaxBytes: SettingScope;
    readonly rawTranscriptMode: SettingScope;
  };
}

export const IDLE_GENERAL_SETTINGS: GeneralSettings = Object.freeze({
  cliPath: 'claude',
  codexPath: 'codex',
  agyPath: 'agy',
  loggingVerbose: false,
  loopMaxIterations: 10,
  invocationTimeoutSeconds: 1800,
  watchdogPollIntervalMinutes: 30,
  auditRotationSizeMB: 5,
  auditRotationMaxAgeDays: 30,
  // Feature 056 Track 3 (FR-013) — host default and package
  // contribution default both point at the built-in
  // `speckit-new-feature` pipeline; the webview idle snapshot must
  // agree so a fresh workspace shows a consistent value before the
  // first projection lands.
  defaultPipelineId: 'speckit-new-feature',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  // Feature 094 (T032, FR-017) — must equal the manifest's contributed
  // `default` for `schegent.queue.globalConcurrencyCap`, which this object
  // mirrors until the first projection lands. It stayed at the pre-092 value
  // of 1 after the manifest moved to 3;
  // `tests/parity/settings-defaults-parity.test.ts` now derives the expected
  // value from the manifest instead of restating it, so a future raise cannot
  // leave this behind without failing.
  queueGlobalConcurrencyCap: 3,
  queueDefaultQueueId: 'default',
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  retryMaxAttempts: 5,
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  rawTranscriptMode: 'always',
  sessionRetentionMaxBytes: 512 * 1024 * 1024,
  scopes: Object.freeze({
    cliPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationTimeoutSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultPipelineId: 'default',
    fatalSignatures: 'default',
    claudeAutoCompactPctOverride: 'default',
    queueGlobalConcurrencyCap: 'default',
    queueDefaultQueueId: 'default',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    retryMaxAttempts: 'default',
    codexPath: 'default',
    agyPath: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default',
    rawTranscriptMode: 'default'
  })
});


/**
 * Feature 033 — webview mirror of `TelemetryStatus` /
 * `TelemetrySnapshot` in src/telemetry/telemetry-snapshot.ts. Kept as a
 * local definition here because the webview bundle cannot import host
 * source. The shape is closed and matches the host emit exactly.
 */
export type TelemetryStatus =
  | 'active'
  | 'sleeping'
  | 'zombie'
  | 'exited'
  | 'killed'
  | 'unavailable';

export interface TelemetrySnapshot {
  readonly pid: number;
  readonly status: TelemetryStatus;
  readonly cpuPercent: number | null;
  readonly memoryRssBytes: number | null;
  readonly uptimeMs: number | null;
  readonly sampledAt: string;
}

/**
 * Feature 092 (FR-048, FR-049) — the Run one queue owns, folded under that
 * queue. Every field here was a top-level singular in v3; the fold is what
 * makes "whose Run is this" unambiguous once more than one can be in flight.
 */
export interface InFlightRunProjection {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly feature: ActiveFeatureSummary | null;
  /** Null on the built-in `standard` pipeline, matching the v3 `activePipeline` omission. */
  readonly pipeline: ActivePipelineSummary | null;
  readonly elapsedMs: number | null;
  readonly liveActivity: LiveActivity;
  readonly delayedRetry: DelayedRetryState;
  readonly resumeTargetPhaseId: string | null;
  readonly outputs: readonly RunOutputRecord[];
}

/**
 * Feature 092 (FR-048, FR-053) — one entry per registered queue, in position
 * order. A queue that owns no Run publishes `inFlightRun: null` with every
 * run-derived list empty; it never borrows another queue's Run.
 */
export interface QueueRuntime {
  readonly queueId: string;
  readonly name: string;
  readonly position: number;
  readonly lifecycle: QueueLifecycle;
  readonly inFlightRun: InFlightRunProjection | null;
  readonly phases: readonly PhaseTile[];
  readonly phaseOverrides: readonly {
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }[];
  readonly manualPause: {
    readonly at: string;
    readonly cause: 'operator-paused' | 'queue-paused-mid-run' | 'breakpoint-paused';
  } | null;
  readonly phaseBreakpoints: readonly {
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  }[];
  /** Pending Tasks on this queue, derived from its own rows — never a total. */
  readonly pendingCount: number;
  /**
   * Feature 092 (T108, FR-057) — this queue's own Task rows in position order,
   * active and historical alike; the Queue Detail tier lists them. Distinct from
   * `QueueProjection.orderedItems`, which is the default queue's rows and whose
   * indices are the global address space the reorder handler translates.
   */
  readonly tasks: readonly QueueItem[];
}

export interface WorkflowSnapshot {
  readonly schemaVersion: 4;
  readonly isPrimary: boolean;
  /**
   * Feature 092 (FR-048) — one runtime per registered queue. Replaces every
   * per-run singular the root carried in v3; those were deleted rather than
   * deprecated so a stale read fails to compile instead of silently reading
   * one queue's Run as the workspace's.
   */
  readonly queues: readonly QueueRuntime[];
  readonly queue: QueueProjection;
  /** Effective host default; absent only when paired with a legacy host. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly debugLogTail?: readonly DebugLogEntry[];
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly availablePipelines: readonly PipelineDefinition[];
  readonly availablePhases: readonly PhaseDefinition[];
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly backendPingState?: BackendPingState;
  /**
   * Feature 011 — typed read of every scalar `schegent.*` setting,
   * with the effective scope for each field. Optional for
   * legacy-tolerance: an older host bundle may not include it; the
   * webview must default to `IDLE_GENERAL_SETTINGS` in that case.
   */
  readonly generalSettings?: GeneralSettings;
  readonly sessionArtifacts?: SessionArtifactsProjection;
  readonly evidenceHealth?: EvidenceHealthProjection;
  /**
   * Feature 026 — per-phase precedence projection. Flat map keyed by
   * `"<phaseId>::<fieldKey>"` whose value is the layer that provided
   * the effective value (`'workspace' | 'user' | 'built-in' | 'unset'`).
   * Optional for legacy-tolerance and absent when the host has not
   * recomputed it yet.
   */
  readonly phasePrecedence?: PhasePrecedenceProjection;
  /** Feature 081 — absent means the authoritative catalog is still loading. */
  readonly phaseCatalog?: PhaseCatalogProjection;
  /**
   * Feature 082 — resolved Pipeline catalog for the Library and Builder.
   * Additive and optional: absent means the authoritative catalog is still
   * loading, and every mutating control stays disabled until it arrives
   * (FR-028). `availablePipelines` keeps its runtime-selection meaning.
   */
  readonly pipelineCatalog?: PipelineCatalogProjection;
  /**
   * Feature 083 — resolved Workflow catalog for the Workflow Library and Graph
   * Builder. Additive and optional on the same terms as `pipelineCatalog`:
   * absent means the authoritative catalog is still loading, and every mutating
   * control stays disabled until it arrives (FR-036).
   */
  readonly workflowCatalog?: WorkflowCatalogProjection;
  /**
   * Feature 088 — the connected runs the operator can act on, already folded to
   * per-node state, legal actions, and `hydrating` host-side. Additive and
   * optional: a host with no connected-run wiring omits it, so the view treats
   * absence as "none" rather than as an error.
   */
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  /**
   * Feature 059 — per-capability trust projection. Optional for legacy-
   * tolerance: an older host bundle may not include either field, in
   * which case the webview must fail closed (treat as `false`) per the
   * trust-projection contract's failure-mode rules.
   *
   * Contract:
   * `specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md`.
   */
  readonly workspaceTrust?: boolean;
  readonly resolvedTrust?: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
    readonly pipelineOverrides: boolean;
    /**
     * Feature 083 — gates non-default entries in the Workflow catalog. A
     * capability distinct from `pipelineOverrides`, projected separately so
     * the Builder cannot infer one from the other.
     */
    readonly workflowOverrides: boolean;
  };
  /**
   * Feature 033 — ephemeral per-subprocess telemetry sample. Never
   * persisted to WorkflowRun, never written to the audit log. The host
   * projection clears this to `null` one publish after the runner's
   * `exited` event. Optional for legacy-tolerance: an older host bundle
   * may not include it, and the webview must treat `undefined` the same
   * as `null` (no telemetry line rendered).
   */
  readonly telemetry?: TelemetrySnapshot | null;
  /**
   * Feature 063 (FR-021) — projected suppression set so the webview can
   * skip the modal when the operator opted out for a given action key.
   * Optional for legacy-tolerance: an older host bundle may not include
   * it, and the webview must treat `undefined` the same as "no
   * suppressions" (modal shown).
   */
  readonly confirmSuppression?: {
    readonly version: 1;
    readonly suppressedActionKeys: readonly string[];
  };

  /**
   * Feature 063 (FR-019, T030) — projected value of the
   * `schegent.ui.confirmations.enable` config flag. When `false`,
   * `useConfirm` short-circuits and destructive actions run without
   * opening the modal. Optional for legacy-tolerance: an older host
   * bundle may not include it, and the webview must treat `undefined`
   * the same as `true` (prompts on).
   */
  readonly confirmationsEnabled?: boolean;
}

export interface SessionArtifactsProjection {
  readonly artifactCount: number;
  readonly totalBytes: number;
  readonly lastSweepAt: string | null;
  readonly lastSweepFailures: number;
}

export type EvidenceSinkStatus = 'healthy' | 'degraded' | 'unavailable';
export type EvidenceOverallStatus = 'healthy' | 'degraded' | 'unavailable';
export type EvidenceContinuationPolicy = 'fail-closed' | 'continue-degraded';

export interface EvidenceSinkHealthProjection {
  readonly status: EvidenceSinkStatus;
  readonly continuationPolicy: EvidenceContinuationPolicy;
  readonly failureCount: number;
  readonly lastFailureAt: string | null;
  readonly cause: string | null;
}

export interface EvidenceHealthProjection {
  readonly overall: EvidenceOverallStatus;
  readonly audit: EvidenceSinkHealthProjection;
  readonly rawTranscript: EvidenceSinkHealthProjection;
  readonly runtimeLog: EvidenceSinkHealthProjection;
}

const HEALTHY_REQUIRED_EVIDENCE: EvidenceSinkHealthProjection = Object.freeze({
  status: 'healthy',
  continuationPolicy: 'fail-closed',
  failureCount: 0,
  lastFailureAt: null,
  cause: null
});

const HEALTHY_OPTIONAL_EVIDENCE: EvidenceSinkHealthProjection = Object.freeze({
  ...HEALTHY_REQUIRED_EVIDENCE,
  continuationPolicy: 'continue-degraded'
});

export const IDLE_EVIDENCE_HEALTH: EvidenceHealthProjection = Object.freeze({
  overall: 'healthy',
  audit: HEALTHY_REQUIRED_EVIDENCE,
  rawTranscript: HEALTHY_OPTIONAL_EVIDENCE,
  runtimeLog: HEALTHY_OPTIONAL_EVIDENCE
});

export const IDLE_SESSION_ARTIFACTS: SessionArtifactsProjection = Object.freeze({
  artifactCount: 0,
  totalBytes: 0,
  lastSweepAt: null,
  lastSweepFailures: 0
});

export const IDLE_LIVE_ACTIVITY: LiveActivity = Object.freeze({
  summary: null,
  category: null,
  lastEventAt: null,
  freshness: 'idle',
  staleSeconds: null
});

export function isRecursivePhase(name: PhaseName): boolean {
  return name === 'speckit-clarify' || name === 'speckit-analyze';
}
