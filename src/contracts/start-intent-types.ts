// Feature 065 — Start-mode discriminator types and validators, hosted
// here so the main sidebar-ipc.ts module stays within its LOC budget.
// The IPC types remain logically part of the sidebar contract but are
// re-exported from sidebar-ipc.ts; consumers should keep importing
// from sidebar-ipc.ts for stability.
//
// `'cancel-schedule'` is valid only on CMD_START_QUEUE (FR-015). See
// specs/065-enqueue-start-separation/contracts/sidebar-ipc.diff.md.

export type StartMode = 'now' | 'scheduled' | 'cancel-schedule';

// ScheduledStartSource literal (re-declared here to keep the IPC
// contract self-contained; mirrors
// repo/src/queue/feature-request.ts::ScheduledStartSource).
export type IpcScheduledStartSource =
  | 'operator-chooser'
  | 'operator-restart'
  | 'wake-up-runner'
  | 'programmatic-now'
  | 'programmatic-scheduled'
  | 'migration-default';

// Optional `startIntent` payload accompanying CMD_START. The host's
// policy table treats omission as the human-facing chooser default
// (or the warn-level automation default for non-human callers).
export interface EnqueueStartIntent {
  readonly startMode: 'now' | 'scheduled';
  readonly scheduledStartAt?: number;
  readonly source: IpcScheduledStartSource;
}

// Optional `startIntent` payload accompanying CMD_START_QUEUE. Supports
// the cancel-schedule affordance (FR-015) and the change-schedule path
// (T042); the source literal is always `'operator-restart'`.
export interface StartQueueIntent {
  readonly startMode: StartMode;
  readonly scheduledStartAt?: number;
  readonly source: 'operator-restart';
}

export function isValidEnqueueStartIntent(value: unknown): value is EnqueueStartIntent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { startMode?: unknown; scheduledStartAt?: unknown; source?: unknown };
  if (v.startMode !== 'now' && v.startMode !== 'scheduled') return false;
  if (v.startMode === 'scheduled') {
    if (
      typeof v.scheduledStartAt !== 'number' ||
      !Number.isFinite(v.scheduledStartAt) ||
      v.scheduledStartAt <= 0
    ) {
      return false;
    }
  } else if (v.scheduledStartAt !== undefined) {
    return false;
  }
  return (
    v.source === 'operator-chooser' ||
    v.source === 'operator-restart' ||
    v.source === 'wake-up-runner' ||
    v.source === 'programmatic-now' ||
    v.source === 'programmatic-scheduled' ||
    v.source === 'migration-default'
  );
}

export function isValidStartQueueIntent(value: unknown): value is StartQueueIntent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { startMode?: unknown; scheduledStartAt?: unknown; source?: unknown };
  if (v.startMode !== 'now' && v.startMode !== 'scheduled' && v.startMode !== 'cancel-schedule') {
    return false;
  }
  if (v.startMode === 'scheduled') {
    if (
      typeof v.scheduledStartAt !== 'number' ||
      !Number.isFinite(v.scheduledStartAt) ||
      v.scheduledStartAt <= 0
    ) {
      return false;
    }
  } else if (v.scheduledStartAt !== undefined) {
    return false;
  }
  return v.source === 'operator-restart';
}
