export const QUEUE_STATUS = [
  'pending',
  'in-flight',
  'completed',
  'failed',
  'cancelled'
] as const;

export type QueueStatus = (typeof QUEUE_STATUS)[number];

export interface SanitizedFailureMetadata {
  readonly code?: string;
  readonly message: string;
  readonly phase?: string;
  readonly correlationId: string;
}

export interface QueueItemSnapshot {
  readonly id: string;
  readonly correlationId: string;
  readonly description: string;
  readonly status: QueueStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: SanitizedFailureMetadata;
  readonly pausedReason?: string;
  readonly queueId?: string;
  readonly position?: number;
  // Feature 028 — `'breakpoint'` is added to the projection union for
  // tasks whose run is paused with `manualPauseCause === 'breakpoint-paused'`.
  // `'queue-paused'` stays a UI-only projection (never persisted).
  readonly pauseCause?:
    | 'queue-paused'
    | 'phase-paused'
    | 'manually-paused-task'
    | 'breakpoint'
    | null;
}

export interface QueuePauseState {
  readonly paused: boolean;
  readonly reason?: string;
}

export interface QueueSnapshot {
  readonly items: readonly QueueItemSnapshot[];
  readonly queues?: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly state: 'active' | 'manually-paused';
    readonly schedule: {
      readonly expression: string;
      readonly kind: 'relative' | 'absolute';
      readonly targetAt: string;
    } | null;
    readonly taskCount: number;
    // Feature 028 — distinguishes operator-initiated queue pauses from
    // those induced by an active-phase pause / breakpoint fire. Feature
    // 030 BUG-001 adds `'retry-cap'` to label retry-handler pauses
    // triggered when the delayed-retry budget is exhausted. `null` iff
    // `state !== 'manually-paused'`. UI uses this to label the queue
    // badge as "cascaded" / "retry-cap" vs the existing manual indicator.
    readonly pauseSource?: 'operator' | 'cascade' | 'retry-cap' | null;
  }[];
  readonly pauseState: QueuePauseState;
  readonly updatedAt: string;
}

export function isQueueStatus(value: unknown): value is QueueStatus {
  return typeof value === 'string' && (QUEUE_STATUS as readonly string[]).includes(value);
}
