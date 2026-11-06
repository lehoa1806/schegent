// Per-consumer snapshot transport with monotonic revisions, unchanged-slice
// suppression on routine updates, and deterministic full-resync recovery (FR-R5-F12).

import {
  SUPPRESSIBLE_SNAPSHOT_SLICES,
  type SnapshotSyncMeta,
  type SuppressibleSnapshotSlice
} from '../../contracts/snapshot-bounds';
import { STATE_SNAPSHOT, type StateSnapshotMessage } from './messages';
import type { WorkflowSnapshot } from './snapshot';

export interface PreparedSnapshotPost<TSnapshot = unknown> {
  readonly message: StateSnapshotMessage<TSnapshot>;
  readonly sync: SnapshotSyncMeta;
  readonly markFailed: () => void;
}

function isV4Snapshot(value: unknown): value is WorkflowSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { schemaVersion?: unknown; queues?: unknown };
  return candidate.schemaVersion === 4 && Array.isArray(candidate.queues);
}

/**
 * Fast slice equality check: reference identity first, then length/element check
 * for arrays or JSON comparison for bounded catalog/tail slices.
 */
export function areSnapshotSlicesEqual(
  slice: SuppressibleSnapshotSlice,
  prev: unknown,
  next: unknown
): boolean {
  if (prev === next) return true;
  if (prev === undefined || next === undefined || prev === null || next === null) {
    return false;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return false;
    if (prev.length === 0) return true;
    // Fast element reference check
    let allRefEqual = true;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i] !== next[i]) {
        allRefEqual = false;
        break;
      }
    }
    if (allRefEqual) return true;
    // For history, check head/tail runId + completedAt + catalogVersion before full stringify
    if (slice === 'history') {
      const prevFirst = prev[0] as { runId?: unknown; completedAt?: unknown } | undefined;
      const nextFirst = next[0] as { runId?: unknown; completedAt?: unknown } | undefined;
      const prevLast = prev[prev.length - 1] as { runId?: unknown; completedAt?: unknown } | undefined;
      const nextLast = next[next.length - 1] as { runId?: unknown; completedAt?: unknown } | undefined;
      if (
        prevFirst?.runId !== nextFirst?.runId ||
        prevFirst?.completedAt !== nextFirst?.completedAt ||
        prevLast?.runId !== nextLast?.runId ||
        prevLast?.completedAt !== nextLast?.completedAt
      ) {
        return false;
      }
    }
  }
  return JSON.stringify(prev) === JSON.stringify(next);
}

function omitSlices(
  snapshot: WorkflowSnapshot,
  omitted: readonly SuppressibleSnapshotSlice[]
): Partial<WorkflowSnapshot> {
  const clone: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) };
  for (const slice of omitted) {
    delete clone[slice];
  }
  return Object.freeze(clone) as unknown as Partial<WorkflowSnapshot>;
}

export class SnapshotTransport {
  private nextRevision = 1;
  private baselineSnapshot: WorkflowSnapshot | null = null;
  private baselineRevision: number | null = null;
  private forceFull = true;

  /**
   * Forces the next snapshot post to be `mode: 'full'` while keeping revision
   * numbers strictly monotonic across the consumer's lifetime.
   */
  public forceFullResync(): void {
    this.forceFull = true;
  }

  /**
   * Resets baseline tracking (e.g., when a webview is disposed or replaced).
   * Keeps `nextRevision` monotonic so any stale in-flight message can never
   * reuse a revision number.
   */
  public reset(): void {
    this.baselineSnapshot = null;
    this.baselineRevision = null;
    this.forceFull = true;
  }

  public get lastRevision(): number | null {
    return this.baselineRevision;
  }

  public preparePost<TSnapshot = unknown>(
    snapshot: TSnapshot
  ): PreparedSnapshotPost<TSnapshot> {
    const revision = this.nextRevision++;

    if (!isV4Snapshot(snapshot)) {
      const sync: SnapshotSyncMeta = Object.freeze({ mode: 'full', revision });
      return {
        message: { type: STATE_SNAPSHOT, payload: snapshot, sync },
        sync,
        markFailed: () => {
          this.forceFull = true;
        }
      };
    }

    const base = this.baselineSnapshot;
    const baseRev = this.baselineRevision;
    if (this.forceFull || base === null || baseRev === null) {
      this.baselineSnapshot = snapshot;
      this.baselineRevision = revision;
      this.forceFull = false;
      const sync: SnapshotSyncMeta = Object.freeze({ mode: 'full', revision });
      return {
        message: { type: STATE_SNAPSHOT, payload: snapshot, sync },
        sync,
        markFailed: () => {
          this.forceFull = true;
        }
      };
    }

    const omittedSlices: SuppressibleSnapshotSlice[] = [];
    const baseRecord = base as unknown as Record<string, unknown>;
    const nextRecord = snapshot as unknown as Record<string, unknown>;
    for (const slice of SUPPRESSIBLE_SNAPSHOT_SLICES) {
      if (areSnapshotSlicesEqual(slice, baseRecord[slice], nextRecord[slice])) {
        omittedSlices.push(slice);
      }
    }

    this.baselineSnapshot = snapshot;
    this.baselineRevision = revision;

    if (omittedSlices.length === 0) {
      const sync: SnapshotSyncMeta = Object.freeze({ mode: 'full', revision });
      return {
        message: { type: STATE_SNAPSHOT, payload: snapshot, sync },
        sync,
        markFailed: () => {
          this.forceFull = true;
        }
      };
    }

    const frozenOmitted = Object.freeze(omittedSlices);
    const sync: SnapshotSyncMeta = Object.freeze({
      mode: 'routine',
      revision,
      baseRevision: baseRev,
      omittedSlices: frozenOmitted
    });
    const wirePayload = omitSlices(snapshot, frozenOmitted) as unknown as TSnapshot;

    return {
      message: {
        type: STATE_SNAPSHOT,
        payload: wirePayload,
        sync
      },
      sync,
      markFailed: () => {
        this.forceFull = true;
      }
    };
  }
}

