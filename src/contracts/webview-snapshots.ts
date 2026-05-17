import type { AuditEntry } from '../audit/audit-entry';
import type { MonitorSnapshot } from './monitor-events';
import type { QueueSnapshot, QueuePauseState } from './queue-snapshot';

export const SNAP_QUEUE = 'SNAP_QUEUE' as const;
export const SNAP_ACTIVE_RUN = 'SNAP_ACTIVE_RUN' as const;
export const SNAP_HISTORY = 'SNAP_HISTORY' as const;
export const SNAP_AUDIT_TAIL = 'SNAP_AUDIT_TAIL' as const;
export const SNAP_MONITOR = 'SNAP_MONITOR' as const;
export const SNAP_PAUSE_STATE = 'SNAP_PAUSE_STATE' as const;
export const SNAP_HYDRATION = 'SNAP_HYDRATION' as const;

export interface ActiveRunPayload {
  readonly correlationId: string;
  readonly queueItemId: string;
  readonly currentPhase: string;
  readonly startedAt: string;
  readonly phaseOverrides?: ReadonlyArray<{
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }>;
  readonly manualPauseAt?: string | null;
  // Feature 028 — extends union with `'breakpoint-paused'` for future-phase
  // breakpoint fires. UI distinguishes active-pause from breakpoint-paused.
  readonly manualPauseCause?:
    | 'operator-paused'
    | 'queue-paused-mid-run'
    | 'breakpoint-paused'
    | null;
  readonly phaseMessages?: ReadonlyArray<PhaseMessageMetadataSnapshot>;
}

export type QueueRegistryStateSnapshot = 'active' | 'manually-paused';

export interface QueueScheduleSnapshot {
  readonly expression: string;
  readonly kind: 'relative' | 'absolute';
  readonly targetAt: string;
}

export interface QueueRegistryEntrySnapshot {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly state: QueueRegistryStateSnapshot;
  readonly schedule: QueueScheduleSnapshot | null;
  readonly taskCount: number;
}

export interface PhaseMessageMetadataSnapshot {
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly entryCount: number;
  readonly byteSize: number;
  readonly status: 'emitted' | 'truncated' | 'invalid';
  readonly reason?: string;
}

export interface HistoryEntryPayload {
  readonly correlationId: string;
  readonly queueItemId: string;
  readonly summary: string;
  readonly terminalStatus: 'completed' | 'failed' | 'cancelled';
  readonly completedAt: string;
}

export interface SnapQueue {
  readonly type: typeof SNAP_QUEUE;
  readonly snapshot: QueueSnapshot;
}
export interface SnapActiveRun {
  readonly type: typeof SNAP_ACTIVE_RUN;
  readonly snapshot: ActiveRunPayload | null;
}
export interface SnapHistory {
  readonly type: typeof SNAP_HISTORY;
  readonly entries: readonly HistoryEntryPayload[];
}
export interface SnapAuditTail {
  readonly type: typeof SNAP_AUDIT_TAIL;
  readonly entries: readonly AuditEntry[];
}
export interface SnapMonitor {
  readonly type: typeof SNAP_MONITOR;
  readonly snapshot: MonitorSnapshot | null;
}
export interface SnapPauseState {
  readonly type: typeof SNAP_PAUSE_STATE;
  readonly pauseState: QueuePauseState;
}
export interface SnapHydration {
  readonly type: typeof SNAP_HYDRATION;
  readonly warnings: readonly string[];
}

export type WebviewSnapshot =
  | SnapQueue
  | SnapActiveRun
  | SnapHistory
  | SnapAuditTail
  | SnapMonitor
  | SnapPauseState
  | SnapHydration;
