import type { SanitizedLogger } from '../../../lib/logger';
import type { AuditEventType } from '../../../contracts/audit-events';
import type {
  CommandAckMessage,
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
    pauseSource?: 'operator' | 'cascade' | 'retry-cap'
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
  reorderTaskInUnifiedQueue?(
    taskId: string,
    newPosition: number
  ): Promise<{
    outcome: 'success' | 'rejected';
    cause?: 'task-not-pending' | 'invalid-position' | 'no-op';
    fromPosition: number;
    toPosition: number;
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
}

export type AckPoster = (msg: CommandAckMessage) => Thenable<boolean> | Promise<boolean>;
