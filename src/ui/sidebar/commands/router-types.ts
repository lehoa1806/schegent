import type { SanitizedLogger } from '../../../lib/logger';
import type { AuditEventType } from '../../../contracts/audit-events';
import type { BackendPingService } from '../../../services/backend-ping-service';
import type {
  CommandAckMessage,
  ReadMetricsRequest,
  ReadMetricsResponse,
  ReadPhaseLogRequest,
  ReadPhaseLogResponse,
  ReadWakeupSessionLogResponse,
  RevealWakeupSessionLogResponse,
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
  readonly updateConfig?: (key: 'phases' | 'pipelines' | 'models', value: unknown) => Promise<void>;
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
  readonly saveWakeUpSettings?: (
    payload: Readonly<{
      enabled: boolean;
      schedulerType: 'chronological' | 'periodic';
      chronologicalTime: string;
      periodicInterval: string;
    }>
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly wakeUpNow?: () => Promise<import('../messages').WakeUpNowResult>;
  readonly onWakeUpNowComplete?: () => void;
  readonly phaseLogService?: {
    read(req: ReadPhaseLogRequest): Promise<ReadPhaseLogResponse>;
  };
  readonly phaseLogTailService?: {
    start(req: StartPhaseLogTailRequest): Promise<StartPhaseLogTailResponse>;
    stop(req: StopPhaseLogTailRequest): Promise<StopPhaseLogTailResponse>;
  };
  readonly wakeupSessionLogService?: {
    read(req: { correlationId: string }): Promise<ReadWakeupSessionLogResponse>;
  };
  readonly revealWakeupSessionLog?: () => Promise<RevealWakeupSessionLogResponse>;
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
