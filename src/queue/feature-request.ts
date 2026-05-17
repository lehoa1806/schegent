export type FeatureRequestStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

export interface FeatureRequestFailure {
  readonly code?: string;
  readonly message: string;
  readonly phase?: string;
  readonly correlationId?: string;
}

export type FeatureRequestRerunReason = 'manual' | 'retry-active' | 'auto-drain';

export type FeatureRequestPauseCause = 'phase-paused' | 'manually-paused-task';

export interface FeatureRequestRerun {
  readonly originalRunId: string;
  readonly originalDescription: string;
  readonly reason: FeatureRequestRerunReason;
}

export interface FeatureRequest {
  id: string;
  description: string;
  enqueuedAt: number;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  status: FeatureRequestStatus;
  queueId?: string;
  position: number;
  pauseCause?: FeatureRequestPauseCause | null;
  runId: string | null;
  retryCount: number;
  lastError: FeatureRequestFailure | string | null;
  pausedReason: string | null;
  pipelineId?: string;
  rerun?: FeatureRequestRerun;
}

export interface QueueState {
  requests: FeatureRequest[];
  inFlightId: string | null;
  paused: boolean;
  pausedReason: string | null;
  updatedAt: number;
}

export const MAX_DESCRIPTION_LENGTH = 32_000;
export const MAX_PENDING_TASKS_PER_QUEUE = 100;

export function validateDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error('Feature description must be non-empty');
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Feature description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return trimmed;
}

export function ensureExtendedFeatureRequest(raw: Partial<FeatureRequest> & { id: string; description: string; enqueuedAt: number; status: FeatureRequestStatus; position: number; runId: string | null }): FeatureRequest {
  return {
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    queueId: 'default',
    pauseCause: null,
    startedAt: null,
    completedAt: null,
    createdAt: raw.enqueuedAt,
    updatedAt: raw.enqueuedAt,
    ...raw
  };
}
