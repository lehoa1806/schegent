// Explicit snapshot byte budgets, history cardinality bounds, and per-consumer
// slice-suppression / resync synchronization contract (FR-R5-F12).

/**
 * Maximum serialized UTF-8 byte size for a routine `STATE_SNAPSHOT` message
 * delivered to a continuously visible consumer under the representative
 * `large-history` workload (512 KiB).
 */
export const ROUTINE_SNAPSHOT_BYTE_BUDGET = 524_288 as const;

/**
 * Maximum serialized UTF-8 byte size for a complete `mode: 'full'` initial or
 * resync `STATE_SNAPSHOT` under the F09-bounded 40-partition (`2,000`-entry)
 * `large-history` workload (1 MiB ceiling; measured ~780 KiB).
 */
export const FULL_RESYNC_SNAPSHOT_BYTE_CEILING = 1_048_576 as const;

/**
 * Maximum retained history partitions across the workspace (`MAX_QUEUES = 20`
 * live queues + `MAX_DELETED_HISTORY_PARTITIONS = 20` deleted-queue partitions).
 */
export const MAX_RETAINED_HISTORY_PARTITIONS = 40 as const;

/**
 * Maximum retained history entries across all partitions (`40 * 50 = 2,000`).
 */
export const MAX_RETAINED_HISTORY_ENTRIES = 2_000 as const;

/**
 * Top-level `WorkflowSnapshot` slices eligible for omission on `mode: 'routine'`
 * updates when their value is unchanged since the consumer's `baseRevision`.
 */
export const SUPPRESSIBLE_SNAPSHOT_SLICES = [
  'history',
  'phaseCatalog',
  'pipelineCatalog',
  'workflowCatalog',
  'availablePhases',
  'availablePipelines',
  'auditTail',
  'debugLogTail'
] as const;

export type SuppressibleSnapshotSlice = (typeof SUPPRESSIBLE_SNAPSHOT_SLICES)[number];

/**
 * Synchronization metadata carried alongside `STATE_SNAPSHOT`.
 *
 * - `mode: 'full'` delivers every slice and resets the consumer's baseline to `revision`.
 * - `mode: 'routine'` requires the consumer to hold `baseRevision` and reconstructs
 *   any slice named in `omittedSlices` from that baseline.
 */
export interface SnapshotSyncMeta {
  readonly mode: 'full' | 'routine';
  readonly revision: number;
  readonly baseRevision?: number;
  readonly omittedSlices?: readonly SuppressibleSnapshotSlice[];
}

/**
 * Transport-level control frame sent from a webview consumer to its owning
 * `SidebarViewProvider` or `DashboardPanel` when a `mode: 'routine'` update
 * arrives with a missing or mismatched `baseRevision`.
 */
export const SNAPSHOT_RESYNC_REQUEST = 'SNAPSHOT_RESYNC_REQUEST' as const;

export interface SnapshotResyncRequestMessage {
  readonly type: typeof SNAPSHOT_RESYNC_REQUEST;
  readonly lastRevision: number | null;
}

export function isSnapshotResyncRequest(
  value: unknown
): value is SnapshotResyncRequestMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { type?: unknown; lastRevision?: unknown };
  if (candidate.type !== SNAPSHOT_RESYNC_REQUEST) {
    return false;
  }
  return (
    candidate.lastRevision === null ||
    candidate.lastRevision === undefined ||
    (typeof candidate.lastRevision === 'number' && Number.isInteger(candidate.lastRevision))
  );
}
