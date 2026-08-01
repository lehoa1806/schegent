export const SCHEMA_VERSION = 3 as const;

export type BackendRunnerKind = 'claude' | 'codex' | 'agy';

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
  readonly lastResult: 'clean' | 'ambiguities-remain' | 'issues-remain' | null;
  readonly elapsedMs: number;
  readonly subProgress: SubProgress | null;
  /**
   * Feature 061 — operator-configured display name from `PhaseDef.name`.
   * Purely cosmetic; MUST NOT be used as a lookup key. When undefined or
   * empty, consumers fall back to `formatPhaseLabel(tile.name)`.
   */
  readonly displayName?: string;
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
  | 'wake-up-runner'
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
  readonly command?: string;
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

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface PhaseDefinition {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly runner?: BackendRunnerKind;
}

export interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
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
  readonly rulesInjectPerPhase: boolean;
  readonly defaultPipelineId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly queueGlobalConcurrencyCap: number;
  readonly queueDefaultQueueId: string;
  readonly runtimeLogLevel: RuntimeLogLevel;
  readonly runtimeLogFilePath: string;
  readonly retryMaxAttempts: number;
  readonly runtimeLogMaxBytes: number;
  readonly runtimeLogMaxGenerations: number;
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationTimeoutSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly rulesInjectPerPhase: SettingScope;
    readonly defaultPipelineId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly queueGlobalConcurrencyCap: SettingScope;
    readonly queueDefaultQueueId: SettingScope;
    readonly runtimeLogLevel: SettingScope;
    readonly runtimeLogFilePath: SettingScope;
    readonly retryMaxAttempts: SettingScope;
    readonly runtimeLogMaxBytes: SettingScope;
    readonly runtimeLogMaxGenerations: SettingScope;
    readonly sessionRetentionMaxAgeDays: SettingScope;
    readonly sessionRetentionMaxBytes: SettingScope;
  };
}

export const IDLE_GENERAL_SETTINGS: GeneralSettings = Object.freeze({
  cliPath: 'claude',
  loggingVerbose: false,
  loopMaxIterations: 10,
  invocationTimeoutSeconds: 1800,
  watchdogPollIntervalMinutes: 30,
  auditRotationSizeMB: 5,
  auditRotationMaxAgeDays: 30,
  rulesInjectPerPhase: false,
  // Feature 056 Track 3 (FR-013) — host default and package
  // contribution default both point at the built-in
  // `dev-new-feature` pipeline; the webview idle snapshot must
  // agree so a fresh workspace shows a consistent value before the
  // first projection lands.
  defaultPipelineId: 'dev-new-feature',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  queueGlobalConcurrencyCap: 1,
  queueDefaultQueueId: 'default',
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  retryMaxAttempts: 5,
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  sessionRetentionMaxBytes: 512 * 1024 * 1024,
  scopes: Object.freeze({
    cliPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationTimeoutSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    rulesInjectPerPhase: 'default',
    defaultPipelineId: 'default',
    fatalSignatures: 'default',
    claudeAutoCompactPctOverride: 'default',
    queueGlobalConcurrencyCap: 'default',
    queueDefaultQueueId: 'default',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    retryMaxAttempts: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default'
  })
});

/**
 * Feature 014 (BUG-001 / BUG-002) — webview mirror of `WakeUpSettings`
 * in src/wakeup/settings.ts. Settings live at Global (user) scope and
 * are projected onto the snapshot so the Wake up Settings tab can
 * hydrate its draft on mount and resync on projection changes
 * (FR-025 / SC-010), paralleling `GeneralSettings`.
 */
export type WakeUpSchedulerType = 'chronological' | 'periodic';

/**
 * Feature 031 — webview mirror of the closed Claude-model registry in
 * `src/wakeup/settings.ts`. Kept as a local constant on the webview
 * side because the bundle cannot import host source.
 */
export const RUNNER_DEFAULT_MODEL = 'runner-default' as const;

export const WAKEUP_SUPPORTED_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-6'
] as const;

export type WakeUpModelId = (typeof WAKEUP_SUPPORTED_MODELS)[number];

export type WakeUpModelSelection = typeof RUNNER_DEFAULT_MODEL | WakeUpModelId;

export interface WakeUpSettings {
  readonly enabled: boolean;
  readonly schedulerType: WakeUpSchedulerType;
  readonly chronologicalTime: string;
  readonly periodicInterval: string;
  /**
   * Feature 031 — operator's Claude model selection for OS-scheduled
   * Wake-up fires. Optional on the webview mirror for legacy-tolerance;
   * absent values default to the `'runner-default'` sentinel.
   */
  readonly model?: WakeUpModelSelection;
}

export type WakeUpAttemptStatus = 'succeeded' | 'failed' | 'timed-out' | 'skipped';
export type WakeUpTriggerSource = 'scheduled' | 'manual';

export interface WakeUpLogProjectionEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly triggerSource: WakeUpTriggerSource;
  readonly status: WakeUpAttemptStatus;
  readonly durationMs: number | null;
  readonly rawResponse: string;
  readonly message: string;
  readonly truncated: boolean;
  /**
   * Feature 031 — operator's verbatim selection from the persisted
   * mirror at fire time. Absent on legacy 014/024 records; the UI
   * falls back to `'runner-default'` semantics.
   */
  readonly requestedModel?: string;
  /**
   * Feature 031 — model the runner actually invoked. Equals
   * `requestedModel` for known models; equals `'runner-default'` when
   * the requested id was unknown to the runner (the legacy-tolerant
   * fallback).
   */
  readonly actualModel?: string;
  /**
   * Feature 031 T040 — invocation correlation id used as the key for
   * the wake-up session-log IPC when the operator expands the row.
   * Absent on legacy 014/024 records; the UI hides the expansion
   * affordance for rows without an id.
   */
  readonly correlationId?: string;
}

export interface WakeUpLogProjection {
  readonly entries: readonly WakeUpLogProjectionEntry[];
  readonly readError?: string;
}

export const IDLE_WAKEUP_SETTINGS: WakeUpSettings = Object.freeze({
  enabled: false,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h',
  model: RUNNER_DEFAULT_MODEL
});

export const IDLE_WAKEUP_LOG: WakeUpLogProjection = Object.freeze({
  entries: Object.freeze([]) as readonly WakeUpLogProjectionEntry[]
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

export interface WorkflowSnapshot {
  readonly schemaVersion: 3;
  readonly isPrimary: boolean;
  readonly status: WorkflowStatus;
  readonly activeFeature: ActiveFeatureSummary | null;
  readonly phases: readonly PhaseTile[];
  readonly queue: QueueProjection;
  readonly phaseOverrides?: readonly {
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }[];
  readonly manualPauseAt?: string | null;
  readonly manualPauseCause?:
    | 'operator-paused'
    | 'queue-paused-mid-run'
    | 'breakpoint-paused'
    | null;
  /**
   * Feature 028 — per-run future-phase breakpoints projected for the UI.
   * Optional for legacy-tolerance: older host bundles do not include it.
   * Defaults to an empty array when absent.
   */
  readonly phaseBreakpoints?: readonly {
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  }[];
  /**
   * Feature 028 — id of the phase that fired the breakpoint, non-null
   * iff `manualPauseCause === 'breakpoint-paused'`. Optional for
   * legacy-tolerance.
   */
  readonly resumeTargetPhaseId?: string | null;
  /**
   * Feature 028 — id of the active `WorkflowRun` (distinct from
   * `activeFeature.id`, which is the queue/task id). Optional for
   * legacy-tolerance; required for breakpoint IPC targeting.
   */
  readonly activeRunId?: string | null;
  /** Effective host default; absent only when paired with a legacy host. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly debugLogTail?: readonly DebugLogEntry[];
  readonly liveActivity: LiveActivity;
  readonly workflowElapsedMs: number | null;
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly activePipeline?: ActivePipelineSummary;
  readonly availablePipelines: readonly PipelineDefinition[];
  readonly availablePhases: readonly PhaseDefinition[];
  readonly availableModels: readonly string[];
  /**
   * Feature 011 — delayed-retry state on the active run. Optional for
   * legacy-tolerance: an older host bundle may not include it; the
   * webview must default to `IDLE_DELAYED_RETRY` in that case.
   */
  readonly delayedRetry?: DelayedRetryState;
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
   * Feature 014 (BUG-001 / BUG-002) — typed read of the four
   * `schegent.wakeUp.*` settings projected from Global scope. Optional
   * for legacy-tolerance: an older host bundle may not include it; the
   * webview must default to `IDLE_WAKEUP_SETTINGS` in that case.
   */
  readonly wakeUpSettings?: WakeUpSettings;
  /**
   * Feature 024 — latest sanitized Wake up attempt rows for the
   * Settings Wake up tab. Optional for legacy-tolerance.
   */
  readonly wakeUpLog?: WakeUpLogProjection;
  /**
   * Feature 031 / data-model §7 — DISPLAY-ONLY wake-up surface. The
   * webview NEVER routes `sessionLogPath` back to the host; the
   * session-log read IPC carries `correlationId` only. Optional for
   * legacy-tolerance — an older host bundle may not include it.
   */
  readonly wakeUp?: {
    readonly model: WakeUpModelSelection;
    readonly sessionLogPath: string;
  };
  /**
   * Feature 026 — per-phase precedence projection. Flat map keyed by
   * `"<phaseId>::<fieldKey>"` whose value is the layer that provided
   * the effective value (`'workspace' | 'user' | 'built-in' | 'unset'`).
   * Optional for legacy-tolerance and absent when the host has not
   * recomputed it yet.
   */
  readonly phasePrecedence?: PhasePrecedenceProjection;
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
